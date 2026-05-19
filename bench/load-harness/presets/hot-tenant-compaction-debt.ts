import { registerPreset } from "../presets.ts";
import type { OpMix } from "../generators/ops.ts";

const OP_MIX: OpMix = {
  weights: {
    "list-recent": 0.35,
    "point-read": 0.35,
    insert: 0.2,
    update: 0,
    "filtered-list": 0.1,
    archive: 0,
  },
};

registerPreset({
  name: "hot-tenant-compaction-debt",
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
    // Ingest phase doubles the log depth via inserts before any
    // query phase runs, creating the "compaction debt" that the
    // query-pre-compact vs query-post-compact delta reveals.
    {
      phase: "ingest",
      opCount: 30_000,
      mix: {
        weights: {
          "list-recent": 0,
          "point-read": 0,
          insert: 1,
          update: 0,
          "filtered-list": 0,
          archive: 0,
        },
      },
    },
    {
      phase: "query-pre-compact",
      opCount: 20_000,
      mix: {
        weights: {
          "list-recent": 0.5,
          "point-read": 0.4,
          insert: 0,
          update: 0,
          "filtered-list": 0.1,
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
          "list-recent": 0.5,
          "point-read": 0.4,
          insert: 0,
          update: 0,
          "filtered-list": 0.1,
          archive: 0,
        },
      },
    },
    { phase: "mixed", opCount: 20_000 },
  ],
  metadata: {
    targetConcurrency: 4,
    notes:
      "One hot tenant seeded then flooded with inserts (ingest) before queries run. " +
      "Reveals query-pre-compact vs query-post-compact cost delta.",
  },
});
