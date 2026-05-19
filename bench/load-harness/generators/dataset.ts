import { makeRng } from "./rng.ts";
import type { CalibrationParams } from "./calibration.ts";

/**
 * One synthetic record. The `body` is the bytes the harness will
 * PUT under the dataset's collection. The `payload` is a parsed
 * view of the body that the op-stream generator uses to construct
 * update / replace patches without re-parsing.
 */
export interface DatasetRecord {
  readonly recordId: string;
  readonly bodyBytes: Uint8Array;
  readonly bytes: number; // bodyBytes.byteLength, denormalised
  readonly createdAtMs: number; // synthetic; monotonic per-tenant
  readonly popularityRank: number; // 0 = hottest within tenant
}

export interface DatasetTenant {
  readonly tenantId: string;
  readonly records: readonly DatasetRecord[];
  /** Cumulative traffic share, 0..1. Used by op-stream sampling. */
  readonly trafficShare: number;
}

export interface DatasetParams {
  readonly seed: number;
  readonly tenantCount: number;
  readonly schema: { readonly collection: string };
  readonly calibration?: CalibrationParams;
  /** Override for tests. Defaults to the calibration values. */
  readonly tenantSizeBuckets?: CalibrationParams["tenantSize"];
  readonly tenantTrafficBuckets?: CalibrationParams["tenantTraffic"];
  readonly recordPopularityBuckets?: CalibrationParams["recordPopularity"];
  readonly recordSizeBuckets?: CalibrationParams["recordSize"];
}

export interface Dataset {
  readonly tenants: readonly DatasetTenant[];
  /** Sum of record counts across all tenants. */
  readonly totalRecords: number;
  /** Sum of record bytes across all tenants. */
  readonly totalBytes: number;
}

const DEFAULT_TENANT_SIZE = [
  { cumulativeFraction: 0.7, maxRecords: 100 },
  { cumulativeFraction: 0.9, maxRecords: 1_000 },
  { cumulativeFraction: 0.99, maxRecords: 10_000 },
  { cumulativeFraction: 1, maxRecords: 100_000 },
];

const DEFAULT_TENANT_TRAFFIC = [
  { topFraction: 0.01, trafficShare: 0.5 },
  { topFraction: 0.09, trafficShare: 0.3 },
  { topFraction: 0.9, trafficShare: 0.2 },
];

const DEFAULT_RECORD_SIZE = [
  { cumulativeFraction: 0.7, maxBytes: 2_000 },
  { cumulativeFraction: 0.95, maxBytes: 10_000 },
  { cumulativeFraction: 1, maxBytes: 1_000_000 },
];

/**
 * Build the dataset deterministically. Algorithm (must match across
 * runs given identical params):
 *
 *   1. Seed Rng A from `params.seed` for tenant-size sampling.
 *   2. For each tenant i ∈ [0, tenantCount):
 *      a. Sample tenant size via `tenantSizeBuckets` cumulative
 *         fraction → uniform-within-bucket record count.
 *      b. Seed Rng B from `params.seed ^ i` for record-body bytes.
 *      c. Generate that many records: id, body bytes (size sampled
 *         from `recordSizeBuckets`), createdAt monotonic increment,
 *         popularityRank assigned 0..N-1 in createdAt order so
 *         recent-bias aligns with id-order.
 *   3. Compute trafficShare per tenant from `tenantTrafficBuckets`.
 *
 * Determinism note: per-tenant Rng B (step 2b) is seeded from
 * `seed ^ i` rather than the parent Rng A so re-running with a
 * subset of tenants (debugging a single noisy tenant) gives the
 * same record bytes per tenant — useful for failure replay.
 */
export function buildDataset(params: DatasetParams): Dataset {
  const sizeBuckets =
    params.tenantSizeBuckets ?? params.calibration?.tenantSize ?? DEFAULT_TENANT_SIZE;
  const trafficBuckets =
    params.tenantTrafficBuckets ?? params.calibration?.tenantTraffic ?? DEFAULT_TENANT_TRAFFIC;
  const sizeRecordBuckets =
    params.recordSizeBuckets ?? params.calibration?.recordSize ?? DEFAULT_RECORD_SIZE;

  const tenants: DatasetTenant[] = [];
  let totalRecords = 0;
  let totalBytes = 0;
  const rngA = makeRng(params.seed);

  for (let i = 0; i < params.tenantCount; i++) {
    const sizeFraction = rngA.next();
    let recordCount = 0;
    let prevCum = 0;
    for (const bucket of sizeBuckets) {
      if (sizeFraction <= bucket.cumulativeFraction) {
        // Uniform within bucket; clamp to [1, maxRecords].
        const minRecords = prevCum === 0 ? 1 : Math.floor(bucket.maxRecords / 10);
        recordCount = rngA.int(minRecords, bucket.maxRecords + 1);
        break;
      }
      prevCum = bucket.cumulativeFraction;
    }
    if (recordCount === 0) {
      recordCount = sizeBuckets[sizeBuckets.length - 1]!.maxRecords;
    }

    const rngB = makeRng(params.seed ^ i);
    const records: DatasetRecord[] = [];
    for (let j = 0; j < recordCount; j++) {
      const sizeFrac = rngB.next();
      let recordBytes = 1000;
      for (const bucket of sizeRecordBuckets) {
        if (sizeFrac <= bucket.cumulativeFraction) {
          recordBytes = rngB.int(bucket.maxBytes / 4, bucket.maxBytes);
          break;
        }
      }
      const bodyBytes = new Uint8Array(recordBytes);
      // Cheap deterministic fill — content is not the load-bearing
      // bit; bytes_written is. Hash-like fill avoids zero-pages
      // that some adapters dedup.
      for (let k = 0; k < recordBytes; k++) {
        bodyBytes[k] = (k + j + i) & 0xff;
      }
      records.push({
        recordId: `r-${i.toString(16).padStart(4, "0")}-${j.toString(16).padStart(6, "0")}`,
        bodyBytes,
        bytes: recordBytes,
        createdAtMs: 1_700_000_000_000 + i * 1_000_000 + j,
        popularityRank: recordCount - 1 - j, // recent = low rank
      });
    }
    totalRecords += recordCount;
    totalBytes += records.reduce((acc, r) => acc + r.bytes, 0);
    tenants.push({
      tenantId: `t-${i.toString(16).padStart(6, "0")}`,
      records,
      trafficShare: 0, // filled below
    });
  }

  // Assign trafficShare per tenant.
  const sortedIdx = tenants.map((_, idx) => idx);
  // Sort by tenant size descending so the busiest are on top —
  // matches the "top 1% of tenants gets 50% of traffic" mapping.
  sortedIdx.sort((a, b) => tenants[b]!.records.length - tenants[a]!.records.length);
  const withTraffic: DatasetTenant[] = tenants.map((t) => ({ ...t, trafficShare: 0 }));
  let assigned = 0;
  for (const bucket of trafficBuckets) {
    const cutoff = Math.max(1, Math.floor(bucket.topFraction * tenants.length));
    const share = bucket.trafficShare / cutoff;
    for (let k = assigned; k < assigned + cutoff && k < tenants.length; k++) {
      const idx = sortedIdx[k]!;
      (withTraffic[idx] as DatasetTenant & { trafficShare: number }).trafficShare = share;
    }
    assigned += cutoff;
  }

  return { tenants: withTraffic, totalRecords, totalBytes };
}
