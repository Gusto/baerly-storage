import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  InMemoryMetricsRecorder,
  createCurrentJson,
  getOrCreateMemoryStorageForBucket,
  MemoryStorage,
  BaerlyError,
  resetMemoryStorage,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import type { IndexDefinition } from "./indexes.ts";
import { ServerWriter } from "./server-writer.ts";

const BUCKET = "server-writer-test-bucket";
const COLL = "tickets";
const CURRENT_KEY = `app/test/tenant/t/manifests/${COLL}/current.json`;

const seedCurrent = (): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  next_seq: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
});

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

describe("ServerWriter", () => {
  beforeEach(() => {
    resetMemoryStorage();
  });

  test("single-writer happy path: one commit advances next_seq by 1", async () => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_KEY });

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
    expect(result.entry.schema_version).toBe(0);
    expect(result.entry.session).toHaveLength(6);
    expect(typeof result.entry.lsn).toBe("string");
    expect(result.entry.lsn.split("_")).toHaveLength(3);
    expect(result.entry.new).toEqual({ _id: "doc-1", title: "hello" });
    expect(result.entry.patch).toEqual({ _id: "doc-1", title: "hello" });

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

  test("CAS conflict on first attempt retries and succeeds on attempt 2", async () => {
    const storage = new InstrumentedStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    storage.failNextCasOnce = true;

    const writer = new ServerWriter({
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

    const writer = new ServerWriter({
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
    await createCurrentJson(storage, CURRENT_KEY, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 3,
      writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
      log_seq_start: 2,
    });
    const logPrefix = `app/test/tenant/t/manifests/${COLL}/log`;
    const planted = {
      lsn: "fake-lsn",
      commit_ts: new Date().toISOString(),
      op: "I" as const,
      collection: COLL,
      doc_id: "live",
      schema_version: 0,
      session: "abcdef",
      seq: 2,
      new: { _id: "live" },
      patch: { _id: "live" },
    };
    await storage.put(`${logPrefix}/2.json`, new TextEncoder().encode(JSON.stringify(planted)));

    // Opt in to the integrity walk: this test's whole point is to assert the
    // walk's range is `[log_seq_start, next_seq)`, not `[0, next_seq)`. The
    // walk is gated off by default in production (it's purely observational
    // — see `verifyLogIntegrityOnCommit` JSDoc); turning it on here keeps
    // the test exercising the invariant it claims to test.
    const writer = new ServerWriter({
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

    const w1 = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 1, random: () => 0 },
    });
    const w2 = new ServerWriter({
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
    const metrics = new InMemoryMetricsRecorder();
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { metrics, tenant: "acme" },
    });

    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1" },
    });

    const samples = metrics.histogramValues("db.write.class_a_ops_per_logical_write");
    expect(samples).toHaveLength(1);
    // content + log + current.json = 3 PUTs on first-try success.
    expect(samples[0]).toBe(3);
    // Tenant label travels.
    const hist = metrics.histograms.find(
      (h) => h.name === "db.write.class_a_ops_per_logical_write",
    );
    expect(hist?.labels).toEqual({ collection: COLL, tenant: "acme" });
    // Put-rate gauge emitted once per commit.
    expect(metrics.lastGauge("db.tenant.put_rate")).toBe(1);
  });

  test('op:"D" commit emits class_a = 2 (no content PUT)', async () => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const metrics = new InMemoryMetricsRecorder();
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { metrics },
    });

    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-d",
      body: { _id: "doc-d" },
    });
    await writer.commit({ op: "D", collection: COLL, docId: "doc-d" });

    const samples = metrics.histogramValues("db.write.class_a_ops_per_logical_write");
    expect(samples).toEqual([3, 2]);
  });

  test("emits db.r2.put.412_total on CAS conflict + retry", async () => {
    const storage = new InstrumentedStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    storage.failNextCasOnce = true;

    const metrics = new InMemoryMetricsRecorder();
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { initialBackoffMs: 1, random: () => 0, metrics },
    });

    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-cas",
      body: { _id: "doc-cas" },
    });

    // Two 412s: one on the current-json CAS (the simulated 412) and
    // one on the log-PUT during the retry (the prior attempt's log
    // entry is now present at our seq — the own-session adoption
    // path). Both are real `PreconditionFailed` responses from the
    // bucket, both are counted.
    expect(metrics.sumCounter("db.r2.put.412_total")).toBe(2);
    const cas412 = metrics.counters.find(
      (c) => c.name === "db.r2.put.412_total" && c.labels["step"] === "current-json-cas",
    );
    expect(cas412).toBeDefined();
    expect(cas412?.labels["collection"]).toBe(COLL);
    const logPut412 = metrics.counters.find(
      (c) => c.name === "db.r2.put.412_total" && c.labels["step"] === "log-put",
    );
    expect(logPut412).toBeDefined();
    // After one retry the class-A op count is 3 + 1 retry = 4.
    expect(metrics.histogramValues("db.write.class_a_ops_per_logical_write")).toEqual([4]);
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
    const metrics = new InMemoryMetricsRecorder();
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { metrics },
    });

    let thrown: unknown;
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
    // Commit propagates the NetworkError — but the 429 counter
    // bumped on the way through the catch arm.
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("NetworkError");
    expect(metrics.sumCounter("db.r2.put.429_total")).toBe(1);
  });

  test("default metrics is no-op (no observable side effect)", async () => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_KEY });
    // Pure smoke: commit succeeds without an explicit recorder.
    const r = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-noop",
      body: { _id: "doc-noop" },
    });
    expect(r.attempts).toBe(1);
  });
});

describe("ServerWriter — writer fence", () => {
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

  test("happy path: epoch unchanged across a commit → commit succeeds, no bump metric", async () => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    const metrics = new InMemoryMetricsRecorder();
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { metrics },
    });

    const r = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "doc-fence-ok",
      body: { _id: "doc-fence-ok" },
    });
    expect(r.attempts).toBe(1);
    expect(metrics.sumCounter("db.writer.fence_bump_observed_total")).toBe(0);

    const persisted = decodeJson<CurrentJson>((await storage.get(CURRENT_KEY))!.body);
    expect(persisted.writer_fence.epoch).toBe(0);
  });

  test("fence bump observed mid-flight: commit() fails fast with Conflict + metric", async () => {
    const storage = new FenceBumpingStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    // The writer's step-1 read of current.json is the first GET on
    // CURRENT_KEY; the post-CAS read is the second. Bump on the
    // second — simulates "peer claimed the fence after our CAS
    // landed but before we verified."
    storage.bumpAfterReadsCount = 2;
    const metrics = new InMemoryMetricsRecorder();
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { metrics, tenant: "acme" },
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
    expect(metrics.sumCounter("db.writer.fence_bump_observed_total")).toBe(1);
    // Tenant + collection labels travel.
    const bumpEvent = metrics.counters.find(
      (c) => c.name === "db.writer.fence_bump_observed_total",
    );
    expect(bumpEvent?.labels).toEqual({ collection: COLL, tenant: "acme" });
  });

  test("commitBatch() under fence bump: throws Conflict, increments metric exactly once", async () => {
    const storage = new FenceBumpingStorage();
    await createCurrentJson(storage, CURRENT_KEY, seedCurrent());
    storage.bumpAfterReadsCount = 2;
    const metrics = new InMemoryMetricsRecorder();
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_KEY,
      options: { metrics },
    });

    let thrown: unknown;
    try {
      await writer.commitBatch([
        { op: "I", collection: COLL, docId: "tx-1", body: { _id: "tx-1" } },
        { op: "I", collection: COLL, docId: "tx-2", body: { _id: "tx-2" } },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("Conflict");
    expect(metrics.sumCounter("db.writer.fence_bump_observed_total")).toBe(1);
  });
});

describe("ServerWriter — filtered index", () => {
  /**
   * The four U-quadrants are the load-bearing correctness gate of
   * T4. Each named test exercises ONE quadrant; collapsing them
   * would localise a regression to "filtered index broken" instead
   * of "filtered index broken in the miss→match arm." The
   * `allIndexKeysFor` short-circuit handles all four arms via the
   * writer's existing diff path (`oldKeys` vs `newKeys`) — see the
   * JSDoc above the index-emission block in `server-writer.ts`.
   */
  const FILTERED_CURRENT_KEY = `app/test/tenant/t/manifests/${COLL}/current.json`;
  const FILTERED_LOG_PREFIX = `app/test/tenant/t/manifests/${COLL}`;
  const open_only: IndexDefinition = {
    name: "open_only",
    on: "assignee",
    predicate: { status: "open" },
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

  const newFilteredWriter = async (
    metrics?: InMemoryMetricsRecorder,
  ): Promise<{ storage: MemoryStorage; writer: ServerWriter }> => {
    const storage = new MemoryStorage();
    await createCurrentJson(storage, FILTERED_CURRENT_KEY, seedCurrent());
    const writer = new ServerWriter({
      storage,
      currentJsonKey: FILTERED_CURRENT_KEY,
      options: metrics !== undefined ? { indexes: [open_only], metrics } : { indexes: [open_only] },
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
    const metrics = new InMemoryMetricsRecorder();
    const { storage, writer } = await newFilteredWriter(metrics);
    // I doc with status:"closed" → outside the filter, no keys, no
    // histogram emission for the filtered index.
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "closed", assignee: "alice" },
    });
    const indexHistogramsAfterI = metrics.histograms.filter(
      (h) => h.name === "db.write.index_ops_per_logical_write",
    );
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
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);
    const indexHistograms = metrics.histograms.filter(
      (h) => h.name === "db.write.index_ops_per_logical_write",
    );
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
    const metrics = new InMemoryMetricsRecorder();
    const { storage, writer } = await newFilteredWriter(metrics);
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "closed", assignee: "alice" },
    });
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);
    // Reset the histogram so we ONLY observe the D-quadrant's behaviour.
    metrics.histograms.length = 0;

    await writer.commit({
      op: "D",
      collection: COLL,
      docId: "t-1",
    });
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);
    const indexHistograms = metrics.histograms.filter(
      (h) => h.name === "db.write.index_ops_per_logical_write",
    );
    expect(indexHistograms).toEqual([]);
  });
});
