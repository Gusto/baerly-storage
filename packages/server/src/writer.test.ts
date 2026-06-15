import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  createCurrentJson,
  encodeJsonBytes,
  getOrCreateMemoryStorageForBucket,
  MAINTENANCE_MIN_LIVE_BYTES,
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

const seedCurrent = (): CurrentJson => logStateCurrentJson();

const decodeJson = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

/**
 * Test-only `MemoryStorage` subclass that injects CAS failures on
 * `current.json` to exercise the retry path. Local to this test file
 * — NOT exported from `@baerly/server`.
 */
class InstrumentedStorage extends MemoryStorage {
  failNextCasOnce = false;
  failEveryCas = false;
  casAttempts = 0;

  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    if (key === CURRENT_KEY && opts?.ifMatch !== undefined) {
      this.casAttempts += 1;
      if (this.failEveryCas) {
        throw new BaerlyError("Conflict", `simulated CAS 412 on ${key}: precondition failed`);
      }
      if (this.failNextCasOnce) {
        this.failNextCasOnce = false;
        throw new BaerlyError("Conflict", `simulated CAS 412 on ${key}: precondition failed`);
      }
    }
    return super.put(key, body, opts);
  }
}

describe("Writer", () => {
  beforeEach(() => {
    resetMemoryStorage();
  });

  test("single-writer happy path: one commit advances next_seq by 1", async () => {
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

    const stored = await storage.get(CURRENT_KEY);
    expect(stored).not.toBeNull();
    const persisted = decodeJson<CurrentJson>(stored!.body);
    expect(persisted.next_seq).toBe(1);
    expect(persisted.writer_fence.epoch).toBe(0);

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
    expect(persisted.next_seq).toBe(1);
    expect(persisted.log_seq_start).toBe(0);
    expect(persisted.writer_fence.epoch).toBe(0);
    expect(persisted.writer_fence.owner).toBe("");

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
    const persisted = decodeJson<CurrentJson>((await storage.get(CURRENT_KEY))!.body);
    expect(persisted.next_seq).toBe(2);
  });

  test("CAS conflict on first attempt retries and succeeds on attempt 2", async () => {
    const storage = new InstrumentedStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    storage.failNextCasOnce = true;

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

    expect(result.attempts).toBe(2);
    expect(result.entry.seq).toBe(0);

    const stored = await storage.get(CURRENT_KEY);
    const persisted = decodeJson<CurrentJson>(stored!.body);
    expect(persisted.next_seq).toBe(1);
  });

  test("retries exhausted: throws BaerlyError code='Conflict' after maxRetries", async () => {
    const storage = new InstrumentedStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    storage.failEveryCas = true;

    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { maxRetries: 3, initialBackoffMs: 1, random: () => 0 },
    });

    let thrown: unknown;
    try {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: "doomed",
        body: { _id: "doomed" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("Conflict");
    expect(storage.casAttempts).toBe(3);

    const stored = await storage.get(CURRENT_KEY);
    const persisted = decodeJson<CurrentJson>(stored!.body);
    expect(persisted.next_seq).toBe(0);
  });

  test("commit() walks [log_seq_start, next_seq) — entries below the bound are NOT GET-required", async () => {
    // Bootstrap with next_seq=3 and log_seq_start=2, then plant ONLY
    // log/2.json on the bucket. The writer must not GET log/0.json or
    // log/1.json (which don't exist); if it did, `#walkLog` would throw
    // `Internal` for "missing log entry, protocol invariant violation".
    const storage = new MemoryStorage();
    await createCurrentJson(
      storage,
      CURRENT_KEY,
      logStateCurrentJson({ next_seq: 3, log_seq_start: 2 }),
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
    // walk's range is `[log_seq_start, next_seq)`, not `[0, next_seq)`. The
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

    // log_seq_start MUST be preserved across the CAS-advance.
    const stored = await storage.get(CURRENT_KEY);
    const persisted = decodeJson<CurrentJson>(stored!.body);
    expect(persisted.next_seq).toBe(4);
    expect(persisted.log_seq_start).toBe(2);
  });

  test("two concurrent writers: both succeed and next_seq advances by 2", async () => {
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

    const stored = await storage.get(CURRENT_KEY);
    const persisted = decodeJson<CurrentJson>(stored!.body);
    expect(persisted.next_seq).toBe(2);

    // Both log entries persisted, no gaps.
    const logPrefix = `app/test/tenant/t/manifests/${COLL}/log`;
    const log0 = await storage.get(`${logPrefix}/0.json`);
    const log1 = await storage.get(`${logPrefix}/1.json`);
    expect(log0).not.toBeNull();
    expect(log1).not.toBeNull();
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
    // content + log + current.json = 3 PUTs on first-try success.
    expect(samples[0]).toBe(3);
    // Collection label travels.
    const hist = ctx.recorder
      .snapshot()
      .histograms.find((h) => h.name === "db.write.class_a_ops_per_logical_write");
    expect(hist?.labels).toEqual({ collection: COLL });
  });

  test('op:"D" commit emits class_a = 2 (no content PUT)', async () => {
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

    const samples = histogramValues(ctx, "db.write.class_a_ops_per_logical_write");
    expect(samples).toEqual([3, 2]);
  });

  test("emits db.r2.put.412_total on CAS conflict + retry", async () => {
    const storage = new InstrumentedStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    storage.failNextCasOnce = true;

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

    // Two 412s: one on the current-json CAS (the simulated 412) and
    // one on the log-PUT during the retry (the prior attempt's log
    // entry is now present at our seq — the own-session adoption
    // path). Both are real `PreconditionFailed` responses from the
    // bucket, both are counted.
    expect(sumCounter(ctx, "db.r2.put.412_total")).toBe(2);
    const counters = ctx.recorder.snapshot().counters;
    const cas412 = counters.find(
      (c) => c.name === "db.r2.put.412_total" && c.labels["step"] === "current-json-cas",
    );
    expect(cas412).toBeDefined();
    expect(cas412?.labels["collection"]).toBe(COLL);
    const logPut412 = counters.find(
      (c) => c.name === "db.r2.put.412_total" && c.labels["step"] === "log-put",
    );
    expect(logPut412).toBeDefined();
    // After one retry the class-A op count is 3 + 1 retry = 4.
    expect(histogramValues(ctx, "db.write.class_a_ops_per_logical_write")).toEqual([4]);
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
   * but before/at its post-CAS verify read). Local to this test
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

  test("fence bump observed mid-flight: commit() fails fast with Conflict", async () => {
    const storage = new FenceBumpingStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    // The writer's step-1 read of current.json is the first GET on
    // CURRENT_KEY; the post-CAS read is the second. Bump on the
    // second — simulates "peer claimed the fence after our CAS
    // landed but before we verified."
    storage.bumpAfterReadsCount = 2;
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
    });

    let thrown: unknown;
    try {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: "doc-staled",
        body: { _id: "doc-staled" },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("Conflict");
    expect((thrown as BaerlyError).message).toMatch(/writer fence bumped from epoch 0 to 1/);
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
   * ?.dispatch` at the post-CAS point; a no-run spy lets these tests
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

  test("(1) a single commit accumulates tail_bytes by exactly the committed entry's encoded byte length", async () => {
    const storage = new MemoryStorage();
    await seedWith(storage, {});
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    const result = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    // The writer PUTs `encodeJsonBytes(entry)` per entry; tail_bytes must
    // grow by exactly that, counted the same way the compactor subtracts.
    const expectedBytes = encodeJsonBytes(result.entry).byteLength;
    const after = await persisted(storage);
    expect(after.tail_bytes).toBe(expectedBytes);
    expect(after.next_seq).toBe(1);
  });

  test("(1b) tail_bytes accumulates across multiple commits", async () => {
    const storage = new MemoryStorage();
    await seedWith(storage, {});
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    const r1 = await writer.commit({ op: "I", collection: COLL, docId: "d1", body: { _id: "d1" } });
    const r2 = await writer.commit({ op: "I", collection: COLL, docId: "d2", body: { _id: "d2" } });

    const expected = encodeJsonBytes(r1.entry).byteLength + encodeJsonBytes(r2.entry).byteLength;
    const after = await persisted(storage);
    expect(after.tail_bytes).toBe(expected);
  });

  test("(2) a single commit DISPATCHES runBoundedMaintenance when the fold ratio (Gate 1) trips", async () => {
    // Seed so the ratio `tail_bytes / max(snapshot_bytes, MIN_LIVE) >= 1`
    // trips on a NON-boundary write (prevSeq 1 → next_seq 2 with
    // interval 4 crosses no boundary). With snapshot_bytes 0 the
    // denominator floors to MAINTENANCE_MIN_LIVE_BYTES, so tail_bytes at
    // the threshold trips the ratio. THE blocking-bug regression: a
    // ratio-tripping write must dispatch maintenance.
    const storage = new MemoryStorage();
    await seedWith(storage, {
      next_seq: 1,
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const { maintenance, calls } = recordingDispatch();

    await runWithContext(createObservabilityContext({ maintenance }), () =>
      writer.commit({ op: "I", collection: COLL, docId: "doc-r", body: { _id: "doc-r" } }),
    );

    expect(calls()).toBe(1);
  });

  test("(4) a commit that retries past one CAS conflict dispatches EXACTLY once", async () => {
    // The dispatch sits at the success point inside #singleAttemptCommit,
    // reached once per logical commit (a failed attempt throws before the
    // dispatch; only the winning attempt dispatches).
    const storage = new InstrumentedStorage();
    await createCurrentJson(storage, CURRENT_KEY, {
      ...seedCurrent(),
      next_seq: 1,
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
    });
    storage.failNextCasOnce = true;
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 1, random: () => 0 },
    });
    const { maintenance, calls } = recordingDispatch();

    const r = await runWithContext(createObservabilityContext({ maintenance }), () =>
      writer.commit({ op: "I", collection: COLL, docId: "doc-retry", body: { _id: "doc-retry" } }),
    );

    expect(r.attempts).toBe(2);
    expect(calls()).toBe(1);
  });

  test("(5) a below-Gate-1 commit that CROSSES a GC-cadence boundary still dispatches", async () => {
    // prevSeq 3 → next_seq 4 with interval 4 crosses the boundary
    // (floor(3/4)=0 ≠ floor(4/4)=1). Ratio is well below 1 (tiny tail,
    // huge snapshot), so the dispatch is driven purely by GC cadence —
    // proving GC isn't re-coupled to the fold threshold.
    const storage = new MemoryStorage();
    await seedWith(storage, {
      next_seq: 3,
      tail_bytes: 10,
      snapshot_bytes: 10 * MAINTENANCE_MIN_LIVE_BYTES,
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const { maintenance, calls } = recordingDispatch();

    await runWithContext(createObservabilityContext({ maintenance }), () =>
      writer.commit({ op: "I", collection: COLL, docId: "doc-b", body: { _id: "doc-b" } }),
    );

    const after5 = await persisted(storage);
    expect(after5.next_seq).toBe(4);
    expect(calls()).toBe(1);
  });

  test("(6) a below-Gate-1 commit that does NOT cross a boundary dispatches ZERO times", async () => {
    // prevSeq 0 → next_seq 1, interval 4: floor(0/4)=0 = floor(1/4)=0, no
    // boundary. Ratio far below 1. Nothing fires.
    const storage = new MemoryStorage();
    await seedWith(storage, {
      next_seq: 0,
      tail_bytes: 10,
      snapshot_bytes: 10 * MAINTENANCE_MIN_LIVE_BYTES,
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const { maintenance, calls } = recordingDispatch();

    await runWithContext(createObservabilityContext({ maintenance }), () =>
      writer.commit({ op: "I", collection: COLL, docId: "doc-n", body: { _id: "doc-n" } }),
    );

    const after6 = await persisted(storage);
    expect(after6.next_seq).toBe(1);
    expect(calls()).toBe(0);
  });

  test("(7) sequential single commits crossing a gcInterval boundary dispatch on the boundary", async () => {
    // interval 4, prevSeq 3. Each commit advances next_seq by 1, so the
    // commit landing at next_seq 4 crosses the boundary (floor(3/4)=0 ≠
    // floor(4/4)=1) and dispatches; the commits landing at 5 and 6 do
    // not. The floor-based crossesGcBoundary is what pins the crossing —
    // a naive `next_seq % interval === 0` endpoint test would behave the
    // same here at N=1, but the floor form stays correct for any step.
    const storage = new MemoryStorage();
    await seedWith(storage, {
      next_seq: 3,
      tail_bytes: 10,
      snapshot_bytes: 10 * MAINTENANCE_MIN_LIVE_BYTES,
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const { maintenance, calls } = recordingDispatch();

    await runWithContext(createObservabilityContext({ maintenance }), async () => {
      for (let i = 0; i < 3; i++) {
        await writer.commit({ op: "I", collection: COLL, docId: `j${i}`, body: { _id: `j${i}` } });
      }
    });

    const after7 = await persisted(storage);
    expect(after7.next_seq).toBe(6);
    expect(WRITE_TICK_GC_INTERVAL).toBe(4); // pins the boundary arithmetic above
    // Exactly one of the three commits (the one landing at next_seq 4)
    // crosses the cadence boundary.
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

    // Four small commits → seq 0..4; the 4th (prevSeq 3 → next_seq 4)
    // crosses the GC boundary and runs maintenance inline.
    await runWithContext(createObservabilityContext(), async () => {
      for (let i = 0; i < 4; i++) {
        await writer.commit({ op: "I", collection: COLL, docId: `f${i}`, body: { _id: `f${i}` } });
      }
    });

    const after = await persisted(storage);
    expect(after.next_seq).toBe(4);
    // Below the first-fold threshold (tail far under 64 KB, well under 50
    // entries) the runner must not fold: log_seq_start unchanged.
    expect(after.log_seq_start).toBe(0);
    expect(after.snapshot).toBeNull();
  });

  test("(9) the GC-cadence invariant holds: next_seq advances by exactly 1 per commit", async () => {
    const storage = new MemoryStorage();
    await seedWith(storage, {});
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });

    const beforeState = await persisted(storage);
    const before = beforeState.next_seq;
    await writer.commit({ op: "I", collection: COLL, docId: "inv-1", body: { _id: "inv-1" } });
    const afterOneState = await persisted(storage);
    const afterOne = afterOneState.next_seq;
    expect(afterOne - before).toBe(1);

    // Three sequential single-doc commits advance next_seq by 3.
    await writer.commit({ op: "I", collection: COLL, docId: "inv-2", body: { _id: "inv-2" } });
    await writer.commit({ op: "I", collection: COLL, docId: "inv-3", body: { _id: "inv-3" } });
    await writer.commit({ op: "I", collection: COLL, docId: "inv-4", body: { _id: "inv-4" } });
    const afterThreeState = await persisted(storage);
    const afterThree = afterThreeState.next_seq;
    expect(afterThree - afterOne).toBe(3);
  });

  test("(10) maintenance.disabled on the context suppresses dispatch entirely", async () => {
    // Belt-and-suspenders: even with the ratio tripping, `disabled: true`
    // skips the dispatch path. (Used by bare-write cost-shape tests.)
    const storage = new MemoryStorage();
    await seedWith(storage, {
      next_seq: 1,
      tail_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
    });
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    const spy = vi.fn<(task: () => Promise<void>) => void>(() => {});

    await runWithContext(
      createObservabilityContext({ maintenance: { dispatch: spy, disabled: true } }),
      () => writer.commit({ op: "I", collection: COLL, docId: "doc-x", body: { _id: "doc-x" } }),
    );

    expect(spy.mock.calls.length).toBe(0);
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
