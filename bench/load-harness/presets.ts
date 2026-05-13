import type { DatasetParams } from "./generators/dataset.ts";
import type { OpMix } from "./generators/ops.ts";

/**
 * The six pipeline phases every preset runs through. Phase 1 is
 * the only one with a tractable upper bound on duration (it
 * terminates when every dataset record is PUT once); phases 2-6
 * are budget-bounded by `opCount` or wall-clock.
 *
 * Ticket 53's runner walks this array in order. Each phase has a
 * before/after snapshot from `CountingStorage` (ticket 50) so the
 * run-JSON shows per-phase cost.
 */
export type PipelinePhase =
  | "seed" // PUT every dataset record once
  | "ingest" // mix-driven, write-heavy
  | "query-pre-compact" // mix-driven, read-only on uncompacted log
  | "compact" // run scheduled maintenance to quiescence
  | "query-post-compact" // mix-driven, read-only on compacted state
  | "mixed"; // mix-driven, read+write under steady state

export interface PresetSchema {
  readonly collection: string;
  readonly fields: ReadonlyArray<{
    readonly name: string;
    readonly type: "string" | "number" | "boolean" | "date";
  }>;
}

export interface PresetPipelineSpec {
  readonly phase: PipelinePhase;
  /** Op budget for this phase. `seed` and `compact` ignore this. */
  readonly opCount: number;
  /** Override mix for this phase; falls back to preset-level mix. */
  readonly mix?: OpMix;
}

export interface Preset {
  readonly name: string;
  readonly schema: PresetSchema;
  readonly opMix: OpMix;
  readonly datasetParams: Omit<DatasetParams, "seed">;
  readonly pipeline: ReadonlyArray<PresetPipelineSpec>;
  /**
   * Workload metadata for the harness to warn against backend
   * limits. Set conservatively per preset. The harness in ticket
   * 54 will check `targetConcurrency` against R2's 1-write/sec-per-
   * object limit and warn when exceeded.
   */
  readonly metadata: {
    readonly targetConcurrency: number;
    readonly notes: string;
  };
}

const REGISTRY = new Map<string, Preset>();

export function registerPreset(p: Preset): void {
  if (REGISTRY.has(p.name)) {
    throw new Error(`bench/load-harness: preset already registered: ${p.name}`);
  }
  REGISTRY.set(p.name, p);
}

export function getPreset(name: string): Preset {
  const p = REGISTRY.get(name);
  if (p === undefined) {
    throw new Error(
      `bench/load-harness: unknown preset '${name}'. ` +
        `Available: ${[...REGISTRY.keys()].toSorted().join(", ")}`,
    );
  }
  return p;
}

export function listPresets(): readonly string[] {
  return [...REGISTRY.keys()].toSorted();
}
