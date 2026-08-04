import { isDeepStrictEqual } from "node:util";
import {
  compareModelMutations,
  MODEL_NOTHING_FOLDED,
  type ModelDurableEffect,
  type ModelDurableResult,
  type ModelDurableTraceEntry,
  type ModelMutation,
  type ModelStore,
} from "./types.ts";

export const emptyModelStore = (): ModelStore => ({
  objects: new Map(),
  root: { generation: 0, etag: "root-0", manifestKey: null },
  durableTrace: [],
});

function modelTraceEntry(
  store: ModelStore,
  effect: ModelDurableEffect,
  outcome: ModelDurableTraceEntry["outcome"],
): ModelDurableTraceEntry {
  const effectIndex = store.durableTrace.length;
  return {
    effectId: `direct/${effectIndex}`,
    operationId: "direct",
    effectIndex,
    effect,
    outcome,
  };
}

function withModelTrace(store: ModelStore, traceEntry: ModelDurableTraceEntry): ModelStore {
  return { ...store, durableTrace: [...store.durableTrace, traceEntry] };
}

function applyWithoutCrash(
  store: ModelStore,
  effect: ModelDurableEffect,
): { readonly store: ModelStore; readonly outcome: "applied" | "conflict" } {
  switch (effect.kind) {
    case "put-immutable": {
      const existing = store.objects.get(effect.object.key);
      if (existing !== undefined && !isDeepStrictEqual(existing, effect.object)) {
        return { store, outcome: "conflict" };
      }
      if (existing !== undefined) {
        return { store, outcome: "applied" };
      }
      const objects = new Map(store.objects);
      objects.set(effect.object.key, effect.object);
      return { store: { ...store, objects }, outcome: "applied" };
    }
    case "cas-root": {
      if (isDeepStrictEqual(store.root, effect.next)) {
        return { store, outcome: "applied" };
      }
      if (store.root.etag !== effect.expectedEtag) {
        return { store, outcome: "conflict" };
      }
      return { store: { ...store, root: effect.next }, outcome: "applied" };
    }
    case "delete-object": {
      const objects = new Map(store.objects);
      objects.delete(effect.key);
      return { store: { ...store, objects }, outcome: "applied" };
    }
  }
}

export const applyModelDurableEffect = (
  store: ModelStore,
  effect: ModelDurableEffect,
  crash: "before" | "after" | null,
): ModelDurableResult => {
  if (crash === "before") {
    const traceEntry = modelTraceEntry(store, effect, "crashed-before");
    return { store, outcome: "crashed-before", traceEntry };
  }

  const applied = applyWithoutCrash(store, effect);
  const outcome =
    crash === "after" && applied.outcome === "applied" ? "crashed-after" : applied.outcome;
  const traceEntry = modelTraceEntry(store, effect, outcome);
  return {
    store: withModelTrace(applied.store, traceEntry),
    outcome,
    traceEntry,
  };
};

export const reachableModelObjectKeys = (store: ModelStore): ReadonlySet<string> => {
  const reachable = new Set<string>();
  const committedMutations: ModelMutation[] = [];
  let foldedThrough: number = MODEL_NOTHING_FOLDED;
  const manifestKey = store.root.manifestKey;
  if (manifestKey !== null) {
    reachable.add(manifestKey);
    const manifest = store.objects.get(manifestKey);
    if (manifest?.kind === "manifest") {
      foldedThrough = manifest.foldedThrough;
      for (const level of manifest.levels) {
        for (const runKey of level.runKeys) {
          reachable.add(runKey);
          const run = store.objects.get(runKey);
          if (run?.kind === "run") {
            committedMutations.push(...run.mutations);
          }
        }
      }
    }
  }

  for (const object of store.objects.values()) {
    if (object.kind !== "ack" || object.sequence <= foldedThrough) {
      continue;
    }
    reachable.add(object.key);
    const logKey = `log/${object.sequence}`;
    reachable.add(logKey);
    const log = store.objects.get(logKey);
    if (
      log?.kind === "log" &&
      log.mutation.sequence === object.sequence &&
      log.mutation.mutationId === object.mutationId
    ) {
      committedMutations.push(log.mutation);
    }
  }

  const latestByDocument = new Map<string, ModelMutation>();
  const seenMutationIds = new Set<string>();
  for (const mutation of committedMutations.toSorted(compareModelMutations)) {
    if (seenMutationIds.has(mutation.mutationId)) {
      continue;
    }
    seenMutationIds.add(mutation.mutationId);
    latestByDocument.set(mutation.documentId, mutation);
  }
  for (const mutation of latestByDocument.values()) {
    if (mutation.change.kind === "put") {
      reachable.add(`content/${mutation.mutationId}`);
    }
  }

  return reachable;
};
