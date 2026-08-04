import { isDeepStrictEqual } from "node:util";
import {
  compareModelAcknowledgements,
  compareModelMutations,
  MODEL_NOTHING_FOLDED,
  type ModelAckObject,
  type ModelLogObject,
  type ModelManifestObject,
  type ModelMutation,
  type ModelObject,
  type ModelRunObject,
  type ModelStore,
  type ModelWarmCache,
} from "./types.ts";

export type ModelLogicalView = ReadonlyMap<string, number>;

export interface ModelReconstruction {
  readonly view: ModelLogicalView;
  readonly cache: ModelWarmCache;
  readonly findings: readonly string[];
}

function replayModelReferenceLedger(ledger: readonly ModelMutation[]): ModelLogicalView {
  const view = new Map<string, number>();
  const seenMutationIds = new Set<string>();
  const orderedLedger = [...ledger].toSorted(compareModelMutations);
  for (const mutation of orderedLedger) {
    if (seenMutationIds.has(mutation.mutationId)) {
      continue;
    }
    seenMutationIds.add(mutation.mutationId);
    if (mutation.change.kind === "put") {
      view.set(mutation.documentId, mutation.change.value);
    } else {
      view.delete(mutation.documentId);
    }
  }
  return view;
}

export const reconstructModelReference = (ledger: readonly ModelMutation[]): ModelLogicalView =>
  replayModelReferenceLedger(ledger);

function collectModelReconstructionMutations(
  mutations: readonly ModelMutation[],
): readonly ModelMutation[] {
  const collected: ModelMutation[] = [];
  const seenMutationIds = new Set<string>();
  for (const mutation of [...mutations].toSorted(compareModelMutations)) {
    if (seenMutationIds.has(mutation.mutationId)) {
      continue;
    }
    seenMutationIds.add(mutation.mutationId);
    collected.push(mutation);
  }
  return collected;
}

function materializeModelReconstruction(
  store: ModelStore,
  mutations: readonly ModelMutation[],
  findings: Set<string>,
): ModelLogicalView {
  const latestByDocument = new Map<string, ModelMutation>();
  for (const mutation of mutations) {
    latestByDocument.set(mutation.documentId, mutation);
  }

  const view = new Map<string, number>();
  for (const mutation of [...latestByDocument.values()].toSorted(compareModelMutations)) {
    if (mutation.change.kind === "delete") {
      continue;
    }
    const contentKey = `content/${mutation.mutationId}`;
    const content = store.objects.get(contentKey);
    if (content === undefined) {
      findings.add("missing-reachable-content");
      continue;
    }
    if (
      content.kind !== "content" ||
      content.key !== contentKey ||
      content.documentId !== mutation.documentId ||
      content.value !== mutation.change.value
    ) {
      findings.add("malformed-reachable-content");
      continue;
    }
    view.set(mutation.documentId, mutation.change.value);
  }
  return view;
}

function currentModelManifest(
  store: ModelStore,
  findings: Set<string>,
): ModelManifestObject | null {
  const manifestKey = store.root.manifestKey;
  if (manifestKey === null) {
    return null;
  }
  const object = store.objects.get(manifestKey);
  if (object === undefined) {
    findings.add("missing-reachable-manifest");
    return null;
  }
  if (object.kind !== "manifest") {
    findings.add("malformed-reachable-manifest");
    return null;
  }
  if (
    object.key !== manifestKey ||
    object.generation !== store.root.generation ||
    !Number.isInteger(object.foldedThrough) ||
    !Array.isArray(object.levels) ||
    !object.levels.every(
      (level) =>
        typeof level === "object" &&
        level !== null &&
        Number.isInteger(level.level) &&
        Array.isArray(level.runKeys) &&
        level.runKeys.every((runKey: unknown) => typeof runKey === "string"),
    )
  ) {
    findings.add("malformed-reachable-manifest");
    return null;
  }
  return object;
}

function isModelMutation(value: unknown): value is ModelMutation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const mutation = value as Partial<ModelMutation>;
  if (
    typeof mutation.mutationId !== "string" ||
    !Number.isInteger(mutation.sequence) ||
    typeof mutation.documentId !== "string" ||
    typeof mutation.change !== "object" ||
    mutation.change === null
  ) {
    return false;
  }
  return (
    mutation.change.kind === "delete" ||
    (mutation.change.kind === "put" && typeof mutation.change.value === "number")
  );
}

export function isCanonicalModelSuffixAcknowledgement(acknowledgement: ModelAckObject): boolean {
  return (
    Number.isInteger(acknowledgement.sequence) &&
    acknowledgement.key === `ack/${acknowledgement.sequence}` &&
    typeof acknowledgement.mutationId === "string"
  );
}

export function isCanonicalModelSuffixLog(
  acknowledgement: ModelAckObject,
  object: ModelObject,
): object is ModelLogObject {
  if (
    object.kind !== "log" ||
    object.key !== `log/${acknowledgement.sequence}` ||
    !isModelMutation(object.mutation) ||
    object.mutation.sequence !== acknowledgement.sequence ||
    object.mutation.mutationId !== acknowledgement.mutationId
  ) {
    return false;
  }
  const expectedContentKey =
    object.mutation.change.kind === "put" ? `content/${object.mutation.mutationId}` : null;
  return object.contentKey === expectedContentKey;
}

/**
 * Loads every run the manifest reaches, straight from the store.
 *
 * Takes no cache: a cold reconstruction is defined by reading nothing it did not
 * just fetch, and that is the whole difference between it and
 * {@link loadWarmModelRuns}. It still reports the runs it read as a cache so the
 * caller can warm one from a cold pass.
 */
function loadModelRuns(
  store: ModelStore,
  manifest: ModelManifestObject | null,
  findings: Set<string>,
): {
  readonly runs: readonly ModelRunObject[];
  readonly cacheRuns: ReadonlyMap<string, ModelRunObject>;
} {
  const runs: ModelRunObject[] = [];
  const cacheRuns = new Map<string, ModelRunObject>();
  if (manifest === null) {
    return { runs, cacheRuns };
  }

  const orderedLevels = [...manifest.levels].toSorted((left, right) => left.level - right.level);
  for (const level of orderedLevels) {
    if (!Number.isInteger(level.level) || !Array.isArray(level.runKeys)) {
      findings.add("malformed-reachable-manifest");
      continue;
    }
    for (const runKey of [...level.runKeys].toSorted()) {
      const stored = store.objects.get(runKey);
      if (stored === undefined) {
        findings.add("missing-reachable-run");
        continue;
      }
      if (
        stored.kind !== "run" ||
        stored.key !== runKey ||
        stored.level !== level.level ||
        stored.complete !== true ||
        !Array.isArray(stored.mutations) ||
        !stored.mutations.every(isModelMutation)
      ) {
        findings.add("malformed-reachable-run");
        continue;
      }
      runs.push(stored);
      cacheRuns.set(runKey, stored);
    }
  }
  return { runs, cacheRuns };
}

function acknowledgedModelSuffix(
  store: ModelStore,
  foldedThrough: number,
  findings: Set<string>,
): readonly ModelMutation[] {
  const mutations: ModelMutation[] = [];
  const acknowledgements: ModelAckObject[] = [];
  for (const object of store.objects.values()) {
    if (object.kind !== "ack") {
      continue;
    }
    if (!Number.isInteger(object.sequence)) {
      findings.add("malformed-reachable-ack");
      continue;
    }
    if (object.sequence <= foldedThrough) {
      continue;
    }
    if (!isCanonicalModelSuffixAcknowledgement(object)) {
      findings.add("malformed-reachable-ack");
      continue;
    }
    acknowledgements.push(object);
  }
  acknowledgements.sort(compareModelAcknowledgements);
  for (const acknowledgement of acknowledgements) {
    const log = store.objects.get(`log/${acknowledgement.sequence}`);
    if (log === undefined) {
      findings.add("missing-reachable-log");
      continue;
    }
    if (!isCanonicalModelSuffixLog(acknowledgement, log)) {
      findings.add("malformed-reachable-log");
      continue;
    }
    mutations.push(log.mutation);
  }
  return mutations;
}

export function reconstructModelCold(store: ModelStore): ModelReconstruction {
  const findings = new Set<string>();
  const manifest = currentModelManifest(store, findings);
  const loaded = loadModelRuns(store, manifest, findings);
  const foldedMutations = loaded.runs.flatMap(({ mutations }) => mutations);
  const suffix = acknowledgedModelSuffix(
    store,
    manifest?.foldedThrough ?? MODEL_NOTHING_FOLDED,
    findings,
  );
  const committedMutations = collectModelReconstructionMutations([...foldedMutations, ...suffix]);
  return {
    view: materializeModelReconstruction(store, committedMutations, findings),
    cache: { rootGeneration: store.root.generation, runs: loaded.cacheRuns },
    findings: [...findings],
  };
}

function currentWarmModelManifest(
  store: ModelStore,
  findings: Set<string>,
): ModelManifestObject | null {
  const manifestKey = store.root.manifestKey;
  if (manifestKey === null) {
    return null;
  }
  const candidate = store.objects.get(manifestKey);
  if (candidate === undefined) {
    findings.add("missing-reachable-manifest");
    return null;
  }
  if (candidate.kind !== "manifest") {
    findings.add("malformed-reachable-manifest");
    return null;
  }
  const levelsAreValid =
    Array.isArray(candidate.levels) &&
    candidate.levels.every(
      (level) =>
        typeof level === "object" &&
        level !== null &&
        Number.isInteger(level.level) &&
        Array.isArray(level.runKeys) &&
        level.runKeys.every((runKey: unknown) => typeof runKey === "string"),
    );
  if (
    candidate.key !== manifestKey ||
    candidate.generation !== store.root.generation ||
    !Number.isInteger(candidate.foldedThrough) ||
    !levelsAreValid
  ) {
    findings.add("malformed-reachable-manifest");
    return null;
  }
  return candidate;
}

function loadWarmModelRuns(
  store: ModelStore,
  manifest: ModelManifestObject | null,
  cache: ModelWarmCache,
  findings: Set<string>,
): {
  readonly mutations: readonly ModelMutation[];
  readonly runs: ReadonlyMap<string, ModelRunObject>;
} {
  const mutations: ModelMutation[] = [];
  const runs = new Map<string, ModelRunObject>();
  if (manifest === null) {
    return { mutations, runs };
  }
  const canReuse = cache.rootGeneration === store.root.generation;
  for (const level of [...manifest.levels].toSorted((left, right) => left.level - right.level)) {
    if (!Number.isInteger(level.level) || !Array.isArray(level.runKeys)) {
      findings.add("malformed-reachable-manifest");
      continue;
    }
    for (const runKey of [...level.runKeys].toSorted()) {
      const durable = store.objects.get(runKey);
      if (durable === undefined) {
        findings.add("missing-reachable-run");
        continue;
      }
      if (
        durable.kind !== "run" ||
        durable.key !== runKey ||
        durable.level !== level.level ||
        durable.complete !== true ||
        !Array.isArray(durable.mutations) ||
        !durable.mutations.every(isModelMutation)
      ) {
        findings.add("malformed-reachable-run");
        continue;
      }
      const cached = canReuse ? cache.runs.get(runKey) : undefined;
      const selected =
        cached !== undefined && isDeepStrictEqual(cached, durable) ? cached : durable;
      runs.set(runKey, selected);
      mutations.push(...selected.mutations);
    }
  }
  return { mutations, runs };
}

function collectWarmModelSuffix(
  store: ModelStore,
  foldedThrough: number,
  findings: Set<string>,
): readonly ModelMutation[] {
  const acknowledgements: ModelAckObject[] = [];
  for (const candidate of store.objects.values()) {
    if (candidate.kind !== "ack") {
      continue;
    }
    if (!Number.isInteger(candidate.sequence)) {
      findings.add("malformed-reachable-ack");
      continue;
    }
    if (candidate.sequence <= foldedThrough) {
      continue;
    }
    if (!isCanonicalModelSuffixAcknowledgement(candidate)) {
      findings.add("malformed-reachable-ack");
      continue;
    }
    acknowledgements.push(candidate);
  }
  const mutations: ModelMutation[] = [];
  for (const acknowledgement of acknowledgements.toSorted(compareModelAcknowledgements)) {
    const log = store.objects.get(`log/${acknowledgement.sequence}`);
    if (log === undefined) {
      findings.add("missing-reachable-log");
      continue;
    }
    if (!isCanonicalModelSuffixLog(acknowledgement, log)) {
      findings.add("malformed-reachable-log");
      continue;
    }
    mutations.push(log.mutation);
  }
  return mutations;
}

function replayWarmModelMutations(
  store: ModelStore,
  mutations: readonly ModelMutation[],
  findings: Set<string>,
): ModelLogicalView {
  const seen = new Set<string>();
  const latest = new Map<string, ModelMutation>();
  for (const mutation of [...mutations].toSorted(compareModelMutations)) {
    if (seen.has(mutation.mutationId)) {
      continue;
    }
    seen.add(mutation.mutationId);
    latest.set(mutation.documentId, mutation);
  }

  const view = new Map<string, number>();
  for (const mutation of [...latest.values()].toSorted(compareModelMutations)) {
    if (mutation.change.kind === "delete") {
      continue;
    }
    const contentKey = `content/${mutation.mutationId}`;
    const content = store.objects.get(contentKey);
    if (content === undefined) {
      findings.add("missing-reachable-content");
      continue;
    }
    if (
      content.kind !== "content" ||
      content.key !== contentKey ||
      content.documentId !== mutation.documentId ||
      content.value !== mutation.change.value
    ) {
      findings.add("malformed-reachable-content");
      continue;
    }
    view.set(mutation.documentId, mutation.change.value);
  }
  return view;
}

export function reconstructModelWarm(
  store: ModelStore,
  cache: ModelWarmCache,
): ModelReconstruction {
  const findings = new Set<string>();
  const manifest = currentWarmModelManifest(store, findings);
  const loaded = loadWarmModelRuns(store, manifest, cache, findings);
  const suffix = collectWarmModelSuffix(
    store,
    manifest?.foldedThrough ?? MODEL_NOTHING_FOLDED,
    findings,
  );
  return {
    view: replayWarmModelMutations(store, [...loaded.mutations, ...suffix], findings),
    cache: { rootGeneration: store.root.generation, runs: loaded.runs },
    findings: [...findings],
  };
}

export const equalModelViews = (left: ModelLogicalView, right: ModelLogicalView): boolean => {
  if (left.size !== right.size) {
    return false;
  }
  for (const [documentId, value] of left) {
    if (right.get(documentId) !== value) {
      return false;
    }
  }
  return true;
};
