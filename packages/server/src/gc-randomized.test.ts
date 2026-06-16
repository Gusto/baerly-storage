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
import { type InternalRunGcOptions, runGc } from "./gc.ts";
import { foldLogEntriesOnto, walkLogRange } from "./log-walk.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { loadSnapshotAsMap } from "./snapshot.ts";
import { Writer } from "./writer.ts";

const PROP_TIMEOUT_MS = 600_000;
const CURRENT_JSON_KEY = "app/x/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/x/tenant/t/manifests/tickets";
const COLLECTION = "tickets";
const ORPHAN_CONTENT_KEY = `${LOG_PREFIX}/content/${"f".repeat(32)}.json`;

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

// `graceMillis` is an internal-only seam (rides on the same runtime
// options object as the public `RunGcOptions`). `InternalRunGcOptions`
// is exported from `./gc.ts` for exactly this test use — typing the
// literal against it is the sound minimal approach (no cast needed).
const gcOpts: InternalRunGcOptions = { graceMillis: 0 };

describe("runGc — never deletes a live object", () => {
  test.prop({
    ops1: fc.array(opArb, { minLength: 1, maxLength: 20 }),
    ops2: fc.array(opArb, { minLength: 1, maxLength: 20 }),
  })(
    "after a sweep: reader view unchanged, live objects survive, injected orphan reclaimed",
    async ({ ops1, ops2 }) => {
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

      // Two write+compact rounds → stale logs AND (if both rounds folded)
      // an orphan snapshot from round 1.
      //
      // Disable the Writer's in-band write-tick maintenance for the seeding
      // phase. Otherwise a commit can opportunistically tick `runGc` with the
      // PRODUCTION grace (7 days), pre-marking a stale log into `gc/pending.json`
      // with a 7-day-future `due_at`. The explicit grace-0 sweep below skips
      // already-`known` candidates, so that pre-marked entry would survive,
      // defeating the non-vacuity assertion. With maintenance disabled here,
      // the grace-0 `runGc` is the sole GC pass and fully controls every mark.
      await runWithContext(
        createObservabilityContext({ maintenance: { disabled: true } }),
        async () => {
          await applyOps(writer, model, ops1);
          await compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, { minEntriesToCompact: 1 });
          await applyOps(writer, model, ops2);
          await compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, { minEntriesToCompact: 1 });
        },
      );

      // Inject a guaranteed orphan content key.
      await storage.put(ORPHAN_CONTENT_KEY, new Uint8Array([1, 2, 3]), {
        contentType: "application/json",
      });

      // Capture live state + view BEFORE the sweep.
      const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
      if (read === null) {
        throw new Error("current.json missing before sweep");
      }
      const logSeqStart = logSeqStartOf(read.json);
      const nextSeq = read.json.tail_hint;
      const liveSnapshotKey = read.json.snapshot;
      const viewBefore = await reconstructView(storage);

      // Sweep with grace bypassed so marks become due immediately.
      await runGc({ storage, currentJsonKey: CURRENT_JSON_KEY }, gcOpts);

      // (1) Reader view is byte-for-byte identical.
      const viewAfter = await reconstructView(storage);
      expect(viewAfter).toEqual(viewBefore);
      expect(viewBefore).toEqual(Object.fromEntries(model));

      // (2) Every live log entry still resolves.
      for (let s = logSeqStart; s < nextSeq; s++) {
        await expect(
          storage.get(`${LOG_PREFIX}/log/${s}.json`),
          `live log seq ${s} must survive GC`,
        ).resolves.not.toBeNull();
      }
      // (2) The current snapshot still loads (hash-checked).
      if (liveSnapshotKey !== null) {
        await expect(
          loadSnapshotAsMap(storage, liveSnapshotKey, COLLECTION),
        ).resolves.toBeInstanceOf(Map);
      }

      // (3) Non-vacuity: the injected orphan content key was reclaimed.
      await expect(
        storage.get(ORPHAN_CONTENT_KEY),
        "orphan content must be swept",
      ).resolves.toBeNull();
      // (3) Non-vacuity: a stale log entry below log_seq_start was reclaimed.
      if (logSeqStart > 0) {
        await expect(
          storage.get(`${LOG_PREFIX}/log/0.json`),
          "stale log/0 must be swept",
        ).resolves.toBeNull();
      }
    },
    PROP_TIMEOUT_MS,
  );
});
