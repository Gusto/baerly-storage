/**
 * Characterization: binding calls `r2BindingStorage` issues behind ONE
 * outer `Storage` call. The adapter has no retry loop, so get / put /
 * delete are exactly one binding call each — success or failure. `list`
 * is one `bucket.list` per page, so an outer meter that counts one
 * `list` per call (`wrapCountingStorage`, `observableStorage`) undercounts
 * by the page count.
 *
 * Plain unit tests over a fake binding — runs in the default vitest
 * project, like `r2-binding-storage.test.ts`.
 */

import { type BaerlyError, createCurrentJson, S3_REQUEST_MAX_RETRIES } from "@baerly/protocol";
import { Writer } from "@baerly/server/_internal/testing";
import { describe, expect, test } from "vitest";
import { wrapCountingStorage } from "../../../tests/fixtures/counting-storage.ts";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";

const NETWORK_ERROR = "NetworkError" as const;
const AMBIGUOUS_COMMIT = "AmbiguousCommit" as const;

interface FakePage {
  readonly keys: readonly string[];
  readonly truncated: boolean;
}

interface BindingCalls {
  get: number;
  put: number;
  delete: number;
  list: R2ListOptions[];
}

/**
 * A minimal `R2Bucket` counting every binding call. `list` replays
 * `pages` in order; `failing` makes get / put / delete reject with a
 * plain `Error` (mapped to `NetworkError` by the adapter).
 */
const mkBucket = (
  pages: readonly FakePage[] = [],
  failing = false,
): { bucket: R2Bucket; calls: BindingCalls } => {
  const calls: BindingCalls = { get: 0, put: 0, delete: 0, list: [] };
  const fail = () => Promise.reject(new Error("internal error"));
  const object = { key: "k", etag: "e", uploaded: new Date(0) };
  const bucket = {
    get: () => {
      calls.get++;
      return failing
        ? fail()
        : Promise.resolve({ ...object, body: {}, arrayBuffer: async () => new ArrayBuffer(1) });
    },
    put: () => {
      calls.put++;
      return failing ? fail() : Promise.resolve(object);
    },
    delete: () => {
      calls.delete++;
      return failing ? fail() : Promise.resolve();
    },
    list: (opts: R2ListOptions) => {
      calls.list.push(opts);
      const page = pages[calls.list.length - 1]!;
      return Promise.resolve({
        objects: page.keys.map((key) => ({ key, etag: "e" })),
        truncated: page.truncated,
        cursor: page.truncated ? `tok${calls.list.length}` : undefined,
      });
    },
  } as unknown as R2Bucket;
  return { bucket, calls };
};

const drain = async (iter: AsyncIterable<{ key: string }>): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of iter) {
    out.push(e.key);
  }
  return out;
};

describe("r2BindingStorage request accounting", () => {
  test("get / put / delete succeed with exactly one binding call each", async () => {
    const { bucket, calls } = mkBucket();
    const counted = wrapCountingStorage(r2BindingStorage(bucket));
    await counted.storage.get("k");
    await counted.storage.put("k", new Uint8Array([1]), { ifNoneMatch: "*" });
    await counted.storage.delete("k");
    expect([counted.gets, counted.puts, counted.deletes]).toEqual([1, 1, 1]);
    expect([calls.get, calls.put, calls.delete]).toEqual([1, 1, 1]);
  });

  test("a failing get / put / delete is one binding call — no adapter retries", async () => {
    const { bucket, calls } = mkBucket([], true);
    const counted = wrapCountingStorage(r2BindingStorage(bucket));
    for (const op of [
      () => counted.storage.get("k"),
      () => counted.storage.put("k", new Uint8Array([1]), { ifNoneMatch: "*" }),
      () => counted.storage.delete("k"),
    ]) {
      const err = (await op().catch((error: unknown) => error)) as BaerlyError;
      expect(err.code).toBe(NETWORK_ERROR);
    }
    expect([counted.gets, counted.puts, counted.deletes]).toEqual([1, 1, 1]);
    expect([calls.get, calls.put, calls.delete]).toEqual([1, 1, 1]);
  });

  test("3 pages — outer meter sees 1 list, binding sees 3", async () => {
    const pages = [
      { keys: ["p/a"], truncated: true },
      { keys: ["p/b"], truncated: true },
      { keys: ["p/c"], truncated: false },
    ];
    const { bucket, calls } = mkBucket(pages);
    const counted = wrapCountingStorage(r2BindingStorage(bucket));
    await expect(drain(counted.storage.list("p/"))).resolves.toEqual(["p/a", "p/b", "p/c"]);
    expect(counted.lists).toBe(1);
    expect(calls.list).toHaveLength(pages.length);
  });

  test("an exactly-full truncated page at maxKeys stops without a follow-up call", async () => {
    const { bucket, calls } = mkBucket([{ keys: ["p/a", "p/b"], truncated: true }]);
    const counted = wrapCountingStorage(r2BindingStorage(bucket));
    await expect(drain(counted.storage.list("p/", { maxKeys: 2 }))).resolves.toEqual([
      "p/a",
      "p/b",
    ]);
    expect(counted.lists).toBe(1);
    expect(calls.list).toHaveLength(1);
  });

  test("an empty truncated page costs another call — outer 1 list, binding sees 3", async () => {
    const pages = [
      { keys: [], truncated: true },
      { keys: [], truncated: true },
      { keys: ["p/a"], truncated: false },
    ];
    const { bucket, calls } = mkBucket(pages);
    const counted = wrapCountingStorage(r2BindingStorage(bucket));
    await expect(
      drain(counted.storage.list("p/", { maxKeys: 5, startAfter: "p/" })),
    ).resolves.toEqual(["p/a"]);
    expect(counted.lists).toBe(1);
    expect(calls.list).toHaveLength(pages.length);
    expect(calls.list[1]?.cursor).toBe("tok1");
  });
});

// ── Writer commit over r2BindingStorage ─────────────────────────────────

const CURRENT_KEY = "app/test/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/test/tenant/t/manifests/tickets/log/";

/** What the fault hook does to one log-create binding `put`. */
type LogPutFault = "pass" | "throw" | "land-then-throw";

/**
 * An in-memory `R2Bucket` honoring the `onlyIf` shapes the adapter
 * sends, counting binding `get` / `put` per key class. `logPutFault`
 * sees the 0-based ordinal of log-key `put`s once armed.
 */
const memBucket = (logPutFault: (ordinal: number) => LogPutFault) => {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const calls = { logGets: 0, logPuts: 0, otherGets: 0, otherPuts: 0 };
  let version = 0;
  let armed = false;
  const isLog = (key: string) => key.startsWith(LOG_PREFIX);
  const meta = (key: string, etag: string) => ({ key, etag, uploaded: new Date(0) });
  const store = (key: string, value: Uint8Array) => {
    const etag = `v${++version}`;
    objects.set(key, { bytes: new Uint8Array(value), etag });
    return meta(key, etag);
  };
  const bucket = {
    get: (key: string, opts?: R2GetOptions) => {
      if (isLog(key)) {
        calls.logGets++;
      } else {
        calls.otherGets++;
      }
      const obj = objects.get(key);
      if (obj === undefined) {
        return Promise.resolve(null);
      }
      const onlyIf = opts?.onlyIf as R2Conditional | undefined;
      if (onlyIf?.etagDoesNotMatch === obj.etag) {
        return Promise.resolve(meta(key, obj.etag));
      }
      return Promise.resolve({
        ...meta(key, obj.etag),
        body: {},
        arrayBuffer: async () => obj.bytes.slice().buffer,
      });
    },
    put: (key: string, value: Uint8Array, opts?: R2PutOptions) => {
      const fault = armed && isLog(key) ? logPutFault(calls.logPuts) : "pass";
      if (isLog(key)) {
        calls.logPuts++;
      } else {
        calls.otherPuts++;
      }
      if (fault === "throw") {
        return Promise.reject(new Error("internal error"));
      }
      const onlyIf = opts?.onlyIf as R2Conditional | undefined;
      const existing = objects.get(key);
      if (onlyIf?.etagDoesNotMatch === "*" && existing !== undefined) {
        return Promise.resolve(null);
      }
      if (onlyIf?.etagMatches !== undefined && existing?.etag !== onlyIf.etagMatches) {
        return Promise.resolve(null);
      }
      const result = store(key, value);
      return fault === "land-then-throw"
        ? Promise.reject(new Error("internal error"))
        : Promise.resolve(result);
    },
    delete: (key: string) => {
      objects.delete(key);
      return Promise.resolve();
    },
    list: () => Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }),
  } as unknown as R2Bucket;
  return {
    bucket,
    calls,
    arm() {
      armed = true;
      Object.assign(calls, { logGets: 0, logPuts: 0, otherGets: 0, otherPuts: 0 });
    },
  };
};

const setupWriter = async (logPutFault: (ordinal: number) => LogPutFault) => {
  const mem = memBucket(logPutFault);
  const storage = r2BindingStorage(mem.bucket);
  await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
  mem.arm();
  const counted = wrapCountingStorage(storage);
  const writer = new Writer({
    storage: counted.storage,
    currentJsonKey: CURRENT_KEY,
    options: { initialBackoffMs: 0, random: () => 0 },
  });
  const commit = () =>
    writer.commit({
      op: "I",
      collection: "tickets",
      docId: "one",
      body: { _id: "one", status: "open" },
    });
  return { counted, calls: mem.calls, commit };
};

describe("Writer commit over r2BindingStorage: binding calls behind the log create", () => {
  // The unfaulted path reads log/0 once (404 tail probe) before the create.
  const TAIL_PROBE_GETS = 1;

  test("every log put throws — 1 + maxRetries binding PUTs (no adapter multiplier), one readback; AmbiguousCommit", async () => {
    const { counted, calls, commit } = await setupWriter(() => "throw");
    const err = (await commit().catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(AMBIGUOUS_COMMIT);
    // A plain binding error carries no notApplied, so the slot is uncertain:
    // the Writer resends its full default budget, one binding call each,
    // then reads the empty slot back once (null ⇒ not retried).
    expect(calls.logPuts).toBe(1 + S3_REQUEST_MAX_RETRIES);
    expect(calls.logGets).toBe(TAIL_PROBE_GETS + 1);
    expect(counted.puts).toBe(1 + S3_REQUEST_MAX_RETRIES);
  });

  test("lost ack (lands, then throws) — the resend is refused by the precondition, readback adopts; 2 binding PUTs", async () => {
    const { counted, calls, commit } = await setupWriter((n) =>
      n === 0 ? "land-then-throw" : "pass",
    );
    await expect(commit()).resolves.toMatchObject({ entry: { seq: 0 } });
    expect(calls.logPuts).toBe(2);
    expect(calls.logGets).toBe(TAIL_PROBE_GETS + 1);
    expect(counted.puts).toBe(2);
  });
});
