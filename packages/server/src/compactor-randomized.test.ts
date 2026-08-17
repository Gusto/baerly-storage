import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { type DocumentData, logSeqStartOf, MemoryStorage, readCurrentJson } from "@baerly/protocol";
import {
  applyOps,
  COLLECTION,
  CURRENT_JSON_KEY,
  type Doc,
  LOG_PREFIX,
  opArb,
  PROP_TIMEOUT_MS,
  seedCurrentJson,
} from "./_internal/randomized-model.ts";
import { compact } from "./compactor.ts";
import { foldLogEntriesOnto, walkLogRange } from "./log-walk.ts";
import { probeTailFrom } from "./log-tail.ts";
import { loadSnapshotAsMap } from "./snapshot.ts";
import { Writer } from "./writer.ts";

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
    "post-compaction reader view == model live set; second run is a no-op",
    async ({ ops }) => {
      const storage = new MemoryStorage();
      await seedCurrentJson(storage);
      const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY, options: {} });

      const model = new Map<string, Doc>();
      await applyOps(writer, model, ops);

      // View BEFORE compaction must already equal the model (sanity anchor).
      expect(asObj(await reconstructView(storage))).toEqual(asObj(model));

      // Compact everything available (minEntriesToCompact:1 so even 1 entry folds).
      const res = await compact(
        { storage, currentJsonKey: CURRENT_JSON_KEY },
        { minEntriesToCompact: 1 },
      );

      // The reader view AFTER compaction is byte-for-byte the same doc set.
      expect(asObj(await reconstructView(storage))).toEqual(asObj(model));

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
