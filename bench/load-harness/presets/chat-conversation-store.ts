import { registerPreset } from "../presets.ts";
import type { OpMix } from "../generators/ops.ts";

export const CHAT_MESSAGES_PER_CONVERSATION = 50;
export const CHAT_TOOL_CALLS_PER_MESSAGE = 1; // 0–3 per message; median ~1

// Op-kind mapping (primary collection: "messages"):
//   read-recent-context (35%) → list-recent  on messages (ordered by sent_at)
//   append-message      (30%) → insert
//   list-conversations  (15%) → list-recent  on conversations (proxy: same collection)
//   append-tool-call     (7%) → insert
//   write-summary        (4%) → insert
//   read-history         (5%) → filtered-list on messages (no limit)
//   feedback             (4%) → insert

const OP_MIX: OpMix = {
  weights: {
    "list-recent": 0.5, // read-recent-context 0.35 + list-conversations 0.15
    insert: 0.45, // append-message 0.30 + append-tool-call 0.07 + write-summary 0.04 + feedback 0.04
    "filtered-list": 0.05,
    "point-read": 0,
    update: 0,
    archive: 0,
  },
};

registerPreset({
  name: "chat-conversation-store",
  schema: {
    collection: "messages",
    fields: [
      { name: "message_id", type: "string" },
      { name: "conversation_id", type: "string" },
      { name: "role", type: "string" },
      { name: "content", type: "string" },
      { name: "sent_at", type: "date" },
    ],
  },
  opMix: OP_MIX,
  datasetParams: {
    tenantCount: 1,
    schema: { collection: "messages" },
    // Conversations hold CHAT_MESSAGES_PER_CONVERSATION messages on average;
    // message bodies are ~200–1000 B.
    recordSizeBuckets: [
      { cumulativeFraction: 0.8, maxBytes: 500 },
      { cumulativeFraction: 1, maxBytes: 1_000 },
    ],
  },
  pipeline: [
    { phase: "seed", opCount: 0 },
    // Append-heavy ingest simulates ongoing chat traffic.
    {
      phase: "ingest",
      opCount: 40_000,
      mix: {
        weights: {
          "list-recent": 0,
          insert: 1,
          "filtered-list": 0,
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
          "list-recent": 0.7,
          insert: 0,
          "filtered-list": 0.3,
          "point-read": 0,
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
          "list-recent": 0.7,
          insert: 0,
          "filtered-list": 0.3,
          "point-read": 0,
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
      "Chat-conversation shape: append-heavy with recent-window context reads. " +
      "Stresses the log path's read-recent pattern and list-recent semantics.",
  },
});
