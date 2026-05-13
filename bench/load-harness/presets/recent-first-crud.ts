import { registerPreset } from "../presets.ts";
import type { OpMix } from "../generators/ops.ts";

const OP_MIX: OpMix = {
  weights: {
    "list-recent": 0.4,
    "point-read": 0.25,
    update: 0.15,
    insert: 0.1,
    "filtered-list": 0.05,
    archive: 0.05,
  },
};

registerPreset({
  name: "recent-first-crud",
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
    tenantCount: 1_000,
    schema: { collection: "notes" },
    // Distributions are intentionally undefined here — the dataset
    // generator falls back to the calibration JSON (when present)
    // and then to the literal defaults in
    // `generators/dataset.ts`. To override per-preset, set
    // `tenantSizeBuckets` etc. here.
  },
  pipeline: [
    { phase: "seed", opCount: 0 }, // seed: iterates dataset
    { phase: "ingest", opCount: 50_000 },
    {
      phase: "query-pre-compact",
      opCount: 20_000,
      mix: {
        weights: {
          "list-recent": 0.5,
          "point-read": 0.35,
          update: 0,
          insert: 0,
          "filtered-list": 0.15,
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
          "point-read": 0.35,
          update: 0,
          insert: 0,
          "filtered-list": 0.15,
          archive: 0,
        },
      },
    },
    { phase: "mixed", opCount: 30_000 },
  ],
  metadata: {
    targetConcurrency: 16,
    notes:
      "Notes-app shape; recent-first reads dominate. Idle subworkload " +
      "(query-pre-compact / query-post-compact) must satisfy the " +
      "< 1 Class A op / tenant / hour gate.",
  },
});
