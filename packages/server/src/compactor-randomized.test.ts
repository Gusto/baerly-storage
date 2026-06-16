/* eslint-disable no-underscore-dangle -- `_id` is the locked primary key. */
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  logSeqStartOf,
  MemoryStorage,
  readCurrentJson,
} from "@baerly/protocol";
import { compact } from "./compactor.ts";
import { foldLogEntriesOnto, walkLogRange } from "./log-walk.ts";
import { probeTailFrom } from "./log-tail.ts";
import { loadSnapshotAsMap } from "./snapshot.ts";
import { Writer } from "./writer.ts";

const PROP_TIMEOUT_MS = 600_000;
const CURRENT_JSON_KEY = "app/x/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/x/tenant/t/manifests/tickets";
const COLLECTION = "tickets";

type Doc = DocumentData & { _id: string; v: number };

const opArb = fc.oneof(
  fc.record({
    kind: fc.constant("I" as const),
    id: fc.constantFrom("a", "b", "c", "d"),
    v: fc.integer({ min: 0, max: 99 }),
  }),
  fc.record({
    kind: fc.constant("U" as const),
    id: fc.constantFrom("a", "b", "c", "d"),
    v: fc.integer({ min: 0, max: 99 }),
  }),
  fc.record({ kind: fc.constant("D" as const), id: fc.constantFrom("a", "b", "c", "d") }),
);

const seedCurrentJson = async (storage: MemoryStorage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
    tail_bytes: 0,
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

// Reconstruct the reader's materialized view from current.json: snapshot
// base + folded log tail. This is what a real reader does in `runRead`.
const reconstructView = async (storage: MemoryStorage): Promise<Map<string, DocumentData>> => {
  const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
  if (read === null) {
    throw new Error("current.json missing");
  }
  const base =
    read.json.snapshot === null
      ? new Map<string, DocumentData>()
      : await loadSnapshotAsMap(storage, read.json.snapshot, COLLECTION);
  // Strict dense walk [log_seq_start, tail_hint) + tolerant forward-probe
  // [max(log_seq_start, tail_hint), tail) — `tail_hint` is only a lower
  // bound under single-write commit.
  const logSeqStart = logSeqStartOf(read.json);
  const hint = read.json.tail_hint;
  const tail = await walkLogRange(storage, LOG_PREFIX, logSeqStart, hint);
  foldLogEntriesOnto(base, tail, { collection: COLLECTION });
  const probe = await probeTailFrom(storage, LOG_PREFIX, Math.max(logSeqStart, hint));
  foldLogEntriesOnto(base, probe.entries, { collection: COLLECTION });
  return base;
};

const asObj = (m: Map<string, DocumentData>): Record<string, DocumentData> => Object.fromEntries(m);

describe("compact — materialized view is unchanged by compaction", () => {
  test.prop({ ops: fc.array(opArb, { minLength: 0, maxLength: 40 }) })(
    "post-compaction reader view == model live set; tail_bytes >= 0; second run is a no-op",
    async ({ ops }) => {
      const storage = new MemoryStorage();
      await seedCurrentJson(storage);
      const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY, options: {} });

      const model = new Map<string, Doc>();
      for (const op of ops) {
        if (op.kind === "I") {
          if (model.has(op.id)) {
            continue;
          }
          const doc: Doc = { _id: op.id, v: op.v };
          await writer.commit({ op: "I", collection: COLLECTION, docId: op.id, body: doc });
          model.set(op.id, doc);
        } else if (op.kind === "U") {
          if (!model.has(op.id)) {
            continue;
          }
          const doc: Doc = { _id: op.id, v: op.v };
          await writer.commit({ op: "U", collection: COLLECTION, docId: op.id, body: doc });
          model.set(op.id, doc);
        } else {
          if (!model.has(op.id)) {
            continue;
          }
          await writer.commit({ op: "D", collection: COLLECTION, docId: op.id });
          model.delete(op.id);
        }
      }

      // View BEFORE compaction must already equal the model (sanity anchor).
      expect(asObj(await reconstructView(storage))).toEqual(asObj(model));

      // Compact everything available (minEntriesToCompact:1 so even 1 entry folds).
      const res = await compact(
        { storage, currentJsonKey: CURRENT_JSON_KEY },
        { minEntriesToCompact: 1 },
      );

      // The reader view AFTER compaction is byte-for-byte the same doc set.
      expect(asObj(await reconstructView(storage))).toEqual(asObj(model));

      // tail_bytes accounting never underflows.
      const afterCompact = await readCurrentJson(storage, CURRENT_JSON_KEY);
      expect(afterCompact!.json.tail_bytes).toBeGreaterThanOrEqual(0);

      // Idempotence: if the first run folded the whole tail, a second run has
      // nothing left and reports below-min-threshold; the view stays put.
      if (res.written) {
        const second = await compact(
          { storage, currentJsonKey: CURRENT_JSON_KEY },
          { minEntriesToCompact: 1 },
        );
        expect(second.written).toBe(false);
        expect(asObj(await reconstructView(storage))).toEqual(asObj(model));
      }
    },
    PROP_TIMEOUT_MS,
  );
});
