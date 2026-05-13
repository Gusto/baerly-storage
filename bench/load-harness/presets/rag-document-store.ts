import { registerPreset } from "../presets.ts";
import type { OpMix } from "../generators/ops.ts";

export const RAG_CHUNKS_PER_DOC_MIN = 8;
export const RAG_CHUNKS_PER_DOC_MAX = 32;
export const RAG_CITATIONS_LINK_RATE = 0.05;

// Op-kind mapping (all ops target the primary "documents" collection):
//   list-documents (25%)  → list-recent  on documents
//   read-chunks    (25%)  → filtered-list on documents (simulates chunk lookup by doc_id)
//   filter-by-src  (15%)  → filtered-list (source_type filter)
//   append-ingest  (10%)  → insert
//   query-log      (10%)  → insert
//   read-citations  (5%)  → filtered-list
//   feedback        (5%)  → insert
//   misc            (5%)  → point-read

const OP_MIX: OpMix = {
  weights: {
    "list-recent": 0.25,
    "filtered-list": 0.45, // read-chunks 0.25 + filter-by-source 0.15 + read-citations 0.05
    insert: 0.25, // append-ingest 0.10 + query-log 0.10 + feedback 0.05
    "point-read": 0.05,
    update: 0,
    archive: 0,
  },
};

registerPreset({
  name: "rag-document-store",
  schema: {
    collection: "documents",
    fields: [
      { name: "document_id", type: "string" },
      { name: "tenant_id", type: "string" },
      { name: "source_type", type: "string" },
      { name: "source_url", type: "string" },
      { name: "title", type: "string" },
      { name: "ingested_at", type: "date" },
    ],
  },
  opMix: OP_MIX,
  datasetParams: {
    tenantCount: 1,
    schema: { collection: "documents" },
    // Documents fan out to RAG_CHUNKS_PER_DOC_MIN–RAG_CHUNKS_PER_DOC_MAX chunks;
    // record-size distribution matches a ~200B document header.
    recordSizeBuckets: [{ cumulativeFraction: 1.0, maxBytes: 512 }],
  },
  pipeline: [
    { phase: "seed", opCount: 0 },
    {
      phase: "ingest",
      opCount: 30_000,
      mix: {
        weights: {
          "list-recent": 0,
          "filtered-list": 0,
          insert: 1.0,
          "point-read": 0,
          update: 0,
          archive: 0,
        },
      },
    },
    {
      phase: "query-pre-compact",
      opCount: 20_000,
      mix: {
        weights: {
          "list-recent": 0.33,
          "filtered-list": 0.6,
          insert: 0,
          "point-read": 0.07,
          update: 0,
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
          "list-recent": 0.33,
          "filtered-list": 0.6,
          insert: 0,
          "point-read": 0.07,
          update: 0,
          archive: 0,
        },
      },
    },
    { phase: "mixed", opCount: 20_000 },
  ],
  metadata: {
    targetConcurrency: 8,
    notes:
      "RAG document-store shape: list-recent + filtered-list reads dominate. " +
      "Stresses cross-table read patterns and manifest layout per table " +
      "(simulated as filtered reads against the primary documents collection).",
  },
});
