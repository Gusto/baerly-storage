/* eslint-disable no-underscore-dangle -- `_id` is the locked primary key. */
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  certifiedDeleteFloor,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  logDeleteFloorOf,
  logObjectKey,
  logSeqStartOf,
  MemoryStorage,
  readCurrentJson,
} from "@baerly/protocol";
import { compact } from "./compactor.ts";
import { foldLogEntriesOnto, walkLogRange } from "./log-walk.ts";
import { retireLogRange } from "./log-retention.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { loadSnapshotAsMap } from "./snapshot.ts";
import { Writer } from "./writer.ts";

const PROP_TIMEOUT_MS = 600_000;
const CURRENT_JSON_KEY = "app/x/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/x/tenant/t/manifests/tickets";
const COLLECTION = "tickets";
const ROUNDS = 3;
// Small enough that a 1-20-op round's worth of commits plausibly clears it —
// the repo default (`LOG_RETENTION_SEQ_WINDOW`, 1024) never would at this
// scale, which would make the non-vacuity assertion below silently vacuous.
const WINDOW = 5;
const MAX_DELETES = 1000;

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

const reconstructView = async (storage: MemoryStorage): Promise<Record<string, DocumentData>> => {
  const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
  if (read === null) {
    throw new Error("current.json missing");
  }
  const base =
    read.json.snapshot === null
      ? new Map<string, DocumentData>()
      : await loadSnapshotAsMap(storage, read.json.snapshot, COLLECTION);
  const tail = await walkLogRange(
    storage,
    LOG_PREFIX,
    logSeqStartOf(read.json),
    read.json.tail_hint,
  );
  foldLogEntriesOnto(base, tail, { collection: COLLECTION });
  return Object.fromEntries(base);
};

const applyOps = async (
  writer: Writer,
  model: Map<string, Doc>,
  ops: ReadonlyArray<{ kind: "I" | "U" | "D"; id: string; v?: number }>,
): Promise<void> => {
  for (const op of ops) {
    if (op.kind === "I") {
      if (model.has(op.id)) {
        continue;
      }
      const doc: Doc = { _id: op.id, v: op.v! };
      await writer.commit({ op: "I", collection: COLLECTION, docId: op.id, body: doc });
      model.set(op.id, doc);
    } else if (op.kind === "U") {
      if (!model.has(op.id)) {
        continue;
      }
      const doc: Doc = { _id: op.id, v: op.v! };
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
};

describe("retireLogRange — never deletes a live object", () => {
  fcTest.prop({
    rounds: fc.array(fc.array(opArb, { minLength: 1, maxLength: 20 }), {
      minLength: ROUNDS,
      maxLength: ROUNDS,
    }),
  })(
    "across repeated write→compact→retire ticks: reader view unchanged, live log entries survive, and log_delete_floor never outruns log_seq_start",
    async ({ rounds }) => {
      const storage = new MemoryStorage();
      await createCurrentJson(storage, CURRENT_JSON_KEY, {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        tail_hint: 0,
        log_seq_start: 0,
        writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
        snapshot_bytes: 0,
        snapshot_rows: 0,
      });
      const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY, options: {} });
      const model = new Map<string, Doc>();

      for (const ops of rounds) {
        // Disable in-band write-tick maintenance for the write+compact phase.
        // Production write-tick maintenance calls `retireLogRange` too (this
        // PR wires it into `maintenance.ts`), so leaving it on would let
        // uncontrolled background retirement happen before the explicit
        // sweep below, making the before/after comparison meaningless.
        await runWithContext(
          createObservabilityContext({ maintenance: { disabled: true } }),
          async () => {
            await applyOps(writer, model, ops);
            await compact(
              { storage, currentJsonKey: CURRENT_JSON_KEY },
              { minEntriesToCompact: 1 },
            );
          },
        );

        const preRetire = await readCurrentJson(storage, CURRENT_JSON_KEY);
        if (preRetire === null) {
          throw new Error("current.json missing before retire");
        }
        const preLiveFloor = logSeqStartOf(preRetire.json);
        const preDeleteFloor = certifiedDeleteFloor(preRetire.json);
        const viewBefore = await reconstructView(storage);

        const result = await retireLogRange(storage, CURRENT_JSON_KEY, {
          window: WINDOW,
          maxDeletes: MAX_DELETES,
        });

        // (1) Reader view is unchanged, and matches the model.
        const viewAfter = await reconstructView(storage);
        expect(viewAfter).toEqual(viewBefore);
        expect(viewBefore).toEqual(Object.fromEntries(model));

        const postRetire = await readCurrentJson(storage, CURRENT_JSON_KEY);
        if (postRetire === null) {
          throw new Error("current.json missing after retire");
        }

        // (2) Nothing at or above the certified delete floor was deleted.
        const postDeleteFloor = logDeleteFloorOf(postRetire.json);
        for (let seq = postDeleteFloor; seq < postRetire.json.tail_hint; seq++) {
          await expect(
            storage.get(logObjectKey(LOG_PREFIX, seq)),
            `live log seq ${String(seq)} must survive retireLogRange`,
          ).resolves.not.toBeNull();
        }

        // (3) Invariant 12: log_delete_floor never outruns log_seq_start.
        expect(postDeleteFloor).toBeLessThanOrEqual(logSeqStartOf(postRetire.json));

        // (4) Non-vacuity: whenever the pre-retire state authorized a
        // non-empty range under this window, the sweep must have actually
        // deleted something — don't just hope the shrinker stumbles into it.
        if (preLiveFloor - preDeleteFloor > WINDOW) {
          expect(result.deleted).toBeGreaterThan(0);
        }
      }
    },
    PROP_TIMEOUT_MS,
  );
});
