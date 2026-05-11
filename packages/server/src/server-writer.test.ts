import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  createCurrentJson,
  getOrCreateMemoryStorageForBucket,
  MemoryStorage,
  MPS3Error,
  resetMemoryStorage,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { ServerWriter } from "./server-writer";

const BUCKET = "server-writer-test-bucket";
const COLL = "tickets";
const CURRENT_KEY = `app/test/tenant/t/manifests/${COLL}/current.json`;

const seedCurrent = (): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  next_seq: 0,
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
        throw new MPS3Error("InvalidResponse", `PreconditionFailed: simulated CAS 412 on ${key}`);
      }
      if (this.failNextCasOnce) {
        this.failNextCasOnce = false;
        throw new MPS3Error("InvalidResponse", `PreconditionFailed: simulated CAS 412 on ${key}`);
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

  test("retries exhausted: throws MPS3Error code='Conflict' after maxRetries", async () => {
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
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MPS3Error);
    expect((thrown as MPS3Error).code).toBe("Conflict");
    expect(storage.casAttempts).toBe(3);

    const stored = await storage.get(CURRENT_KEY);
    const persisted = decodeJson<CurrentJson>(stored!.body);
    expect(persisted.next_seq).toBe(0);
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
});
