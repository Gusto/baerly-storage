import { registerPreset } from "../presets.ts";
import type { OpMix } from "../generators/ops.ts";

// 30% of records are "hot" update targets; 70% are cold.
export const COLD_RECORD_SKEW = 0.7;
export const HOT_RECORD_SKEW = 0.3;
// Update ops pick a hot record 80% of the time.
export const UPDATE_HOT_BIAS = 0.8;

const OP_MIX: OpMix = {
  weights: {
    "list-recent": 0.3,
    "point-read": 0,
    insert: 0.1,
    update: 0.5,
    "filtered-list": 0,
    archive: 0.1,
  },
};

registerPreset({
  name: "update-heavy-messy-log",
  schema: {
    collection: "items",
    fields: [
      { name: "status", type: "string" },
      { name: "payload", type: "string" },
    ],
  },
  opMix: OP_MIX,
  datasetParams: {
    tenantCount: 1,
    schema: { collection: "items" },
  },
  pipeline: [
    { phase: "seed", opCount: 0 },
    { phase: "ingest", opCount: 50_000 },
    {
      phase: "query-pre-compact",
      opCount: 10_000,
      mix: {
        weights: {
          "list-recent": 1,
          "point-read": 0,
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
          "list-recent": 1,
          "point-read": 0,
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
    targetConcurrency: 4,
    notes:
      "50% updates over a small record set; 30% of records absorb 80% of update ops. " +
      "Stresses log-tail growth and write-amplification post-compact.",
  },
});
