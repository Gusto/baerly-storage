import { reachableModelObjectKeys } from "./model-store.ts";
import type { ModelOperation, ModelState } from "./types.ts";

export const MODEL_REJECTED_ARMS = [
  "publish-incomplete-run",
  "merge-missing-run",
  "merge-level-overflow",
  "retry-without-crash",
  "reclaim-reachable-object",
] as const;

export type ModelRejectedArmId = (typeof MODEL_REJECTED_ARMS)[number];

export const classifyModelRejectedArm = (
  state: ModelState,
  operation: ModelOperation,
): ModelRejectedArmId | null => {
  switch (operation.kind) {
    case "append-log":
    case "emit-run":
    case "lose-publication-cas":
    case "crash":
    case "reconstruct": {
      return null;
    }
    case "publish-root": {
      return operation.runKeys.some((key) => state.store.objects.get(key)?.kind !== "run")
        ? "publish-incomplete-run"
        : null;
    }
    case "merge-runs": {
      if (operation.inputRunKeys.some((key) => state.store.objects.get(key)?.kind !== "run")) {
        return "merge-missing-run";
      }
      return operation.targetLevel < 0 || operation.targetLevel >= state.assumptions.maxActiveLevels
        ? "merge-level-overflow"
        : null;
    }
    case "retry": {
      const target = state.attempts.get(operation.targetOperationId);
      const hasCrashProvenance = [...state.coverage.crashBoundaries].some((boundary) =>
        boundary.startsWith(`${operation.targetOperationId}/`),
      );
      return target !== undefined &&
        target.operation.kind !== "retry" &&
        target.operation.kind !== "crash" &&
        target.operation.kind !== "reconstruct" &&
        hasCrashProvenance
        ? null
        : "retry-without-crash";
    }
    case "reclaim": {
      const reachable = reachableModelObjectKeys(state.store);
      return operation.candidateKeys.some((key) => reachable.has(key))
        ? "reclaim-reachable-object"
        : null;
    }
  }
};
