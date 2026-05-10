import { describe, expect, test } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { MPS3, type MPS3Config } from "../../src/mps3";
import {
  type JSONValue,
  type LogEntry,
  LOG_KEY_PREFIX,
  getMemoryStorageForBucket,
} from "@baerly/protocol";

const baseConfig = (label: string, bucket: string): MPS3Config => ({
  label,
  minimizeListObjectsCalls: false,
  parser: new DOMParser(),
  defaultBucket: bucket,
  offlineStorage: false,
  adaptiveClock: false,
  s3Config: { endpoint: MPS3.MEMORY_ENDPOINT },
});

// The default manifest key is "manifest.json" (see src/mps3.ts:265),
// so log entries land under "manifest.json/log/<lsn>.json". Storage
// keys are URL-encoded by `S3ClientLite.getUrl`, hence the `%2F` in
// the listing prefix.
const LOG_PREFIX = `manifest.json%2F${LOG_KEY_PREFIX}%2F`;

/**
 * List log entries for `bucket` and return them in **causal order**
 * (oldest first). Baerly's lsn encoding is descending base-32 — newer
 * entries sort lex-FIRST — so we sort by `seq` ascending to recover
 * causal order. This mirrors how `Syncer.getLatest` walks listObjectV2
 * results in reverse for the manifest log.
 *
 * Within a single mps3 session, `seq` is unique and monotonic — fine
 * for this test's single-writer scenarios.
 */
const listLogEntries = async (bucket: string): Promise<LogEntry[]> => {
  const storage = getMemoryStorageForBucket(bucket);
  if (!storage) return [];
  const entries: LogEntry[] = [];
  for await (const { key } of storage.list(LOG_PREFIX)) {
    const result = await storage.get(key);
    if (!result) continue;
    entries.push(JSON.parse(new TextDecoder().decode(result.body)) as LogEntry);
  }
  entries.sort((a, b) => a.seq - b.seq);
  return entries;
};

describe("LogEntry emission (Syncer.updateContent log-emit path)", () => {
  // No `resetMemoryStorage()` afterEach — that's a global wipe of the
  // `memoryFetchFn` singleton, which races against parallel tests
  // (e.g., randomized.test.ts) that also use the singleton. Each test
  // here uses a unique bucket, so per-bucket isolation is sufficient
  // and accumulated state is harmless.

  test("INSERT: single put produces one I entry with new === patch", async () => {
    const bucket = `le-i-${Math.random().toString(36).slice(2, 8)}`;
    const mps3 = new MPS3(baseConfig("writer", bucket));

    const body = { name: "Ada", email: "ada@x" };
    await mps3.put("users/u_42", body);

    const entries = await listLogEntries(bucket);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;

    expect(e.op).toBe("I");
    expect(e.collection).toBe("users");
    expect(e.doc_id).toBe("users/u_42");
    expect(e.new).toEqual(body);
    expect(e.patch).toEqual(body);
    expect(e.old).toBeUndefined();
    expect(e.key_old).toBeUndefined();
    expect(e.schema_version).toBe(0);
    expect(e.lsn).toMatch(/^[0-9a-v]+_[0-9a-v]+_[0-9a-v]{2}$/);
    expect(typeof e.session).toBe("string");
    expect(typeof e.seq).toBe("number");
    // commit_ts parses as a real Date.
    expect(Number.isFinite(new Date(e.commit_ts).getTime())).toBe(true);
  });

  test("INSERT then UPDATE: lex-ordered I then U entries", async () => {
    const bucket = `le-iu-${Math.random().toString(36).slice(2, 8)}`;
    const mps3 = new MPS3(baseConfig("writer", bucket));

    const v1 = { v: 1 };
    const v2 = { v: 2 };
    await mps3.put("users/u_42", v1);
    await mps3.put("users/u_42", v2);

    const entries = await listLogEntries(bucket);
    expect(entries).toHaveLength(2);

    // listLogEntries returns causal order (oldest first) via seq sort.
    const [first, second] = entries as [LogEntry, LogEntry];
    expect(first.op).toBe("I");
    expect(first.new).toEqual(v1);
    expect(second.op).toBe("U");
    expect(second.new).toEqual(v2);
    expect(second.patch).toEqual(v2);
    expect(first.seq).toBeLessThan(second.seq);
    // Descending base-32 encoding: newer lsn sorts lex-EARLIER.
    expect(first.lsn > second.lsn).toBe(true);
  });

  test("DELETE after INSERT: I then D, D has no new/patch", async () => {
    const bucket = `le-d-${Math.random().toString(36).slice(2, 8)}`;
    const mps3 = new MPS3(baseConfig("writer", bucket));

    await mps3.put("users/u_42", { v: 1 });
    await mps3.delete("users/u_42");

    const entries = await listLogEntries(bucket);
    expect(entries).toHaveLength(2);

    const [first, second] = entries as [LogEntry, LogEntry];
    expect(first.op).toBe("I");
    expect(second.op).toBe("D");
    expect(second.new).toBeUndefined();
    expect(second.patch).toBeUndefined();
    expect(second.doc_id).toBe("users/u_42");
  });

  test("flat key (no '/'): collection falls back to bucket", async () => {
    const bucket = `le-flat-${Math.random().toString(36).slice(2, 8)}`;
    const mps3 = new MPS3(baseConfig("writer", bucket));

    await mps3.put("u_42", { v: 1 });

    const entries = await listLogEntries(bucket);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.collection).toBe(bucket);
    expect(entries[0]!.doc_id).toBe("u_42");
  });

  test("multi-key putAll: one entry per mutated ref, distinct lsns", async () => {
    const bucket = `le-multi-${Math.random().toString(36).slice(2, 8)}`;
    const mps3 = new MPS3(baseConfig("writer", bucket));

    await mps3.putAll(
      new Map<string, JSONValue>([
        ["docs/a", { x: 1 }],
        ["docs/b", { x: 2 }],
        ["docs/c", { x: 3 }],
      ]),
    );

    const entries = await listLogEntries(bucket);
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(e.op).toBe("I");
      expect(e.collection).toBe("docs");
    }
    const lsns = new Set(entries.map((e) => e.lsn));
    expect(lsns.size).toBe(3);
  });
});
