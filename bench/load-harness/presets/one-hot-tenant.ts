import { registerPreset } from "../presets.ts";
import type { OpMix } from "../generators/ops.ts";

// 80% of traffic goes to tenant-0 ("hot"); remaining 20% spreads uniformly.
export const TENANT_SKEW_RATIO = 0.8;

const OP_MIX: OpMix = {
  weights: {
    "list-recent": 0.6,
    "point-read": 0.2,
    insert: 0.1,
    update: 0.1,
    "filtered-list": 0,
    archive: 0,
  },
};

registerPreset({
  name: "one-hot-tenant",
  schema: {
    collection: "notes",
    fields: [
      { name: "notebook_id", type: "string" },
      { name: "title", type: "string" },
      { name: "body", type: "string" },
      { name: "status", type: "string" },
      { name: "updated_at", type: "date" },
    ],
  },
  opMix: OP_MIX,
  datasetParams: {
    tenantCount: 100,
    schema: { collection: "notes" },
    // One hot tenant gets TENANT_SKEW_RATIO of traffic; remaining share
    // evenly. Expressed via tenantTrafficBuckets: top 1% (≥1 tenant) →
    // 80%, remaining 99% → 20%.
    tenantTrafficBuckets: [
      { topFraction: 0.01, trafficShare: TENANT_SKEW_RATIO },
      { topFraction: 0.99, trafficShare: 1 - TENANT_SKEW_RATIO },
    ],
  },
  pipeline: [
    { phase: "seed", opCount: 0 },
    { phase: "ingest", opCount: 20_000 },
    {
      phase: "query-pre-compact",
      opCount: 10_000,
      mix: {
        weights: {
          "list-recent": 0.7,
          "point-read": 0.3,
          insert: 0,
          update: 0,
          "filtered-list": 0,
          archive: 0,
        },
      },
    },
    { phase: "compact", opCount: 0 },
    {
      phase: "query-post-compact",
      opCount: 10_000,
      mix: {
        weights: {
          "list-recent": 0.7,
          "point-read": 0.3,
          insert: 0,
          update: 0,
          "filtered-list": 0,
          archive: 0,
        },
      },
    },
    { phase: "mixed", opCount: 15_000 },
  ],
  metadata: {
    targetConcurrency: 8,
    notes:
      "80/20 tenant skew: one hot tenant absorbs 80% of traffic. " +
      "Stresses per-current.json contention and metadata-warm cache value.",
  },
});
