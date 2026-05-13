import type { Dataset, DatasetTenant } from "./dataset.ts";
import { makeRng, type Rng } from "./rng.ts";

export type OpKind =
  | "list-recent"
  | "point-read"
  | "update"
  | "insert"
  | "filtered-list"
  | "archive";

export interface Op {
  readonly kind: OpKind;
  readonly tenantId: string;
  /** undefined for list-recent / filtered-list / insert. */
  readonly recordId?: string;
  /** Stable across runs given identical seed + dataset. */
  readonly seq: number;
}

export interface OpMix {
  readonly weights: Readonly<Record<OpKind, number>>;
}

export interface OpStreamParams {
  readonly seed: number;
  readonly dataset: Dataset;
  readonly mix: OpMix;
  readonly opCount: number;
}

/**
 * Generate `opCount` ops by:
 *   1. Picking a tenant weighted by `trafficShare`.
 *   2. Picking an op kind weighted by `mix.weights`.
 *   3. For ops that target a record, picking by popularityRank-
 *      weighted Zipf within the tenant's records.
 *
 * Determinism: the entire stream is a pure function of seed +
 * dataset + mix + opCount. Two runs with identical params produce
 * identical `Op[]` (verified by `tests/ops.test.ts`).
 */
export function generateOpStream(params: OpStreamParams): Op[] {
  const rng = makeRng(params.seed);
  const ops: Op[] = [];
  const tenants = params.dataset.tenants;
  const tenantWeights = tenants.map((t) => Math.max(1e-6, t.trafficShare));
  const opKinds: OpKind[] = [
    "list-recent",
    "point-read",
    "update",
    "insert",
    "filtered-list",
    "archive",
  ];
  const opWeights = opKinds.map((k) => params.mix.weights[k]);

  for (let i = 0; i < params.opCount; i++) {
    const tenant = rng.weighted(tenants, tenantWeights);
    const kind = rng.weighted(opKinds, opWeights);
    let recordId: string | undefined;
    if (kind === "point-read" || kind === "update" || kind === "archive") {
      const recIdx = pickRecordByPopularity(rng, tenant);
      recordId = tenant.records[recIdx]?.recordId;
    } else if (kind === "insert") {
      recordId = `r-${tenant.tenantId.slice(2)}-NEW-${i.toString(16).padStart(8, "0")}`;
    }
    ops.push({ kind, tenantId: tenant.tenantId, recordId, seq: i });
  }
  return ops;
}

function pickRecordByPopularity(rng: Rng, tenant: DatasetTenant): number {
  // 70% chance to hit recent 10%; 20% chance to hit next 10%; 10%
  // chance to hit the long tail. Within each band, uniform.
  // (The popularityRank field is 0 = most-recent.)
  const N = tenant.records.length;
  if (N === 0) return 0;
  const u = rng.next();
  if (u < 0.7) {
    return rng.int(0, Math.max(1, Math.floor(N * 0.1)));
  } else if (u < 0.9) {
    return rng.int(Math.floor(N * 0.1), Math.max(Math.floor(N * 0.1) + 1, Math.floor(N * 0.2)));
  }
  return rng.int(Math.floor(N * 0.2), N);
}
