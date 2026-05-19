import { registerPreset } from "../presets.ts";
import type { OpMix } from "../generators/ops.ts";

export const MANY_TINY_APPS_DEFAULT_TENANTS = 1_000;

const OP_MIX: OpMix = {
  weights: {
    "list-recent": 0.5,
    "point-read": 0.2,
    insert: 0.3,
    update: 0,
    "filtered-list": 0,
    archive: 0,
  },
};

registerPreset({
  name: "many-tiny-apps",
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
    tenantCount: MANY_TINY_APPS_DEFAULT_TENANTS,
    schema: { collection: "notes" },
    // 50-200 records per tenant (truncated geometric approximated via
    // tight size buckets: 70% ≤100, 30% 100–200).
    tenantSizeBuckets: [
      { cumulativeFraction: 0.7, maxRecords: 100 },
      { cumulativeFraction: 1, maxRecords: 200 },
    ],
    // Uniform traffic spread — every tenant equally likely.
    tenantTrafficBuckets: [{ topFraction: 1, trafficShare: 1 }],
  },
  pipeline: [
    { phase: "seed", opCount: 0 },
    { phase: "ingest", opCount: 30_000 },
    {
      phase: "query-pre-compact",
      opCount: 20_000,
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
      opCount: 20_000,
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
    { phase: "mixed", opCount: 20_000 },
  ],
  metadata: {
    targetConcurrency: 16,
    notes:
      "1000 tenants each with 50-200 records; uniform traffic. " +
      "Worst case for manifest cache: every tenant brings a cold current.json miss.",
  },
});
