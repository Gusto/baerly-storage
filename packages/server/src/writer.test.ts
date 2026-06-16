import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  type LogEntry,
  createCurrentJson,
  getOrCreateMemoryStorageForBucket,
  MAINTENANCE_MIN_LIVE_BYTES,
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  MemoryStorage,
  BaerlyError,
  resetMemoryStorage,
  str2uintDesc,
  type StoragePutOptions,
  type StoragePutResult,
  TIMESTAMP_BIT_WIDTH,
  WRITE_TICK_GC_INTERVAL,
} from "@baerly/protocol";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { logStateCurrentJson, seedLogEntry } from "../../../tests/fixtures/log-state.ts";
import type { IndexDefinition } from "./indexes.ts";
import type { MaintenanceDispatch } from "./maintenance.ts";
import {
  createObservabilityContext,
  type ObservabilityContext,
  runWithContext,
} from "./observability/index.ts";
import { Writer } from "./writer.ts";

const histogramValues = (ctx: ObservabilityContext, name: string): number[] =>
  ctx.recorder
    .snapshot()
    .histograms.filter((h) => h.name === name)
    .map((h) => h.value);

const sumCounter = (ctx: ObservabilityContext, name: string): number =>
  ctx.recorder
    .snapshot()
    .counters.filter((c) => c.name === name)
    .reduce((acc, c) => acc + c.value, 0);

const BUCKET = "writer-test-bucket";
const COLL = "tickets";
const CURRENT_KEY = `app/test/tenant/t/manifests/${COLL}/current.json`;
const LOG_PREFIX = `app/test/tenant/t/manifests/${COLL}/log`;

const seedCurrent = (): CurrentJson => logStateCurrentJson();

const decodeJson = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

/** Count the durable log seqs under the manifest prefix. */
const durableLogSeqs = async (storage: MemoryStorage): Promise<number[]> => {
  const prefix = `app/test/tenant/t/manifests/${COLL}/log/`;
  const seqs: number[] = [];
  for await (const entry of storage.list(prefix)) {
    const m = /\/log\/(\d+)\.json$/.exec(entry.key);
    if (m !== null) {
      seqs.push(Number(m[1]));
    }
  }
  return seqs.toSorted((a, b) => a - b);
};

/**
 * Test-only `MemoryStorage` subclass that injects 412 failures on the
 * `log/<seq>` CREATE — the single-write-commit linearization point — so
 * the retry path is exercised by a FOREIGN-session occupant. The first
 * failed create lands a foreign entry at the contended seq so the
 * writer's read-back sees `foreign-session` and re-probes forward. Local
 * to this test file — NOT exported from `@baerly/server`.
 */
class InstrumentedStorage extends MemoryStorage {
  failNextLogCreateOnce = false;
  /** Plant a foreign occupant + 412 on the next N log creates, then stop. */
  failLogCreates = 0;
  casAttempts = 0;

  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    const isLogCreate = /\/log\/\d+\.json$/.test(key) && opts?.ifNoneMatch !== undefined;
    if (isLogCreate && (this.failLogCreates > 0 || this.failNextLogCreateOnce)) {
      this.failNextLogCreateOnce = false;
      if (this.failLogCreates > 0) {
        this.failLogCreates -= 1;
      }
      this.casAttempts += 1;
      // Land a FOREIGN-session entry at this seq, then surface 412 — the
      // writer reads it back, sees a foreign session, and re-probes
      // forward (or, with failEveryLogCreate, eventually exhausts).
      const foreign = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
      foreign["session"] = "INTRUDR0";
      await super.put(key, new TextEncoder().encode(JSON.stringify(foreign)), opts);
      throw new BaerlyError("Conflict", `simulated 412 on ${key}: precondition failed`);
    }
    return super.put(key, body, opts);
  }
}

class LostAckStorage extends MemoryStorage {
  dropNextLogCreateAck = false;

  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    const isLogCreate = /\/log\/\d+\.json$/.test(key) && opts?.ifNoneMatch !== undefined;
    if (isLogCreate && this.dropNextLogCreateAck) {
      this.dropNextLogCreateAck = false;
      await super.put(key, body, opts);
      throw new BaerlyError("NetworkError", `simulated dropped ack on ${key}`);
    }
    return super.put(key, body, opts);
  }
}

class SameSessionDifferentBodyStorage extends MemoryStorage {
  collideNextLogCreate = false;

  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    const isLogCreate = /\/log\/\d+\.json$/.test(key) && opts?.ifNoneMatch !== undefined;
    if (isLogCreate && this.collideNextLogCreate) {
      this.collideNextLogCreate = false;
      const attempted = decodeJson<LogEntry>(body);
      const forged: LogEntry = {
        ...attempted,
        doc_id: "same-session-intruder",
        after: { _id: "same-session-intruder", from: "collision" },
      };
      await super.put(key, new TextEncoder().encode(JSON.stringify(forged)), opts);
      throw new BaerlyError("Conflict", `simulated same-session collision on ${key}`);
    }
    return super.put(key, body, opts);
  }
}

describe("Writer", () => {
  beforeEach(() => {
    resetMemoryStorage();
  });

  test("single-writer happy path: one commit creates log/0 (the commit)", async () => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    const result = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    expect(result.attempts).toBe(1);
    expect(result.entry.seq).toBe(0);
    expect(result.entry.op).toBe("I");
    expect(result.entry.collection).toBe(COLL);
    expect(result.entry.doc_id).toBe("doc-1");
    expect(result.entry.session).toHaveLength(6);
    expect(typeof result.entry.lsn).toBe("string");
    expect(result.entry.lsn.split("_")).toHaveLength(3);
    expect(result.entry.after).toEqual({ _id: "doc-1", title: "hello" });

    // Single-write commit: the writer does NOT touch current.json — the
    // numbered log create IS the commit, so tail_hint stays at its
    // stored (compactor-advanced) value. The discovered tail is 1.
    const stored = await storage.get(CURRENT_KEY);
    expect(stored).not.toBeNull();
    const persisted = decodeJson<CurrentJson>(stored!.body);
    expect(persisted.tail_hint).toBe(0);
    expect(persisted.writer_fence.epoch).toBe(0);
    await expect(durableLogSeqs(storage)).resolves.toEqual([0]);

    const logEntry = await storage.get(`app/test/tenant/t/manifests/${COLL}/log/0.json`);
    expect(logEntry).not.toBeNull();
    const persistedEntry = decodeJson<typeof result.entry>(logEntry!.body);
    expect(persistedEntry.seq).toBe(0);
    expect(persistedEntry.doc_id).toBe("doc-1");
  });

  test("lsn timestamp and commit_ts derive from a single clock instant", async () => {
    // Regression for the dual-clock-read foot-gun: `lsn` (timestamp(ms))
    // and `commit_ts` (new Date().toISOString()) must come from ONE
    // `Date.now()` read, so jitter can't push them onto different ms —
    // a reader validates `commit_ts` against `LAG_WINDOW_MILLIS`, and
    // two independent reads could straddle that band. Decode the lsn's
    // descending-base-32 timestamp prefix back to epoch ms and assert it
    // equals the parsed `commit_ts`.
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    const result = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    const [lsnPrefix] = result.entry.lsn.split("_");
    const lsnMs = str2uintDesc(lsnPrefix!, TIMESTAMP_BIT_WIDTH);
    expect(lsnMs).toBe(Date.parse(result.entry.commit_ts));
  });

  test("fresh storage: first commit auto-provisions current.json zero-shot", async () => {
    // No `createCurrentJson` seed — the writer must handle the empty
    // bucket itself, otherwise zero-shot `db.collection().insert(...)`
    // from a brand-new R2 bucket / LocalFs root crashes with
    // "current.json missing".
    const storage = new MemoryStorage();
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    const result = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    expect(result.attempts).toBe(1);
    expect(result.entry.seq).toBe(0);

    const stored = await storage.get(CURRENT_KEY);
    expect(stored).not.toBeNull();
    const persisted = decodeJson<CurrentJson>(stored!.body);
    expect(persisted.schema_version).toBe(CURRENT_JSON_SCHEMA_VERSION);
    expect(persisted.snapshot).toBeNull();
    // Auto-provision seeds tail_hint=0; the commit creates log/0 but does
    // NOT advance the stored hint (single-write commit).
    expect(persisted.tail_hint).toBe(0);
    expect(persisted.log_seq_start).toBe(0);
    expect(persisted.writer_fence.epoch).toBe(0);
    expect(persisted.writer_fence.owner).toBe("");
    await expect(durableLogSeqs(storage)).resolves.toEqual([0]);

    // Second commit on the same writer reuses the now-existing
    // manifest — no double-provision.
    const second = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-2",
      body: { _id: "doc-2", title: "world" },
    });
    expect(second.entry.seq).toBe(1);
  });

  test("fresh storage race: two writers contending the first write both succeed", async () => {
    // Two writers point at the same `currentJsonKey` and both see
    // null on the initial read. One wins the `If-None-Match: "*"`
    // create; the other recovers via re-read and proceeds. Both
    // commits must land successfully — the loser's retry budget
    // absorbs the CAS-conflict on `current.json` once the first
    // writer's manifest is in place.
    const storage = getOrCreateMemoryStorageForBucket(BUCKET);
    const writerA = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 1, random: () => 0 },
    });
    const writerB = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 1, random: () => 0 },
    });

    const [a, b] = await Promise.all([
      writerA.commit({
        op: "I",
        collection: COLL,
        docId: "doc-A",
        body: { _id: "doc-A", title: "from A" },
      }),
      writerB.commit({
        op: "I",
        collection: COLL,
        docId: "doc-B",
        body: { _id: "doc-B", title: "from B" },
      }),
    ]);

    const seqs = new Set([a.entry.seq, b.entry.seq]);
    expect(seqs).toEqual(new Set([0, 1]));
    // The discovered tail is 2; the writer doesn't advance the stored hint.
    await expect(durableLogSeqs(storage)).resolves.toEqual([0, 1]);
  });

  test("log-create 412 (foreign session): re-probes forward and commits at the next slot", async () => {
    const storage = new InstrumentedStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    storage.failNextLogCreateOnce = true;

    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 1, random: () => 0 },
    });

    const result = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-2",
      body: { _id: "doc-2" },
    });

    // The foreign occupant landed at seq 0; the writer re-probed forward
    // and committed at seq 1 WITHIN a single attempt (the forward-probe
    // loop is internal to #singleAttemptCommit — no commit() retry).
    expect(result.attempts).toBe(1);
    expect(result.entry.seq).toBe(1);
    await expect(durableLogSeqs(storage)).resolves.toEqual([0, 1]);
  });

  test("repeated foreign occupants: writer probes past them and commits — no wedge", async () => {
    const storage = new InstrumentedStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    // Three consecutive foreign occupants land at seq 0,1,2; the writer
    // probes past each and commits cleanly at seq 3. The old two-write
    // protocol would have wedged on the first orphan.
    storage.failLogCreates = 3;

    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { maxRetries: 3, initialBackoffMs: 1, random: () => 0 },
    });

    const result = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "survivor",
      body: { _id: "survivor" },
    });

    expect(result.entry.seq).toBe(3);
    expect(storage.casAttempts).toBe(3);
    await expect(durableLogSeqs(storage)).resolves.toEqual([0, 1, 2, 3]);
  });

  test("lost ack on log create adopts the same-session same-intent entry", async () => {
    const storage = new LostAckStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    storage.dropNextLogCreateAck = true;
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 0, random: () => 0 },
    });

    const result = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "lost-ack",
      body: { _id: "lost-ack", from: "writer" },
    });

    expect(result.entry.seq).toBe(0);
    expect(result.entry.doc_id).toBe("lost-ack");
    await expect(durableLogSeqs(storage)).resolves.toEqual([0]);
  });

  test("same-session same-seq different body is not adopted", async () => {
    const storage = new SameSessionDifferentBodyStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    storage.collideNextLogCreate = true;
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 0, random: () => 0 },
    });

    const result = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "writer-doc",
      body: { _id: "writer-doc", from: "writer" },
    });

    expect(result.entry.seq).toBe(1);
    expect(result.entry.doc_id).toBe("writer-doc");
    const planted = decodeJson<LogEntry>((await storage.get(`${LOG_PREFIX}/0.json`))!.body);
    expect(planted.doc_id).toBe("same-session-intruder");
    await expect(durableLogSeqs(storage)).resolves.toEqual([0, 1]);
  });

  test("commit() walks [log_seq_start, tail_hint) — entries below the bound are NOT GET-required", async () => {
    // Bootstrap with tail_hint=3 and log_seq_start=2, then plant ONLY
    // log/2.json on the bucket. The writer must not GET log/0.json or
    // log/1.json (which don't exist); if it did, `#walkLog` would throw
    // `Internal` for "missing log entry, protocol invariant violation".
    const storage = new MemoryStorage();
    await createCurrentJson(
      storage,
      CURRENT_KEY,
      logStateCurrentJson({ tail_hint: 3, log_seq_start: 2 }),
    );
    const manifestPrefix = `app/test/tenant/t/manifests/${COLL}`;
    await seedLogEntry(storage, manifestPrefix, 2, {
      lsn: "fake-lsn",
      commit_ts: new Date().toISOString(),
      collection: COLL,
      doc_id: "live",
      session: "abcdef",
      after: { _id: "live" },
    });

    // Opt in to the integrity walk: this test's whole point is to assert the
    // walk's range is `[log_seq_start, tail_hint)`, not `[0, tail_hint)`. The
    // walk is gated off by default in production (it's purely observational
    // — see `verifyLogIntegrityOnCommit` JSDoc); turning it on here keeps
    // the test exercising the invariant it claims to test.
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { verifyLogIntegrityOnCommit: true },
    });
    const result = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "new-doc",
      body: { _id: "new-doc" },
    });

    expect(result.attempts).toBe(1);
    expect(result.entry.seq).toBe(3);

    // The writer no longer touches current.json: tail_hint and
    // log_seq_start are BOTH preserved; the new entry lands at log/3.
    const stored = await storage.get(CURRENT_KEY);
    const persisted = decodeJson<CurrentJson>(stored!.body);
    expect(persisted.tail_hint).toBe(3);
    expect(persisted.log_seq_start).toBe(2);
    await expect(durableLogSeqs(storage)).resolves.toEqual([2, 3]);
  });

  test("two concurrent writers: both succeed and leave a dense log", async () => {
    const storage = getOrCreateMemoryStorageForBucket(BUCKET);
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());

    const w1 = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 1, random: () => 0 },
    });
    const w2 = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 1, random: () => 0 },
    });

    const [r1, r2] = await Promise.all([
      w1.commit({
        op: "I",
        collection: COLL,
        docId: "doc-a",
        body: { _id: "doc-a" },
      }),
      w2.commit({
        op: "I",
        collection: COLL,
        docId: "doc-b",
        body: { _id: "doc-b" },
      }),
    ]);

    expect(r1.entry.seq).not.toBe(r2.entry.seq);
    const seqs = [r1.entry.seq, r2.entry.seq].toSorted();
    expect(seqs).toEqual([0, 1]);
    // At least one writer won outright on its first attempt.
    expect(Math.min(r1.attempts, r2.attempts)).toBe(1);

    // Both log entries persisted, no gaps (the discovered tail is 2; the
    // writer doesn't advance the stored hint).
    await expect(durableLogSeqs(storage)).resolves.toEqual([0, 1]);
  });

  test("emits db.write.class_a_ops_per_logical_write histogram per commit", async () => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const ctx = createObservabilityContext();
    await runWithContext(ctx, async () => {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: "doc-1",
        body: { _id: "doc-1" },
      });
    });

    const samples = histogramValues(ctx, "db.write.class_a_ops_per_logical_write");
    expect(samples).toHaveLength(1);
    // content + log = 2 PUTs on first-try success (no current.json CAS).
    expect(samples[0]).toBe(2);
    // Collection label travels.
    const hist = ctx.recorder
      .snapshot()
      .histograms.find((h) => h.name === "db.write.class_a_ops_per_logical_write");
    expect(hist?.labels).toEqual({ collection: COLL });
  });

  test('op:"D" commit emits class_a = 1 (no content PUT, no current.json CAS)', async () => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const ctx = createObservabilityContext();
    await runWithContext(ctx, async () => {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: "doc-d",
        body: { _id: "doc-d" },
      });
      await writer.commit({ op: "D", collection: COLL, docId: "doc-d" });
    });

    // I = content + log = 2; D = log only = 1 (no content, no CAS).
    const samples = histogramValues(ctx, "db.write.class_a_ops_per_logical_write");
    expect(samples).toEqual([2, 1]);
  });

  test("emits db.r2.put.412_total on a log-create conflict + forward re-probe", async () => {
    const storage = new InstrumentedStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    storage.failNextLogCreateOnce = true;

    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 1, random: () => 0 },
    });

    const ctx = createObservabilityContext();
    await runWithContext(ctx, async () => {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: "doc-cas",
        body: { _id: "doc-cas" },
      });
    });

    // One 412 on the log-create (a foreign occupant landed at our seq);
    // the writer read it back and re-probed forward. No current-json CAS
    // exists anymore.
    expect(sumCounter(ctx, "db.r2.put.412_total")).toBe(1);
    const counters = ctx.recorder.snapshot().counters;
    const logPut412 = counters.find(
      (c) => c.name === "db.r2.put.412_total" && c.labels["step"] === "log-put",
    );
    expect(logPut412).toBeDefined();
    expect(logPut412?.labels["collection"]).toBe(COLL);
    // Class-A on the winning attempt: content + log = 2 (the foreign
    // create that 412'd is not billed; the forward-probe GETs are Class B).
    expect(histogramValues(ctx, "db.write.class_a_ops_per_logical_write")).toEqual([2]);
  });

  test("emits db.r2.put.429_total when storage surfaces a 429 NetworkError", async () => {
    class ThrottlingStorage extends MemoryStorage {
      thrown = false;
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        // Throttle the first content PUT only.
        if (!this.thrown && /\/content\//.test(key)) {
          this.thrown = true;
          throw new BaerlyError("NetworkError", `S3: throttled on ${key}`, { status: 429 });
        }
        return super.put(key, body, opts);
      }
    }
    const storage = new ThrottlingStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    const ctx = createObservabilityContext();
    let thrown: unknown;
    await runWithContext(ctx, async () => {
      try {
        await writer.commit({
          op: "I",
          collection: COLL,
          docId: "doc-429",
          body: { _id: "doc-429" },
        });
      } catch (error) {
        thrown = error;
      }
    });
    // Commit propagates the NetworkError — but the 429 counter
    // bumped on the way through the catch arm.
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("NetworkError");
    expect(sumCounter(ctx, "db.r2.put.429_total")).toBe(1);
  });

  test("outside any observability context emissions are no-ops", async () => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    // Pure smoke: commit succeeds without an active context.
    const r = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-noop",
      body: { _id: "doc-noop" },
    });
    expect(r.attempts).toBe(1);
  });
});

describe("Writer — writer fence", () => {
  beforeEach(() => {
    resetMemoryStorage();
  });

  /**
   * Bumps `writer_fence.epoch` on `current.json` exactly once, on
   * the K-th `get` of the CAS key (after the writer's step-1 read
   * but before/at its post-commit point). Local to this test
   * file.
   */
  class FenceBumpingStorage extends MemoryStorage {
    bumpAfterReadsCount = -1; // -1 = never
    private currentReads = 0;
    override async get(
      key: string,
      opts?: { signal?: AbortSignal },
    ): Promise<{ body: Uint8Array; etag: string } | null> {
      const result = await super.get(key, opts);
      if (key === CURRENT_KEY && result !== null) {
        this.currentReads++;
        if (this.currentReads === this.bumpAfterReadsCount) {
          const decoded = JSON.parse(new TextDecoder().decode(result.body)) as CurrentJson;
          decoded.writer_fence = {
            ...decoded.writer_fence,
            epoch: decoded.writer_fence.epoch + 1,
            owner: "intruder",
          };
          // Sneak the bump under our own existing etag — simulates
          // a peer's claimWriter() that landed between our step-1
          // read and our step-6 post-read. The bumped body is also
          // returned to the caller so the verify-read sees the new
          // epoch on the very GET that triggered the bump.
          const bumpedBytes = new TextEncoder().encode(JSON.stringify(decoded));
          await super.put(key, bumpedBytes);
          const fresh = await super.get(key, opts);
          if (fresh !== null) {
            return fresh;
          }
        }
      }
      return result;
    }
  }

  test("happy path: epoch unchanged across a commit → commit succeeds", async () => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
    });

    const r = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-fence-ok",
      body: { _id: "doc-fence-ok" },
    });
    expect(r.attempts).toBe(1);

    const persisted = decodeJson<CurrentJson>((await storage.get(CURRENT_KEY))!.body);
    expect(persisted.writer_fence.epoch).toBe(0);
  });

  test("fence bump no longer aborts a committed write (post-commit verify removed)", async () => {
    const storage = new FenceBumpingStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    // Arm the bump on the SECOND current.json GET. With the old
    // post-commit fence-verify, that second GET was the verify read: it
    // observed the bumped epoch and threw Conflict on a log/<seq> entry
    // that had ALREADY committed and was visible — a committed-but-
    // Conflict inconsistency. Under single-write commit the numbered log
    // create IS the commit and there is no verify read, so the commit
    // succeeds; the entry is durable.
    storage.bumpAfterReadsCount = 2;
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
    });

    const r = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-fence-bumped",
      body: { _id: "doc-fence-bumped" },
    });
    expect(r.attempts).toBe(1);

    // The log entry (the commit) is durable on the bucket.
    const seqs = await durableLogSeqs(storage);
    expect(seqs).toEqual([0]);
    const persistedEntry = decodeJson<LogEntry>((await storage.get(`${LOG_PREFIX}/0.json`))!.body);
    expect(persistedEntry.doc_id).toBe("doc-fence-bumped");
  });
});

describe("Writer — filtered index", () => {
  /**
   * The four U-quadrants are the load-bearing correctness gate of
   * T4. Each named test exercises ONE quadrant; collapsing them
   * would localise a regression to "filtered index broken" instead
   * of "filtered index broken in the miss→match arm." The
   * `allIndexKeysFor` short-circuit handles all four arms via the
   * writer's existing diff path (`oldKeys` vs `newKeys`) — see the
   * JSDoc above the index-emission block in `writer.ts`.
   */
  const FILTERED_CURRENT_KEY = `app/test/tenant/t/manifests/${COLL}/current.json`;
  const FILTERED_LOG_PREFIX = `app/test/tenant/t/manifests/${COLL}`;
  const open_only: IndexDefinition = {
    name: "open_only",
    on: "assignee",
    predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
  };

  class PostCommitIndexCleanupFailureStorage extends MemoryStorage {
    failPreImageRead = false;
    failIndexDelete = false;
    private armedAfterLogCreate = false;
    private preImageReadThrown = false;

    arm(): void {
      this.armedAfterLogCreate = false;
      this.preImageReadThrown = false;
    }

    override async put(
      key: string,
      body: Uint8Array,
      opts?: StoragePutOptions,
    ): Promise<StoragePutResult> {
      const result = await super.put(key, body, opts);
      if (key.includes("/log/") && key.endsWith(".json") && opts?.ifNoneMatch !== undefined) {
        this.armedAfterLogCreate = true;
      }
      return result;
    }

    override async get(
      key: string,
      opts?: { ifNoneMatch?: string; versionId?: string; signal?: AbortSignal },
    ): Promise<{ body: Uint8Array; etag: string; versionId?: string } | null> {
      if (
        this.armedAfterLogCreate &&
        this.failPreImageRead &&
        !this.preImageReadThrown &&
        key.endsWith("/log/0.json")
      ) {
        this.preImageReadThrown = true;
        throw new BaerlyError("NetworkError", `simulated pre-image read failure on ${key}`);
      }
      return super.get(key, opts);
    }

    override async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
      if (this.armedAfterLogCreate && this.failIndexDelete && /\/index\//.test(key)) {
        throw new BaerlyError("NetworkError", `simulated index delete failure on ${key}`);
      }
      return super.delete(key, opts);
    }
  }

  beforeEach(() => {
    resetMemoryStorage();
  });

  const listFilteredKeys = async (storage: MemoryStorage): Promise<string[]> => {
    const out: string[] = [];
    for await (const entry of storage.list(`${FILTERED_LOG_PREFIX}/index/${open_only.name}/`)) {
      out.push(entry.key);
    }
    return out.toSorted();
  };

  const newFilteredWriter = async (): Promise<{ storage: MemoryStorage; writer: Writer }> => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, FILTERED_CURRENT_KEY, seedCurrent());
    const writer = new Writer({
      storage,
      currentJsonKey: FILTERED_CURRENT_KEY,
      options: { indexes: [open_only] },
    });
    return { storage, writer };
  };

  const newCleanupFailureWriter = async (): Promise<{
    storage: PostCommitIndexCleanupFailureStorage;
    writer: Writer;
  }> => {
    const storage = new PostCommitIndexCleanupFailureStorage();
    await createCurrentJson(storage, FILTERED_CURRENT_KEY, seedCurrent());
    const writer = new Writer({
      storage,
      currentJsonKey: FILTERED_CURRENT_KEY,
      options: { indexes: [open_only] },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", assignee: "alice" },
    });
    storage.arm();
    return { storage, writer };
  };

  test("I: filter-match emits one key", async () => {
    const { storage, writer } = await newFilteredWriter();
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", assignee: "alice" },
    });
    const keys = await listFilteredKeys(storage);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(`/${open_only.name}/`);
    expect(keys[0]!.endsWith("/t-1.json")).toBe(true);
  });

  test("I: filter-miss emits zero keys", async () => {
    const { storage, writer } = await newFilteredWriter();
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "closed", assignee: "alice" },
    });
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);
  });

  test("U: filter-match → filter-match diffs keys as today", async () => {
    const { storage, writer } = await newFilteredWriter();
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", assignee: "alice" },
    });
    const before = await listFilteredKeys(storage);
    expect(before).toHaveLength(1);

    // Both pre-image and post-image match the filter; the diff path
    // DELETEs the old `alice` key and PUTs the new `bob` key.
    await writer.commit({
      op: "U",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", assignee: "bob" },
    });
    const after = await listFilteredKeys(storage);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]); // assignee changed
    expect(after[0]!.endsWith("/t-1.json")).toBe(true);
  });

  test("U: post-commit pre-image read failure records a metric and does not reject commit", async () => {
    const { storage, writer } = await newCleanupFailureWriter();
    storage.failPreImageRead = true;
    const ctx = createObservabilityContext();

    const result = await runWithContext(ctx, () =>
      writer.commit({
        op: "U",
        collection: COLL,
        docId: "t-1",
        body: { _id: "t-1", status: "open", assignee: "bob" },
      }),
    );

    expect(result.entry.seq).toBe(1);
    expect(result.entry.doc_id).toBe("t-1");
    await expect(durableLogSeqs(storage)).resolves.toEqual([0, 1]);
    expect(sumCounter(ctx, "db.write.index_cleanup_errors_total")).toBe(1);
    const cleanupCounter = ctx.recorder
      .snapshot()
      .counters.find((c) => c.name === "db.write.index_cleanup_errors_total");
    expect(cleanupCounter?.labels).toEqual({ collection: COLL, step: "pre-image-read" });
  });

  test("U: post-commit stale-index delete failure records a metric and does not reject commit", async () => {
    const { storage, writer } = await newCleanupFailureWriter();
    storage.failIndexDelete = true;
    const ctx = createObservabilityContext();

    const result = await runWithContext(ctx, () =>
      writer.commit({
        op: "U",
        collection: COLL,
        docId: "t-1",
        body: { _id: "t-1", status: "open", assignee: "bob" },
      }),
    );

    expect(result.entry.seq).toBe(1);
    expect(result.entry.doc_id).toBe("t-1");
    await expect(durableLogSeqs(storage)).resolves.toEqual([0, 1]);
    expect(sumCounter(ctx, "db.write.index_cleanup_errors_total")).toBe(1);
    const cleanupCounter = ctx.recorder
      .snapshot()
      .counters.find((c) => c.name === "db.write.index_cleanup_errors_total");
    expect(cleanupCounter?.labels).toEqual({ collection: COLL, step: "delete" });
  });

  test("U: filter-match → filter-miss DELETEs all old keys, emits no PUTs", async () => {
    const { storage, writer } = await newFilteredWriter();
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", assignee: "alice" },
    });
    await expect(listFilteredKeys(storage)).resolves.toHaveLength(1);

    // Post-image transitions OUT of the filter — all old keys gone,
    // zero new keys land.
    await writer.commit({
      op: "U",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "closed", assignee: "alice" },
    });
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);
  });

  test("U: filter-miss → filter-match emits all PUTs, no DELETEs", async () => {
    const { storage, writer } = await newFilteredWriter();
    // I doc with status:"closed" → outside the filter, no keys.
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "closed", assignee: "alice" },
    });
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);

    // U that transitions INTO the filter → one PUT, zero DELETEs.
    await writer.commit({
      op: "U",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", assignee: "alice" },
    });
    const keys = await listFilteredKeys(storage);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(`/${open_only.name}/`);
    expect(keys[0]!.endsWith("/t-1.json")).toBe(true);
  });

  test("U: filter-miss → filter-miss is a no-op for the filtered index", async () => {
    const { storage, writer } = await newFilteredWriter();
    const ctx = createObservabilityContext();
    await runWithContext(ctx, async () => {
      // I doc with status:"closed" → outside the filter, no keys, no
      // histogram emission for the filtered index.
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: "t-1",
        body: { _id: "t-1", status: "closed", assignee: "alice" },
      });
      const indexHistogramsAfterI = ctx.recorder
        .snapshot()
        .histograms.filter((h) => h.name === "db.write.index_ops_per_logical_write");
      expect(indexHistogramsAfterI).toEqual([]);

      // U keeps the doc outside the filter — still no keys, still no
      // histogram. The writer's guard
      // `newKeys.length + staleKeys.length > 0` must fire.
      await writer.commit({
        op: "U",
        collection: COLL,
        docId: "t-1",
        body: { _id: "t-1", status: "wip", assignee: "bob" },
      });
    });
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);
    const indexHistograms = ctx.recorder
      .snapshot()
      .histograms.filter((h) => h.name === "db.write.index_ops_per_logical_write");
    expect(indexHistograms).toEqual([]);
  });

  test("D: filter-match pre-image DELETEs the keys", async () => {
    const { storage, writer } = await newFilteredWriter();
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", assignee: "alice" },
    });
    await expect(listFilteredKeys(storage)).resolves.toHaveLength(1);

    await writer.commit({
      op: "D",
      collection: COLL,
      docId: "t-1",
    });
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);
  });

  test("D: filter-miss pre-image is a no-op", async () => {
    const { storage, writer } = await newFilteredWriter();
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "closed", assignee: "alice" },
    });
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);

    // Wrap only the D commit so its observations are the only ones
    // visible to the assertion.
    const ctx = createObservabilityContext();
    await runWithContext(ctx, async () => {
      await writer.commit({
        op: "D",
        collection: COLL,
        docId: "t-1",
      });
    });
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);
    const indexHistograms = ctx.recorder
      .snapshot()
      .histograms.filter((h) => h.name === "db.write.index_ops_per_logical_write");
    expect(indexHistograms).toEqual([]);
  });
});

describe("Writer — write-tick maintenance dispatch", () => {
  beforeEach(() => {
    resetMemoryStorage();
  });

  /**
   * A recording dispatch that captures each maintenance task WITHOUT
   * running it. The writer hook reads `getCurrentContext()?.maintenance
   * ?.dispatch` at the post-commit point; a no-run spy lets these tests
   * assert the writer's DISPATCH DECISION (did it fire? how many times?)
   * in isolation from `runBoundedMaintenance`'s own behaviour. The
   * runner's effect is exercised separately by the default-inline test
   * below.
   */
  const recordingDispatch = (): {
    maintenance: MaintenanceDispatch;
    calls: () => number;
  } => {
    const spy = vi.fn<(task: () => Promise<void>) => void>(() => {
      // Intentionally do NOT invoke the task — we measure the dispatch
      // decision, not the runner.
    });
    return { maintenance: { dispatch: spy }, calls: () => spy.mock.calls.length };
  };

  const persisted = async (storage: MemoryStorage): Promise<CurrentJson> =>
    decodeJson<CurrentJson>((await storage.get(CURRENT_KEY))!.body);

  /** Seed `current.json` with explicit byte/row/seq state. */
  const seedWith = async (
    storage: MemoryStorage,
    overrides: Partial<CurrentJson>,
  ): Promise<void> => {
    await createCurrentJson(storage, CURRENT_KEY, { ...seedCurrent(), ...overrides });
  };

  // (1) / (1b) DELETED: under single-write commit the writer no longer
  // touches current.json. The live-tail size that drives maintenance is
  // the DERIVED `estimateTailBytes`, exercised by tests (2)/(5)/(6)/(7)
  // below via the observed tail.

  test("(2) a single commit DISPATCHES runBoundedMaintenance when the fold ratio (Gate 1) trips", async () => {
    // Seed so the DERIVED ratio `estimateTailBytes / max(snapshot_bytes,
    // MIN_LIVE) >= 1` trips on a NON-boundary write (prevSeq 1 → tail_hint 2
    // with interval 4 crosses no boundary). The trigger reads the estimate
    // `(tail_hint − log_seq_start) × mean_entry_bytes`, NOT the exact
    // A stamped mean drives it: 2 live entries ×
    // MIN_LIVE bytes/entry far exceeds the floored denominator ⇒ ratio ≫ 1.
    // THE blocking-bug regression: a ratio-tripping write must dispatch.
    const storage = new MemoryStorage();
    await seedWith(storage, {
      tail_hint: 1,
      mean_entry_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const { maintenance, calls } = recordingDispatch();

    await runWithContext(createObservabilityContext({ maintenance }), () =>
      writer.commit({ op: "I", collection: COLL, docId: "doc-r", body: { _id: "doc-r" } }),
    );

    expect(calls()).toBe(1);
  });

  test("(4) a commit that re-probes past a foreign log-create conflict dispatches EXACTLY once", async () => {
    // The dispatch sits at the success point inside #singleAttemptCommit,
    // reached once per logical commit. A foreign occupant makes the
    // create loop re-probe forward (still ONE attempt), and the single
    // winning create dispatches exactly once.
    const storage = new InstrumentedStorage();
    await createCurrentJson(storage, CURRENT_KEY, {
      ...seedCurrent(),
      tail_hint: 1,
      mean_entry_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
    });
    storage.failNextLogCreateOnce = true;
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 1, random: () => 0 },
    });
    const { maintenance, calls } = recordingDispatch();

    const r = await runWithContext(createObservabilityContext({ maintenance }), () =>
      writer.commit({ op: "I", collection: COLL, docId: "doc-retry", body: { _id: "doc-retry" } }),
    );

    // The re-probe is internal to one attempt — no commit() retry.
    expect(r.attempts).toBe(1);
    expect(r.entry.seq).toBe(2);
    expect(calls()).toBe(1);
  });

  test("(5) a below-Gate-1 commit that CROSSES a GC-cadence boundary still dispatches", async () => {
    // prevSeq 3 → tail_hint 4 with interval 4 crosses the boundary
    // (floor(3/4)=0 ≠ floor(4/4)=1). Ratio is well below 1 (tiny tail,
    // huge snapshot), so the dispatch is driven purely by GC cadence —
    // proving GC isn't re-coupled to the fold threshold.
    const storage = new MemoryStorage();
    await seedWith(storage, {
      tail_hint: 3,
      snapshot_bytes: 10 * MAINTENANCE_MIN_LIVE_BYTES,
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const { maintenance, calls } = recordingDispatch();

    await runWithContext(createObservabilityContext({ maintenance }), () =>
      writer.commit({ op: "I", collection: COLL, docId: "doc-b", body: { _id: "doc-b" } }),
    );

    // The writer doesn't advance the stored hint; the commit lands at
    // log/3 (probed from tail_hint=3). The dispatch is driven by the
    // in-memory observed tail (seq+1=4) crossing the GC cadence boundary.
    const after5 = await persisted(storage);
    expect(after5.tail_hint).toBe(3);
    await expect(durableLogSeqs(storage)).resolves.toEqual([3]);
    expect(calls()).toBe(1);
  });

  test("(6) a below-Gate-1 commit that does NOT cross a boundary dispatches ZERO times", async () => {
    // prevSeq 0 → tail_hint 1, interval 4: floor(0/4)=0 = floor(1/4)=0, no
    // boundary. Ratio far below 1. Nothing fires.
    const storage = new MemoryStorage();
    await seedWith(storage, {
      tail_hint: 0,
      snapshot_bytes: 10 * MAINTENANCE_MIN_LIVE_BYTES,
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const { maintenance, calls } = recordingDispatch();

    await runWithContext(createObservabilityContext({ maintenance }), () =>
      writer.commit({ op: "I", collection: COLL, docId: "doc-n", body: { _id: "doc-n" } }),
    );

    // prevSeq 0 → observedTail 1, no boundary crossed; the writer does
    // not advance the stored hint either.
    const after6 = await persisted(storage);
    expect(after6.tail_hint).toBe(0);
    await expect(durableLogSeqs(storage)).resolves.toEqual([0]);
    expect(calls()).toBe(0);
  });

  test("(7) sequential single commits crossing a gcInterval boundary dispatch on the boundary", async () => {
    // interval 4, prevSeq 3. Each commit advances tail_hint by 1, so the
    // commit landing at tail_hint 4 crosses the boundary (floor(3/4)=0 ≠
    // floor(4/4)=1) and dispatches; the commits landing at 5 and 6 do
    // not. The floor-based crossesGcBoundary is what pins the crossing —
    // a naive `tail_hint % interval === 0` endpoint test would behave the
    // same here at N=1, but the floor form stays correct for any step.
    const storage = new MemoryStorage();
    await seedWith(storage, {
      tail_hint: 3,
      snapshot_bytes: 10 * MAINTENANCE_MIN_LIVE_BYTES,
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const { maintenance, calls } = recordingDispatch();

    await runWithContext(createObservabilityContext({ maintenance }), async () => {
      for (let i = 0; i < 3; i++) {
        await writer.commit({ op: "I", collection: COLL, docId: `j${i}`, body: { _id: `j${i}` } });
      }
    });

    // The writer doesn't advance the stored hint; the three commits land
    // at log/3,4,5 (probed forward each time). The discovered tail is 6.
    const after7 = await persisted(storage);
    expect(after7.tail_hint).toBe(3);
    await expect(durableLogSeqs(storage)).resolves.toEqual([3, 4, 5]);
    expect(WRITE_TICK_GC_INTERVAL).toBe(4); // pins the boundary arithmetic above
    // Exactly one of the three commits (the one whose observed tail
    // crosses seq 4) crosses the cadence boundary.
    expect(calls()).toBe(1);
  });

  test("(8) a fresh collection (snapshot_bytes 0) dispatches on the boundary but the runner does NOT fold below the first-fold threshold", async () => {
    // No dispatch override → default `dispatchInlineAwaited` runs the
    // real `runBoundedMaintenance` inline. With only a handful of small
    // entries the tail is far below MAINTENANCE_MIN_LIVE_BYTES and the
    // entry floor (WRITE_TICK_MIN_ENTRIES_TO_COMPACT=50), so Gate 1 is
    // false: the runner may GC on the cadence boundary but must NOT fold
    // — log_seq_start stays 0.
    const storage = new MemoryStorage();
    await seedWith(storage, {});
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    // Four small commits → seq 0..4; the 4th (prevSeq 3 → tail_hint 4)
    // crosses the GC boundary and runs maintenance inline.
    await runWithContext(createObservabilityContext(), async () => {
      for (let i = 0; i < 4; i++) {
        await writer.commit({ op: "I", collection: COLL, docId: `f${i}`, body: { _id: `f${i}` } });
      }
    });

    // Below the first-fold threshold (tail far under 64 KB, well under 50
    // entries) the runner must not fold: it never CAS-advances
    // current.json, so tail_hint AND log_seq_start stay at their seed (0)
    // — the discovered tail is 4 (log/0..3).
    const after = await persisted(storage);
    expect(after.tail_hint).toBe(0);
    await expect(durableLogSeqs(storage)).resolves.toEqual([0, 1, 2, 3]);
    expect(after.log_seq_start).toBe(0);
    expect(after.snapshot).toBeNull();
  });

  test("(9) the GC-cadence invariant holds: the discovered tail advances by exactly 1 per commit", async () => {
    // Under single-write commit the stored hint is compactor-only, so the
    // cadence invariant is on the DISCOVERED tail (the committed seq + 1):
    // each commit creates exactly one log entry at the dense tail.
    const storage = new MemoryStorage();
    await seedWith(storage, {});
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    const beforeSeqs = await durableLogSeqs(storage);
    const before = beforeSeqs.length;
    const r1 = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "inv-1",
      body: { _id: "inv-1" },
    });
    const afterOneSeqs = await durableLogSeqs(storage);
    const afterOne = afterOneSeqs.length;
    expect(afterOne - before).toBe(1);
    expect(r1.entry.seq).toBe(0);

    // Three sequential single-doc commits add exactly 3 dense entries.
    await writer.commit({ op: "I", collection: COLL, docId: "inv-2", body: { _id: "inv-2" } });
    await writer.commit({ op: "I", collection: COLL, docId: "inv-3", body: { _id: "inv-3" } });
    const r4 = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "inv-4",
      body: { _id: "inv-4" },
    });
    const afterThreeSeqs = await durableLogSeqs(storage);
    expect(afterThreeSeqs.length - afterOne).toBe(3);
    expect(r4.entry.seq).toBe(3);
    await expect(durableLogSeqs(storage)).resolves.toEqual([0, 1, 2, 3]);
  });

  test("(10) maintenance.disabled skips fold/GC dispatch until tail_hint refresh is due", async () => {
    // `disabled: true` suppresses fold/GC, but the writer still dispatches
    // when the tail_hint gap reaches the refresh threshold so a
    // maintenance-off collection does not drift past the probe cap.
    const storage = new MemoryStorage();
    await seedWith(storage, {
      tail_hint: 1,
      mean_entry_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const spy = vi.fn<(task: () => Promise<void>) => void>(() => {});

    await runWithContext(
      createObservabilityContext({ maintenance: { dispatch: spy, disabled: true } }),
      () => writer.commit({ op: "I", collection: COLL, docId: "doc-x", body: { _id: "doc-x" } }),
    );

    expect(spy.mock.calls.length).toBe(0);

    const refreshDueStorage = new MemoryStorage();
    await seedWith(refreshDueStorage, {
      tail_hint: 0,
      mean_entry_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
    });
    const refreshDueWriter = new Writer({
      storage: refreshDueStorage,
      currentJsonKey: CURRENT_KEY,
    });
    const manifestPrefix = `app/test/tenant/t/manifests/${COLL}`;
    for (let i = 0; i < MAINTENANCE_TAIL_HINT_REFRESH_WRITES - 1; i++) {
      await seedLogEntry(refreshDueStorage, manifestPrefix, i, {
        lsn: `z_seed_${i}`,
        commit_ts: "2026-05-01T00:00:00.000Z",
        collection: COLL,
        doc_id: `seed-${i}`,
        session: "seed",
        after: { _id: `seed-${i}` },
      });
    }
    await runWithContext(
      createObservabilityContext({ maintenance: { dispatch: spy, disabled: true } }),
      () =>
        refreshDueWriter.commit({
          op: "I",
          collection: COLL,
          docId: "doc-refresh",
          body: { _id: "doc-refresh" },
        }),
    );

    expect(spy.mock.calls.length).toBe(1);
  });

  test("over-long assembled key surfaces as InvalidConfig, not a storage error", async () => {
    // Each path segment is ≤256 bytes (vetted by assertPathSegment), but
    // their sum overflows S3/R2's 1024-byte full-key ceiling. The content
    // key `<prefix>/content/<hash>.json` is the first PUT to overflow; the
    // guard must reject it EARLY as InvalidConfig rather than let the PUT
    // succeed silently on memory (or fail late as an opaque provider 400).
    const seg = "s".repeat(250);
    const overLongKey = `app/${seg}/tenant/${seg}/manifests/${seg}/${seg}/current.json`;
    const storage = new MemoryStorage();
    await createCurrentJson(storage, overLongKey, seedCurrent());
    const writer = new Writer({ storage, currentJsonKey: overLongKey });

    await expect(
      writer.commit({ op: "I", collection: COLL, docId: "doc-1", body: { _id: "doc-1" } }),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("commit rejects a traversal-shaped docId as InvalidConfig, not a storage error", async () => {
    // `Writer.commit` runs `assertDocId(input.docId)` as its first
    // statement so every commit caller (the public write path AND a
    // direct caller like `baerly admin restore`) is covered. A `".."`
    // docId would otherwise write a traversal-shaped index/log key —
    // reject it EARLY as InvalidConfig, before any PUT lands.
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    await expect(
      writer.commit({ op: "I", collection: COLL, docId: "..", body: { _id: ".." } }),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("commit rejects a control-char docId as InvalidConfig, not a storage error", async () => {
    // A `_id` carrying a C0 control char (here `\u0000`) is rejected by
    // the same `assertDocId` guard inside `commit` before any key is
    // assembled or any PUT issued.
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    const badId = "doc\u0000evil";
    await expect(
      writer.commit({ op: "I", collection: COLL, docId: badId, body: { _id: badId } }),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
  });
});
