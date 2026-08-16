/**
 * The pin-4 contract: a commit never acknowledges a mutation no fresh reader
 * can see.
 *
 * Two schedules put a winning `log/<seq>` create into a slot that fold +
 * retirement already emptied — a delayed create PUT (T1) and a lost-ack retry
 * of the same seq (T2). Both must fail with `AmbiguousCommit` rather than
 * returning success. Everything runs against the real `Writer`, `compact()`,
 * and `retireLogRange`; visibility is checked through a fresh `Db`.
 */

import {
  BaerlyError,
  createCurrentJson,
  decodeJsonBytes,
  encodeJsonBytes,
  type LogEntry,
  LOG_RETENTION_SEQ_WINDOW,
  logObjectKey,
  MemoryStorage,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  logStateCurrentJson,
  seedLogEntries,
  seedLogEntry,
} from "../../../tests/fixtures/log-state.ts";
import { compact } from "./compactor.ts";
import { Db } from "./db.ts";
import { retireLogRange } from "./log-retention.ts";
import {
  createObservabilityContext,
  type ObservabilityContext,
  runWithContext,
} from "./observability/index.ts";
import { Writer } from "./writer.ts";

const sumCounter = (ctx: ObservabilityContext, name: string): number =>
  ctx.recorder
    .snapshot()
    .counters.filter((c) => c.name === name)
    .reduce((acc, c) => acc + c.value, 0);

const CURRENT_KEY = "app/a/tenant/t/manifests/c/current.json";
const PREFIX = "app/a/tenant/t/manifests/c";
const DOC_ID = "paused-writer-doc";
const DOC_BODY = { _id: DOC_ID, source: "paused-writer" } as const;

/** Filler occupies `[1, FILLER_END)`; slot 0 is the contended one. */
const FILLER_END = LOG_RETENTION_SEQ_WINDOW + 1;

const MAINTENANCE_OFF = createObservabilityContext({ maintenance: { disabled: true } });

const seedManifest = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
};

/**
 * Occupy `[1, FILLER_END)`, fold `[0, FILLER_END)`, then drain retirement.
 * Requires slot 0 to already be occupied — the live range must be dense for
 * the fold to advance the floor.
 */
const advanceFloorAndRetire = async (storage: Storage): Promise<void> => {
  await seedLogEntries(storage, PREFIX, 1, FILLER_END);
  const folded = await compact(
    { storage, currentJsonKey: CURRENT_KEY },
    { minEntriesToCompact: 1 },
  );
  expect(folded).toMatchObject({ written: true, logSeqStartAfter: FILLER_END });
  for (;;) {
    const { deleted } = await retireLogRange(storage, CURRENT_KEY);
    if (deleted === 0) {
      break;
    }
  }
  const after = await readCurrentJson(storage, CURRENT_KEY);
  expect(after?.json.log_seq_start).toBe(FILLER_END);
  expect(after?.json.log_delete_floor).toBe(FILLER_END - LOG_RETENTION_SEQ_WINDOW);
  await expect(storage.get(logObjectKey(PREFIX, 0))).resolves.toBeNull();
};

/** Every key/body in the bucket, sorted — the state a recovery predicate could consult. */
const dumpBucket = async (storage: Storage): Promise<Array<[string, string]>> => {
  const keys: string[] = [];
  for await (const entry of storage.list("app/")) {
    keys.push(entry.key);
  }
  const out: Array<[string, string]> = [];
  for (const key of keys.toSorted()) {
    const got = await storage.get(key);
    out.push([key, new TextDecoder().decode(got!.body)]);
  }
  return out;
};

/** Wrap `inner` so the first PUT of `gatedKey` blocks until released. */
const gatedPutStorage = (
  inner: Storage,
  gatedKey: string,
  behavior: "delay" | "fail",
): { storage: Storage; reached: Promise<void>; release: () => void } => {
  let signalReached!: () => void;
  const reached = new Promise<void>((r) => {
    signalReached = r;
  });
  let signalReleased!: () => void;
  const released = new Promise<void>((r) => {
    signalReleased = r;
  });
  let firstPut = true;
  const storage: Storage = {
    get: (key, opts) => inner.get(key, opts),
    list: (prefix, opts) => inner.list(prefix, opts),
    delete: (key, opts) => inner.delete(key, opts),
    async put(key, body, opts) {
      if (key === gatedKey && firstPut) {
        firstPut = false;
        signalReached();
        await released;
        if (behavior === "fail") {
          throw new BaerlyError("NetworkError", "test: simulated dropped ack on the log create");
        }
      }
      return inner.put(key, body, opts);
    },
  };
  return { storage, reached, release: signalReleased };
};

/** Wrap `inner` so DELETE of `failKey` always rejects. Everything else passes through. */
const withFailingDelete = (inner: Storage, failKey: string): Storage => ({
  get: (key, opts) => inner.get(key, opts),
  list: (prefix, opts) => inner.list(prefix, opts),
  put: (key, body, opts) => inner.put(key, body, opts),
  async delete(key, opts) {
    if (key === failKey) {
      throw new BaerlyError(
        "NetworkError",
        "test: simulated failure deleting the phantom log object",
      );
    }
    return inner.delete(key, opts);
  },
});

describe("log retirement vs. the numbered-log create", () => {
  test("T1: a create PUT delayed across fold+retirement fails AmbiguousCommit", async () => {
    const inner = new MemoryStorage();
    await seedManifest(inner);
    const gate = gatedPutStorage(inner, logObjectKey(PREFIX, 0), "delay");

    const pausedCommit = runWithContext(MAINTENANCE_OFF, () =>
      new Writer({ storage: gate.storage, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: DOC_ID,
        body: { ...DOC_BODY },
      }),
    );

    await gate.reached;
    await seedLogEntry(inner, PREFIX, 0, { doc_id: "peer-doc", after: { _id: "peer-doc" } });
    await advanceFloorAndRetire(inner);
    gate.release();

    await expect(pausedCommit).rejects.toMatchObject({ code: "AmbiguousCommit" });
    const visible = await Db.create({ storage: inner, app: "a", tenant: "t" })
      .collection("c")
      .get(DOC_ID);
    expect(visible, "a failed commit must leave no half-visible row").toBeUndefined();
    await expect(
      inner.get(logObjectKey(PREFIX, 0)),
      "the phantom object is cleaned up best-effort",
    ).resolves.toBeNull();
  });

  test("T2: a lost-ack retry of the same seq across fold+retirement fails AmbiguousCommit", async () => {
    const inner = new MemoryStorage();
    await seedManifest(inner);
    const gate = gatedPutStorage(inner, logObjectKey(PREFIX, 0), "fail");

    const pausedCommit = runWithContext(MAINTENANCE_OFF, () =>
      new Writer({ storage: gate.storage, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: DOC_ID,
        body: { ...DOC_BODY },
      }),
    );

    await gate.reached;
    await seedLogEntry(inner, PREFIX, 0, { doc_id: "peer-doc", after: { _id: "peer-doc" } });
    await advanceFloorAndRetire(inner);
    gate.release();

    await expect(pausedCommit).rejects.toMatchObject({ code: "AmbiguousCommit" });
    const visible = await Db.create({ storage: inner, app: "a", tenant: "t" })
      .collection("c")
      .get(DOC_ID);
    expect(visible).toBeUndefined();
  });

  test("the ambiguous failure is not retriable", async () => {
    const inner = new MemoryStorage();
    await seedManifest(inner);
    const gate = gatedPutStorage(inner, logObjectKey(PREFIX, 0), "delay");

    const pausedCommit = runWithContext(MAINTENANCE_OFF, () =>
      new Writer({ storage: gate.storage, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: DOC_ID,
        body: { ...DOC_BODY },
      }),
    );
    await gate.reached;
    await seedLogEntry(inner, PREFIX, 0, { doc_id: "peer-doc", after: { _id: "peer-doc" } });
    await advanceFloorAndRetire(inner);
    gate.release();

    await expect(pausedCommit).rejects.toMatchObject({
      code: "AmbiguousCommit",
      retriable: false,
    });
  });

  test('a rejected commit records db.write.ambiguous_commit_total with cleanup="deleted"', async () => {
    const inner = new MemoryStorage();
    await seedManifest(inner);
    const gate = gatedPutStorage(inner, logObjectKey(PREFIX, 0), "delay");
    const ctx = createObservabilityContext({ maintenance: { disabled: true } });

    const pausedCommit = runWithContext(ctx, () =>
      new Writer({ storage: gate.storage, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: DOC_ID,
        body: { ...DOC_BODY },
      }),
    );

    await gate.reached;
    await seedLogEntry(inner, PREFIX, 0, { doc_id: "peer-doc", after: { _id: "peer-doc" } });
    await advanceFloorAndRetire(inner);
    gate.release();

    await expect(pausedCommit).rejects.toMatchObject({ code: "AmbiguousCommit" });
    expect(sumCounter(ctx, "db.write.ambiguous_commit_total")).toBe(1);
    const counter = ctx.recorder
      .snapshot()
      .counters.find((c) => c.name === "db.write.ambiguous_commit_total");
    expect(counter?.labels).toEqual({ collection: "c", cleanup: "deleted" });
  });

  test("a commit on a collection with a positive delete floor still succeeds at the live tail", async () => {
    const inner = new MemoryStorage();
    await seedManifest(inner);

    // Land a real commit at the live tail, with maintenance off.
    const committed = await runWithContext(MAINTENANCE_OFF, () =>
      new Writer({ storage: inner, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: DOC_ID,
        body: { ...DOC_BODY },
      }),
    );
    expect(committed.entry.seq).toBe(0);

    // Fold past it and retire as far as the window allows. At
    // LOG_RETENTION_SEQ_WINDOW = 1024 and FILLER_END = 1025 this publishes
    // log_delete_floor = 1, so seq 0 ends up below the floor, not inside
    // some "merely folded" band — there is no such band once retirement has
    // run this far. The point of this test is the *next* commit.
    await advanceFloorAndRetire(inner);
    const after = await readCurrentJson(inner, CURRENT_KEY);
    expect(after?.json.log_delete_floor).toBe(FILLER_END - LOG_RETENTION_SEQ_WINDOW);
    expect(after?.json.log_seq_start).toBe(FILLER_END);

    // A NEW commit on the same collection must not be rejected merely because
    // the collection now has a positive delete floor.
    const next = await runWithContext(MAINTENANCE_OFF, () =>
      new Writer({ storage: inner, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: "second-doc",
        body: { _id: "second-doc" },
      }),
    );
    expect(next.entry.seq).toBeGreaterThanOrEqual(FILLER_END);
    const visible = await Db.create({ storage: inner, app: "a", tenant: "t" })
      .collection("c")
      .get("second-doc");
    expect(visible).toEqual({ _id: "second-doc" });
  });

  test("a commit whose entry is folded but not yet retired still succeeds (regression: a bare logSeqStartOf(...) floor would reject this)", async () => {
    const inner = new MemoryStorage();
    await seedManifest(inner);

    let signalReached!: () => void;
    const reached = new Promise<void>((r) => {
      signalReached = r;
    });
    let signalReleased!: () => void;
    const released = new Promise<void>((r) => {
      signalReleased = r;
    });
    let slotZeroLanded = false;
    let gatedOnce = false;

    const storage: Storage = {
      list: (prefix, opts) => inner.list(prefix, opts),
      delete: (key, opts) => inner.delete(key, opts),
      async put(key, body, opts) {
        const res = await inner.put(key, body, opts);
        if (key === logObjectKey(PREFIX, 0)) {
          slotZeroLanded = true;
        }
        return res;
      },
      async get(key, opts) {
        // Stall the post-create manifest read only.
        if (key === CURRENT_KEY && slotZeroLanded && !gatedOnce) {
          gatedOnce = true;
          signalReached();
          await released;
        }
        return inner.get(key, opts);
      },
    };

    const commit = runWithContext(MAINTENANCE_OFF, () =>
      new Writer({ storage, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: DOC_ID,
        body: { ...DOC_BODY },
      }),
    );

    await reached;
    // Fold only — do NOT retire. `log_seq_start` advances to `FILLER_END`
    // while `log_delete_floor` stays 0.
    await seedLogEntries(inner, PREFIX, 1, FILLER_END);
    const folded = await compact(
      { storage: inner, currentJsonKey: CURRENT_KEY },
      { minEntriesToCompact: 1 },
    );
    expect(folded).toMatchObject({ written: true, logSeqStartAfter: FILLER_END });
    const midpoint = await readCurrentJson(inner, CURRENT_KEY);
    expect(midpoint?.json.log_seq_start).toBe(FILLER_END);
    // `log_delete_floor` is absent (never set), which decodes to 0 via
    // logDeleteFloorOf — not literally the number 0 on disk.
    expect(midpoint?.json.log_delete_floor).toBeUndefined();
    signalReleased();

    // The correct check computes min(0, FILLER_END) = 0 and hits the
    // "no deleted prefix certified" silent arm, so the commit lands. A
    // mutant that drops the `Math.min` against `storedDeleteFloor` and
    // reads a bare `logSeqStartOf(...)` would compute FILLER_END, see
    // seq 0 below it, and wrongly throw AmbiguousCommit here — that is
    // exactly the over-broad "reject anything sub-floor" behavior this
    // check must not have.
    await expect(commit).resolves.toMatchObject({ entry: { seq: 0 } });
    const visible = await Db.create({ storage: inner, app: "a", tenant: "t" })
      .collection("c")
      .get(DOC_ID);
    expect(visible).toEqual({ ...DOC_BODY });
  });

  test("an out-of-bound stored delete floor is clamped, not trusted", async () => {
    const inner = new MemoryStorage();
    // log_delete_floor > log_seq_start is readable off disk: the bound is
    // transition-scoped and assertCurrentJson checks shape only (invariant 12).
    await createCurrentJson(
      inner,
      CURRENT_KEY,
      logStateCurrentJson({ log_seq_start: 0, tail_hint: 0, log_delete_floor: 500 }),
    );

    // Clamped to min(500, 0) === 0, so the arm is silent and the commit lands.
    const committed = await runWithContext(MAINTENANCE_OFF, () =>
      new Writer({ storage: inner, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: DOC_ID,
        body: { ...DOC_BODY },
      }),
    );
    expect(committed.entry.seq).toBe(0);
    const visible = await Db.create({ storage: inner, app: "a", tenant: "t" })
      .collection("c")
      .get(DOC_ID);
    expect(visible).toEqual({ ...DOC_BODY });
  });

  test("a failed post-create manifest read skips the check instead of failing the commit", async () => {
    const inner = new MemoryStorage();
    await seedManifest(inner);

    let slotZeroLanded = false;
    let faultFired = false;

    const storage: Storage = {
      list: (prefix, opts) => inner.list(prefix, opts),
      delete: (key, opts) => inner.delete(key, opts),
      async put(key, body, opts) {
        const res = await inner.put(key, body, opts);
        if (key === logObjectKey(PREFIX, 0)) {
          slotZeroLanded = true;
        }
        return res;
      },
      async get(key, opts) {
        // Fail the POST-CREATE manifest read only. Step 1's read happens
        // before slot 0 lands, so it passes through — gating on
        // `slotZeroLanded` is what makes this exercise the floor check's own
        // read rather than aborting the commit before it ever gets there.
        if (key === CURRENT_KEY && slotZeroLanded && !faultFired) {
          faultFired = true;
          throw new BaerlyError(
            "NetworkError",
            "test: simulated failure reading current.json after the committing create",
          );
        }
        return inner.get(key, opts);
      },
    };

    // The create IS the commit. A post-commit safety-net read that blips must
    // not convert a durable write into a caller-visible failure — least of all
    // into a `retriable: true` one a generic wrapper would re-run at a fresh
    // tail, duplicating the mutation.
    const committed = await runWithContext(MAINTENANCE_OFF, () =>
      new Writer({ storage, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: DOC_ID,
        body: { ...DOC_BODY },
      }),
    );
    expect(faultFired, "the injected read fault must actually have fired").toBe(true);
    expect(committed.entry.seq).toBe(0);

    const visible = await Db.create({ storage: inner, app: "a", tenant: "t" })
      .collection("c")
      .get(DOC_ID);
    expect(visible, "the committed row is visible to a fresh reader").toEqual({ ...DOC_BODY });
  });

  test("an aborted post-create manifest read propagates instead of being swallowed", async () => {
    const inner = new MemoryStorage();
    await seedManifest(inner);

    let slotZeroLanded = false;
    let faultFired = false;

    const storage: Storage = {
      list: (prefix, opts) => inner.list(prefix, opts),
      delete: (key, opts) => inner.delete(key, opts),
      async put(key, body, opts) {
        const res = await inner.put(key, body, opts);
        if (key === logObjectKey(PREFIX, 0)) {
          slotZeroLanded = true;
        }
        return res;
      },
      async get(key, opts) {
        // Abort the POST-CREATE manifest read only, gated on `slotZeroLanded`
        // exactly as the sibling above — Step 1's read must pass through so
        // this exercises the floor check's own read.
        if (key === CURRENT_KEY && slotZeroLanded && !faultFired) {
          faultFired = true;
          const aborted = new Error("test: aborted reading current.json after the create");
          aborted.name = "AbortError";
          throw aborted;
        }
        return inner.get(key, opts);
      },
    };

    // The counterpart to the swallow above: an abort is the caller's own
    // cancellation, not a transient blip, and it is not a `retriable`
    // `BaerlyError`, so the re-run hazard that justifies swallowing a
    // `NetworkError` does not apply. Swallowing it instead reports success for
    // a cancelled call and — as the crash fuzzer showed — drives every
    // abort-at-this-GET case into the fully-landed reconciliation branch.
    await expect(
      runWithContext(MAINTENANCE_OFF, () =>
        new Writer({ storage, currentJsonKey: CURRENT_KEY }).commit({
          op: "I",
          collection: "c",
          docId: DOC_ID,
          body: { ...DOC_BODY },
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(faultFired, "the injected abort must actually have fired").toBe(true);

    // The create already landed; the abort is reported over a durable commit.
    const visible = await Db.create({ storage: inner, app: "a", tenant: "t" })
      .collection("c")
      .get(DOC_ID);
    expect(visible, "the create that preceded the abort is durable").toEqual({ ...DOC_BODY });
  });

  test("a create folded AND retired before the post-create read reports AmbiguousCommit", async () => {
    const inner = new MemoryStorage();
    await seedManifest(inner);

    let signalReached!: () => void;
    const reached = new Promise<void>((r) => {
      signalReached = r;
    });
    let signalReleased!: () => void;
    const released = new Promise<void>((r) => {
      signalReleased = r;
    });
    let slotZeroLanded = false;
    let gatedOnce = false;

    const storage: Storage = {
      list: (prefix, opts) => inner.list(prefix, opts),
      delete: (key, opts) => inner.delete(key, opts),
      async put(key, body, opts) {
        const res = await inner.put(key, body, opts);
        if (key === logObjectKey(PREFIX, 0)) {
          slotZeroLanded = true;
        }
        return res;
      },
      async get(key, opts) {
        // Stall the post-create manifest read only.
        if (key === CURRENT_KEY && slotZeroLanded && !gatedOnce) {
          gatedOnce = true;
          signalReached();
          await released;
        }
        return inner.get(key, opts);
      },
    };

    const commit = runWithContext(MAINTENANCE_OFF, () =>
      new Writer({ storage, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: DOC_ID,
        body: { ...DOC_BODY },
      }),
    );

    await reached;
    await advanceFloorAndRetire(inner);
    signalReleased();

    // The mutation IS visible — it was folded into the snapshot before
    // retirement removed the slot — and the commit still fails. That is the
    // accepted, safe-direction over-rejection: the writer cannot tell this
    // history from a phantom re-fill, so it reports at-least-once rather than
    // acknowledging on a guess.
    await expect(commit).rejects.toMatchObject({ code: "AmbiguousCommit" });
    const visible = await Db.create({ storage: inner, app: "a", tenant: "t" })
      .collection("c")
      .get(DOC_ID);
    expect(visible).toEqual({ ...DOC_BODY });
  });

  test('a phantom-object DELETE failure still throws AmbiguousCommit and records cleanup="failed"', async () => {
    const inner = new MemoryStorage();
    await seedManifest(inner);
    const phantomKey = logObjectKey(PREFIX, 0);
    const gate = gatedPutStorage(inner, phantomKey, "delay");
    const storage = withFailingDelete(gate.storage, phantomKey);
    const ctx = createObservabilityContext({ maintenance: { disabled: true } });

    const pausedCommit = runWithContext(ctx, () =>
      new Writer({ storage, currentJsonKey: CURRENT_KEY }).commit({
        op: "I",
        collection: "c",
        docId: DOC_ID,
        body: { ...DOC_BODY },
      }),
    );

    await gate.reached;
    await seedLogEntry(inner, PREFIX, 0, { doc_id: "peer-doc", after: { _id: "peer-doc" } });
    await advanceFloorAndRetire(inner);
    gate.release();

    await expect(
      pausedCommit,
      "the cleanup failure must never mask the throw",
    ).rejects.toMatchObject({ code: "AmbiguousCommit" });
    expect(sumCounter(ctx, "db.write.ambiguous_commit_total")).toBe(1);
    const counter = ctx.recorder
      .snapshot()
      .counters.find((c) => c.name === "db.write.ambiguous_commit_total");
    expect(counter?.labels).toEqual({ collection: "c", cleanup: "failed" });
  });

  /**
   * Why the answer is an explicit failure and not discard-and-re-probe.
   *
   * At the retry decision point the entire bucket is byte-for-byte identical
   * whether the writer's own create landed and was folded, or a foreign
   * writer's did. No surviving object names the writer's session. The two
   * histories require opposite outcomes — adopt the prior completion vs. place
   * the mutation at the live tail — from identical evidence, so no predicate
   * over durable state can choose between them. That is why the writer reports
   * at-least-once instead of guessing.
   */
  test("the durable state at the retry decision point cannot distinguish the two histories", async () => {
    // ── History A: the writer's own create landed at slot 0, then the ack
    // was lost, the entry was folded, and slot 0 was retired.
    const runHistoryA = async (): Promise<{
      dump: Array<[string, string]>;
      slotZeroBytes: Uint8Array;
    }> => {
      const inner = new MemoryStorage();
      await seedManifest(inner);
      let reached!: () => void;
      const reachedFirst = new Promise<void>((r) => {
        reached = r;
      });
      let release!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      let dump: Array<[string, string]> = [];
      let landedBytes: Uint8Array = new Uint8Array(0);
      let first = true;
      let secondPut = false;
      const storage: Storage = {
        get: (k, o) => inner.get(k, o),
        list: (p, o) => inner.list(p, o),
        delete: (k, o) => inner.delete(k, o),
        async put(k, b, o) {
          if (k === logObjectKey(PREFIX, 0) && first) {
            first = false;
            // Durable, then the ack is dropped.
            await inner.put(k, b, o);
            landedBytes = b;
            reached();
            await released;
            throw new BaerlyError("NetworkError", "test: dropped ack after a durable create");
          }
          if (k === logObjectKey(PREFIX, 0) && !secondPut) {
            secondPut = true;
            // Snapshot the bucket at the retry decision point.
            dump = await dumpBucket(inner);
          }
          return inner.put(k, b, o);
        },
      };
      const commit = runWithContext(MAINTENANCE_OFF, () =>
        new Writer({ storage, currentJsonKey: CURRENT_KEY }).commit({
          op: "I",
          collection: "c",
          docId: DOC_ID,
          body: { ...DOC_BODY },
        }),
      );
      await reachedFirst;
      await advanceFloorAndRetire(inner);
      release();
      await expect(commit).rejects.toMatchObject({ code: "AmbiguousCommit" });
      return { dump, slotZeroBytes: landedBytes };
    };

    const { dump: dumpA, slotZeroBytes } = await runHistoryA();

    // ── History B: the writer's create never landed. A FOREIGN writer
    // occupied slot 0 with the same logical mutation (an idempotent
    // resubmit from another node), which was then folded and retired.
    //
    // The foreign entry is derived from A's bytes with only `session` and
    // the session segment of `lsn` replaced by same-length substitutes, so
    // the two histories fold byte-identical slices.
    const runHistoryB = async (): Promise<Array<[string, string]>> => {
      const landed = decodeJsonBytes<LogEntry>(slotZeroBytes);
      const foreignSession = "f".repeat(landed.session.length);
      const foreign: LogEntry = {
        ...landed,
        session: foreignSession,
        lsn: landed.lsn.replace(landed.session, foreignSession),
      };
      expect(encodeJsonBytes(foreign).byteLength).toBe(slotZeroBytes.byteLength);

      const inner = new MemoryStorage();
      await seedManifest(inner);
      let reached!: () => void;
      const reachedFirst = new Promise<void>((r) => {
        reached = r;
      });
      let release!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      let dump: Array<[string, string]> = [];
      let first = true;
      let secondPut = false;
      const storage: Storage = {
        get: (k, o) => inner.get(k, o),
        list: (p, o) => inner.list(p, o),
        delete: (k, o) => inner.delete(k, o),
        async put(k, b, o) {
          if (k === logObjectKey(PREFIX, 0) && first) {
            first = false;
            // NOT durable — the create never happened.
            reached();
            await released;
            throw new BaerlyError(
              "NetworkError",
              "test: dropped ack on a create that never landed",
            );
          }
          if (k === logObjectKey(PREFIX, 0) && !secondPut) {
            secondPut = true;
            dump = await dumpBucket(inner);
          }
          return inner.put(k, b, o);
        },
      };
      const commit = runWithContext(MAINTENANCE_OFF, () =>
        new Writer({ storage, currentJsonKey: CURRENT_KEY }).commit({
          op: "I",
          collection: "c",
          docId: DOC_ID,
          body: { ...DOC_BODY },
        }),
      );
      await reachedFirst;
      await inner.put(logObjectKey(PREFIX, 0), encodeJsonBytes(foreign));
      await advanceFloorAndRetire(inner);
      release();
      await expect(commit).rejects.toMatchObject({ code: "AmbiguousCommit" });
      return dump;
    };

    const dumpB = await runHistoryB();

    // Non-emptiness guards: an empty-vs-empty comparison below would pass
    // vacuously and assert nothing — the exact failure mode this test exists
    // to rule out.
    expect(dumpA.length, "history A captured a bucket dump").toBeGreaterThan(0);
    expect(dumpB.length, "history B captured a bucket dump").toBeGreaterThan(0);

    // The decisive claim: nothing durable distinguishes "my create landed
    // and was folded" from "a foreign create landed and was folded".
    expect(dumpA.map(([k]) => k)).toEqual(dumpB.map(([k]) => k));
    expect(dumpA).toEqual(dumpB);
    // And no surviving object names the writer's own session.
    const ownSession = decodeJsonBytes<LogEntry>(slotZeroBytes).session;
    expect(dumpA.filter(([, body]) => body.includes(ownSession))).toEqual([]);
  });
});
