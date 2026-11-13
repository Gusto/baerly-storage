/**
 * Characterization: binding calls `r2BindingStorage` issues behind ONE
 * outer `Storage` call. The adapter wraps every binding call in the
 * shared storage retry policy, so a succeeding get / put / delete is one
 * binding call and a failing one is `STORAGE_RETRY_MAX_ATTEMPTS` (3).
 * `list` is one `bucket.list` per page (each page under the same
 * budget), so an outer meter that counts one `list` per call
 * (`wrapCountingStorage`, `observableStorage`) undercounts by the page
 * count.
 *
 * Plain unit tests over a fake binding — runs in the default vitest
 * project, like `r2-binding-storage.test.ts`.
 */

import {
  type BaerlyError,
  createCurrentJson,
  RequestLedger,
  STORAGE_RETRY_MAX_ATTEMPTS,
  STORAGE_RETRY_THROTTLE_BASE_MILLIS,
  storageRetryDelayMillis,
} from "@baerly/protocol";
import { Writer } from "@baerly/server/_internal/testing";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import { afterEach, describe, expect, test, vi } from "vitest";
import { wrapCountingStorage } from "../../../tests/fixtures/counting-storage.ts";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";

const NETWORK_ERROR = "NetworkError" as const;
const AMBIGUOUS_COMMIT = "AmbiguousCommit" as const;

// R2 binding errors end `message` with the R2 error code in parentheses
// (https://developers.cloudflare.com/r2/api/error-codes/). 10058 is
// `TooManyRequests` (429), the 1-write-per-second-per-key limit.
const R2_SAME_KEY_RATE_LIMIT =
  "put: Reduce your concurrent request rate for the same object. (10058)";
// The workerd message seen when an invocation exhausts its subrequests.
const SUBREQUEST_LIMIT =
  "Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits";

afterEach(() => vi.restoreAllMocks());

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
  failing: boolean | string = false,
): { bucket: R2Bucket; calls: BindingCalls } => {
  const calls: BindingCalls = { get: 0, put: 0, delete: 0, list: [] };
  const message = typeof failing === "string" ? failing : "internal error";
  const fail = () => Promise.reject(new Error(message));
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

  test("a failing get / put / delete is STORAGE_RETRY_MAX_ATTEMPTS (3) binding calls each — outer 1 each", async () => {
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
    const issued = STORAGE_RETRY_MAX_ATTEMPTS;
    expect([calls.get, calls.put, calls.delete]).toEqual([issued, issued, issued]);
    expect(issued).toBe(3);
  });

  test("a same-key rate limit (10058) is retried as a throttle on a non-create call", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { bucket, calls } = mkBucket([], R2_SAME_KEY_RATE_LIMIT);
    const storage = r2BindingStorage(bucket);
    const err = (await storage
      .put("k", new Uint8Array([1]), { ifMatch: '"e"' })
      .catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(NETWORK_ERROR);
    expect(err.cause).toMatchObject({ throttled: true });
    expect(calls.put).toBe(STORAGE_RETRY_MAX_ATTEMPTS);
    // The throttle tag selects the throttle backoff base.
    expect(storageRetryDelayMillis(err, 0, { random: () => 1 })).toBe(
      STORAGE_RETRY_THROTTLE_BASE_MILLIS,
    );
  });

  test("a same-key rate limit (10058) on every attempt preserves conditional-create uncertainty", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { bucket, calls } = mkBucket([], R2_SAME_KEY_RATE_LIMIT);
    const storage = r2BindingStorage(bucket);
    const err = (await storage
      .put("k", new Uint8Array([1]), { ifNoneMatch: "*" })
      .catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(NETWORK_ERROR);
    expect(err.cause).toMatchObject({ throttled: true, mayHaveApplied: true });
    expect(err.cause).not.toHaveProperty("notApplied");
    expect(calls.put).toBe(STORAGE_RETRY_MAX_ATTEMPTS);
  });

  test("the platform's subrequest limit is not retried; a refused create reports notApplied", async () => {
    const { bucket, calls } = mkBucket([], SUBREQUEST_LIMIT);
    const storage = r2BindingStorage(bucket);
    for (const op of [
      () => storage.get("k"),
      () => storage.put("k", new Uint8Array([1]), { ifNoneMatch: "*" }),
      () => storage.delete("k"),
    ]) {
      const err = (await op().catch((error: unknown) => error)) as BaerlyError;
      expect(err.code).toBe(NETWORK_ERROR);
      expect(err.retriable).toBe(true);
    }
    expect([calls.get, calls.put, calls.delete]).toEqual([1, 1, 1]);
    const createErr = (await storage
      .put("k", new Uint8Array([1]), { ifNoneMatch: "*" })
      .catch((error: unknown) => error)) as BaerlyError;
    expect(createErr.cause).toMatchObject({ notApplied: true });
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
type LogPutFault =
  | "pass"
  | "throw"
  | "land-then-throw"
  | "land-then-throttle"
  | "deny"
  | "invalid-config"
  | "throttle"
  | "peer-then-throttle"
  | "invocation-subrequest-limit"
  | "subrequest-limit";

/**
 * An in-memory `R2Bucket` honoring the `onlyIf` shapes the adapter
 * sends, counting binding `get` / `put` per key class. `logPutFault`
 * sees the 0-based ordinal of log-key `put`s once armed.
 */
const memBucket = (logPutFault: (ordinal: number) => LogPutFault, markerThrottles = 0) => {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const calls = { logGets: 0, logPuts: 0, otherGets: 0, otherPuts: 0, markerPuts: 0 };
  let markerThrottlesLeft = markerThrottles;
  let version = 0;
  let armed = false;
  let invocationExhausted = false;
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
      if (invocationExhausted) {
        return Promise.reject(new Error(SUBREQUEST_LIMIT));
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
      if (armed && key.includes("/index/")) {
        calls.markerPuts++;
        if (markerThrottlesLeft > 0) {
          markerThrottlesLeft--;
          return Promise.reject(new Error(R2_SAME_KEY_RATE_LIMIT));
        }
      }
      if (fault === "throw") {
        return Promise.reject(new Error("internal error"));
      }
      if (fault === "invalid-config") {
        return Promise.reject(new Error("no such bucket"));
      }
      if (fault === "deny") {
        return Promise.reject(new Error("permission denied"));
      }
      if (fault === "throttle") {
        return Promise.reject(new Error(R2_SAME_KEY_RATE_LIMIT));
      }
      if (fault === "subrequest-limit") {
        return Promise.reject(new Error(SUBREQUEST_LIMIT));
      }
      if (fault === "invocation-subrequest-limit") {
        invocationExhausted = true;
        return Promise.reject(new Error(SUBREQUEST_LIMIT));
      }
      if (fault === "peer-then-throttle") {
        // A peer's create wins the key; ours is refused by the same-key limit.
        if (!objects.has(key)) {
          const ours = JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;
          store(key, new TextEncoder().encode(JSON.stringify({ ...ours, session: "INTRUDR0" })));
        }
        return Promise.reject(new Error(R2_SAME_KEY_RATE_LIMIT));
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
      if (fault === "land-then-throttle") {
        return Promise.reject(new Error(R2_SAME_KEY_RATE_LIMIT));
      }
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
    logKeys: () => [...objects.keys()].filter(isLog),
    arm() {
      armed = true;
      Object.assign(calls, { logGets: 0, logPuts: 0, otherGets: 0, otherPuts: 0, markerPuts: 0 });
    },
  };
};

const setupWriter = async (
  logPutFault: (ordinal: number) => LogPutFault,
  opts: { indexed?: boolean; markerThrottles?: number } = {},
) => {
  const mem = memBucket(logPutFault, opts.markerThrottles);
  const storage = r2BindingStorage(mem.bucket);
  await createCurrentJson(storage, CURRENT_KEY, logStateCurrentJson());
  mem.arm();
  const counted = wrapCountingStorage(storage);
  const writer = new Writer({
    storage: counted.storage,
    currentJsonKey: CURRENT_KEY,
    ...(opts.indexed === true && {
      options: { indexes: [{ name: "by_status", on: "status" }] },
    }),
  });
  const commit = () =>
    writer.commit({
      op: "I",
      collection: "tickets",
      docId: "one",
      body: { _id: "one", status: "open" },
    });
  return { counted, calls: mem.calls, commit, storage, logKeys: mem.logKeys };
};

describe("Writer commit over r2BindingStorage: binding calls behind the log create", () => {
  // The unfaulted path reads log/0 once (404 tail probe) before the create.
  const TAIL_PROBE_GETS = 1;

  test("every log put throws — 1 outer put × 3 binding calls = 3 binding PUTs, one readback; AmbiguousCommit", async () => {
    const { counted, calls, commit } = await setupWriter(() => "throw");
    const err = (await commit().catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(AMBIGUOUS_COMMIT);
    expect(err.retriable).toBe(false);
    // A plain binding error carries no notApplied, so the slot is uncertain:
    // the Writer sends once (the adapter spends its 3 attempts) and reads
    // the empty slot back once (null ⇒ not re-read).
    expect(counted.puts).toBe(1);
    expect(calls.logPuts).toBe(STORAGE_RETRY_MAX_ATTEMPTS);
    expect(calls.logPuts).toBe(3);
    expect(calls.logGets).toBe(TAIL_PROBE_GETS + 1);
    expect(counted.gets).toBe(3);
  });

  test("every log put hits the same-key rate limit — 3 binding PUTs, one readback of the empty slot; AmbiguousCommit", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { counted, calls, commit } = await setupWriter(() => "throttle");
    const err = (await commit().catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(AMBIGUOUS_COMMIT);
    expect(err.retriable).toBe(false);
    expect(counted.puts).toBe(1);
    expect(calls.logPuts).toBe(STORAGE_RETRY_MAX_ATTEMPTS);
    expect(calls.logGets).toBe(TAIL_PROBE_GETS + 1);
  });

  test.each(["deny", "invalid-config", "subrequest-limit", "pass"] as const)(
    "a create reporting 10058 after landing is adopted when the next attempt is %s",
    async (next) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      // R2 does not promise that 10058 proves an unapplied write. A later
      // definitive rejection must not hide an earlier durable attempt.
      const { calls, commit } = await setupWriter((n) => (n === 0 ? "land-then-throttle" : next));
      await expect(commit()).resolves.toMatchObject({ entry: { seq: 0, doc_id: "one" } });
      expect(calls.logPuts).toBe(2);
      expect(calls.logGets).toBe(TAIL_PROBE_GETS + 1);
    },
  );

  test("a race loser throttled at a peer's slot reads it back and commits at the next slot", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { counted, calls, commit } = await setupWriter((n) =>
      n < STORAGE_RETRY_MAX_ATTEMPTS ? "peer-then-throttle" : "pass",
    );
    await expect(commit()).resolves.toMatchObject({ entry: { seq: 1, doc_id: "one" } });
    // Slot 0: 3 throttled binding PUTs; slot 1: one clean PUT.
    expect(calls.logPuts).toBe(STORAGE_RETRY_MAX_ATTEMPTS + 1);
    expect(counted.puts).toBe(2);
  });

  test("an index-marker put throttled once by the same-key limit is retried and the write commits", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { counted, calls, commit } = await setupWriter(() => "pass", {
      indexed: true,
      markerThrottles: 1,
    });
    await expect(commit()).resolves.toMatchObject({ entry: { seq: 0, doc_id: "one" } });
    // One outer marker put; the adapter's retry is the second binding call.
    expect(calls.markerPuts).toBe(2);
    expect(counted.puts).toBe(2);
  });

  test("a log create refused by the subrequest limit is one binding PUT and a retriable NetworkError", async () => {
    const { counted, calls, commit } = await setupWriter(() => "subrequest-limit");
    const err = (await commit().catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(NETWORK_ERROR);
    expect(err.retriable).toBe(true);
    expect(err.cause).toMatchObject({ notApplied: true });
    expect(counted.puts).toBe(1);
    expect(calls.logPuts).toBe(1);
    expect(calls.logGets).toBe(TAIL_PROBE_GETS + 1);
  });

  test("an invocation-wide subrequest refusal stays retriable when its readback is refused too", async () => {
    const { counted, calls, commit, logKeys } = await setupWriter(
      () => "invocation-subrequest-limit",
    );
    const err = (await commit().catch((error: unknown) => error)) as BaerlyError;
    expect(err).toMatchObject({
      code: NETWORK_ERROR,
      retriable: true,
      cause: { refused: true, notApplied: true },
    });
    expect(counted.puts).toBe(1);
    expect(calls.logPuts).toBe(1);
    expect(calls.logGets).toBe(TAIL_PROBE_GETS + 1);
    expect(logKeys()).toEqual([]);
  });

  test.each(["throttle", "land-then-throttle"] as const)(
    "an uncertain %s before invocation exhaustion stays ambiguous when readback is refused",
    async (first) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const { calls, commit, logKeys } = await setupWriter((n) =>
        n === 0 ? first : "invocation-subrequest-limit",
      );
      await expect(commit()).rejects.toMatchObject({
        code: AMBIGUOUS_COMMIT,
        retriable: false,
      });
      expect(calls.logPuts).toBe(2);
      expect(calls.logGets).toBe(TAIL_PROBE_GETS + 1);
      expect(logKeys()).toEqual(first === "land-then-throttle" ? [`${LOG_PREFIX}0.json`] : []);
    },
  );

  test("lost ack (lands, then throws) — the adapter's own resend is refused by the precondition, readback adopts; outer 1 put, 2 binding PUTs", async () => {
    const { counted, calls, commit } = await setupWriter((n) =>
      n === 0 ? "land-then-throw" : "pass",
    );
    await expect(commit()).resolves.toMatchObject({ entry: { seq: 0 } });
    expect(calls.logPuts).toBe(2);
    expect(calls.logGets).toBe(TAIL_PROBE_GETS + 1);
    expect(counted.puts).toBe(1);
  });

  // The first binding put lands, then fails generically; the adapter's
  // retry then gets a permission-shaped rejection. The landed attempt
  // means that rejection cannot prove the create absent.
  const landThenDeny = (n: number): LogPutFault =>
    (["land-then-throw", "deny"] as const)[n] ?? "pass";

  test("a create denied after a landed attempt is an uncertain NetworkError, not AccessDenied", async () => {
    const { storage, calls } = await setupWriter(landThenDeny);
    const err = (await storage
      .put(`${LOG_PREFIX}0.json`, new Uint8Array([1]), { ifNoneMatch: "*" })
      .catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(NETWORK_ERROR);
    expect((err.cause as { notApplied?: boolean } | undefined)?.notApplied).toBeUndefined();
    expect(calls.logPuts).toBe(2);
  });

  test("at Writer level, a create denied after a landed attempt is adopted by readback", async () => {
    const { counted, calls, commit } = await setupWriter(landThenDeny);
    await expect(commit()).resolves.toMatchObject({ entry: { seq: 0, doc_id: "one" } });
    expect(counted.puts).toBe(1);
    expect(calls.logPuts).toBe(2);
    expect(calls.logGets).toBe(TAIL_PROBE_GETS + 1);
  });
});

describe("r2BindingStorage charges the request ledger", () => {
  const inLedger = <T>(ledger: RequestLedger, fn: () => Promise<T>): Promise<T> =>
    Promise.resolve(runWithContext(createObservabilityContext({ ledger }), fn));

  test("every binding call, retries included, is charged to the internal pool only", async () => {
    const ledger = new RequestLedger({ internal: 100, external: 0 });
    const { bucket, calls } = mkBucket([], true);
    const storage = r2BindingStorage(bucket);
    await inLedger(ledger, () => storage.get("k").catch(() => null));
    expect(calls.get).toBe(STORAGE_RETRY_MAX_ATTEMPTS);
    expect(ledger.charged).toEqual({
      internal: STORAGE_RETRY_MAX_ATTEMPTS,
      external: 0,
      cache: 0,
    });
  });

  test("a 3-page list is refused before page 3 when the ledger holds 2", async () => {
    const pages = [
      { keys: ["p/a"], truncated: true },
      { keys: ["p/b"], truncated: true },
      { keys: ["p/c"], truncated: false },
    ];
    const { bucket, calls } = mkBucket(pages);
    const storage = r2BindingStorage(bucket);
    const seen: string[] = [];
    const err = await inLedger(new RequestLedger({ internal: 2, external: 2 }), async () => {
      for await (const e of storage.list("p/")) {
        seen.push(e.key);
      }
    }).catch((error: unknown) => error);
    expect(err).toMatchObject({ code: "CapacityExceeded", cause: { refused: true } });
    expect(seen).toEqual(["p/a", "p/b"]);
    expect(calls.list).toHaveLength(2);
  });

  test("a call past the limit never reaches the binding", async () => {
    const { bucket, calls } = mkBucket();
    const storage = r2BindingStorage(bucket);
    const ledger = new RequestLedger({ internal: 1, external: 1 });
    await inLedger(ledger, async () => {
      await storage.get("k");
      await expect(storage.put("k", new Uint8Array([1]))).rejects.toMatchObject({
        code: "CapacityExceeded",
      });
    });
    expect([calls.get, calls.put]).toEqual([1, 0]);
  });
});
