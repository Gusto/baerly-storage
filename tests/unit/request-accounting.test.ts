/**
 * Characterization: requests issued behind the `Storage` boundary, for the
 * in-process adapters (baseline) and for a `Writer` commit over
 * `S3HttpStorage` under throttling (the multiplier).
 *
 * The outer count comes from `wrapCountingStorage` (what every in-tree
 * meter sees); the issued count comes from the `fetch` handed to
 * `S3HttpStorage`, classified by method and key class. Expectations are
 * derived from the constants:
 *
 * - each `Storage.put` makes `1 + retries` HTTP attempts
 *   (adapter default `S3_REQUEST_MAX_RETRIES`);
 * - `Writer` resends a transient log create up to `maxRetries` times
 *   (default `S3_REQUEST_MAX_RETRIES`), one budget shared with occupant
 *   readbacks.
 *
 * So an all-throttled create costs `(1 + maxRetries) × (1 + retries)`
 * HTTP PUTs while the outer meter sees `1 + maxRetries` puts.
 */

import { LocalFsStorage } from "@baerly/dev";
import {
  type BaerlyError,
  createCurrentJson,
  MemoryStorage,
  S3_REQUEST_MAX_RETRIES,
  type Storage,
} from "@baerly/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { S3HttpStorage } from "../../packages/adapter-node/src/s3-http.ts";
import { Writer } from "../../packages/server/src/writer.ts";
import { type CountingStorage, wrapCountingStorage } from "../fixtures/counting-storage.ts";
import { logStateCurrentJson } from "../fixtures/log-state.ts";
import { makeS3Stub } from "../fixtures/s3-memory-stub.ts";

const NETWORK_ERROR = "NetworkError" as const;
const AMBIGUOUS_COMMIT = "AmbiguousCommit" as const;

const drain = async (iter: AsyncIterable<{ key: string }>): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of iter) {
    out.push(e.key);
  }
  return out;
};

describe("in-process adapters: one list() call is one pass, no paging layer", () => {
  const root = mkdtempSync(join(tmpdir(), "baerly-request-accounting-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const adapters: ReadonlyArray<{ name: string; make: () => Storage }> = [
    { name: "MemoryStorage", make: () => new MemoryStorage() },
    { name: "LocalFsStorage", make: () => new LocalFsStorage({ root }) },
  ];

  // Neither adapter retries or pages, so one outer `list` is one pass
  // over the keyspace regardless of `maxKeys` / `startAfter`. Results
  // only: no issued counter here (LocalFsStorage's pass is a directory
  // walk plus one read per yielded key, not a request count).
  describe.each(adapters)("$name", ({ make }) => {
    test("one list() call returns every page shape in one pass: full, exact-full at maxKeys, startAfter, empty", async () => {
      const inner = make();
      const keys = Array.from({ length: 5 }, (_, i) => `p/${i}`);
      for (const k of keys) {
        await inner.put(k, new Uint8Array([1]));
      }
      const counted = wrapCountingStorage(inner);
      await expect(drain(counted.storage.list("p/"))).resolves.toEqual(keys);
      await expect(drain(counted.storage.list("p/", { maxKeys: 5 }))).resolves.toEqual(keys);
      await expect(
        drain(counted.storage.list("p/", { startAfter: "p/1", maxKeys: 2 })),
      ).resolves.toEqual(["p/2", "p/3"]);
      await expect(drain(counted.storage.list("p/", { startAfter: "p/4" }))).resolves.toEqual([]);
      expect(counted.lists).toBe(4);
    });
  });
});

// ── Writer commit over S3HttpStorage ────────────────────────────────────

const CURRENT_KEY = "app/test/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/test/tenant/t/manifests/tickets/log/";
const INDEX_PREFIX = "app/test/tenant/t/manifests/tickets/index/";

type KeyClass = "current" | "log" | "index" | "other";
const classify = (key: string): KeyClass => {
  if (key === CURRENT_KEY) {
    return "current";
  }
  if (key.startsWith(LOG_PREFIX)) {
    return "log";
  }
  return key.startsWith(INDEX_PREFIX) ? "index" : "other";
};

/** What the fault hook decides for one HTTP request. */
type Fault =
  | { kind: "pass" }
  | { kind: "respond"; response: Response }
  /** Let the request land in the stub, then answer `status` (a lost ack). */
  | { kind: "land-then"; status: number }
  /** Store `body` at the request's key first, then pass the request through. */
  | { kind: "occupy-then-pass"; body: string };

const PASS: Fault = { kind: "pass" };
const throttle429 = (): Fault => ({
  kind: "respond",
  response: new Response(null, { status: 429 }),
});
const slowDown503 = (): Fault => ({
  kind: "respond",
  response: new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 }),
});

/**
 * `S3HttpStorage` over `makeS3Stub`, with a fault hook that sees every
 * request plus the 0-based ordinal of log-create PUTs. `issued` counts
 * every HTTP request (failed ones included) as `"<METHOD> <keyClass>"`.
 */
const throttledS3 = (opts: {
  retries?: number;
  fault: (logPutOrdinal: number) => Fault;
  /** Same hook for log GETs (tail probes and occupant readbacks). */
  getFault?: (logGetOrdinal: number) => Fault;
}): { storage: S3HttpStorage; issued: Map<string, number>; reset(): void } => {
  const stub = makeS3Stub("b");
  const issued = new Map<string, number>();
  let logPuts = 0;
  let logGets = 0;
  let armed = false;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = decodeURIComponent(new URL(req.url).pathname.replace(/^\/b\//, ""));
    const label = `${req.method} ${classify(key)}`;
    issued.set(label, (issued.get(label) ?? 0) + 1);
    let fault: Fault = PASS;
    if (armed && classify(key) === "log") {
      if (req.method === "PUT") {
        fault = opts.fault(logPuts++);
      } else if (req.method === "GET" && opts.getFault !== undefined) {
        fault = opts.getFault(logGets++);
      }
    }
    if (fault.kind === "respond") {
      return fault.response;
    }
    if (fault.kind === "land-then") {
      await stub.fetchImpl(req);
      return new Response(null, { status: fault.status });
    }
    if (fault.kind === "occupy-then-pass") {
      await stub.fetchImpl(new Request(req.url, { method: "PUT", body: fault.body }));
    }
    return stub.fetchImpl(req);
  }) as typeof fetch;
  const storage = new S3HttpStorage({
    endpoint: "https://example.invalid",
    bucket: "b",
    fetch: fetchImpl,
    backoffMs: 0,
    ...(opts.retries !== undefined && { retries: opts.retries }),
  });
  return {
    storage,
    issued,
    reset() {
      issued.clear();
      armed = true;
    },
  };
};

const outerShape = (c: CountingStorage) => ({ gets: c.gets, puts: c.puts, lists: c.lists });

/**
 * Seed `current.json`, then wire a counted `Writer` and arm the faults.
 * `maxRetries` omitted ⇒ the Writer default (`S3_REQUEST_MAX_RETRIES`).
 */
const setup = async (opts: {
  retries?: number;
  maxRetries?: number;
  fault: (logPutOrdinal: number) => Fault;
  getFault?: (logGetOrdinal: number) => Fault;
}) => {
  const s3 = throttledS3(opts);
  await createCurrentJson(s3.storage, CURRENT_KEY, logStateCurrentJson());
  s3.reset();
  const counted = wrapCountingStorage(s3.storage);
  const writer = new Writer({
    storage: counted.storage,
    currentJsonKey: CURRENT_KEY,
    options: {
      initialBackoffMs: 0,
      random: () => 0,
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
      indexes: [{ name: "by_status", on: "status" }],
    },
  });
  const commit = () =>
    writer.commit({
      op: "I",
      collection: "tickets",
      docId: "one",
      body: { _id: "one", status: "open" },
    });
  return { counted, issued: s3.issued, commit };
};

describe("Writer commit over S3HttpStorage: outer storage calls vs HTTP requests", () => {
  // Unfaulted hot path for an indexed insert: GET current.json (Step 1),
  // GET log/0 (404 tail probe), PUT index marker, PUT log/0 (the commit),
  // GET current.json (delete-floor check). One request per outer call.
  const HOT_PATH = {
    "GET current": 2,
    "GET log": 1,
    "PUT index": 1,
    "PUT log": 1,
  } as const;

  test("no faults — outer count equals issued count", async () => {
    const { counted, issued, commit } = await setup({ fault: () => PASS });
    await expect(commit()).resolves.toMatchObject({ entry: { seq: 0 } });
    expect(outerShape(counted)).toEqual({ gets: 3, puts: 2, lists: 0 });
    expect(Object.fromEntries(issued)).toEqual(HOT_PATH);
  });

  test("retries: 2, first 4 log PUTs SlowDown — outer sees 2 log puts, transport issues 5", async () => {
    const retries = 2;
    const throttled = 4;
    const { counted, issued, commit } = await setup({
      retries,
      fault: (n) => (n < throttled ? slowDown503() : PASS),
    });
    await expect(commit()).resolves.toMatchObject({ entry: { seq: 0 } });
    // Put call 1 spends all 1 + retries = 3 attempts throttled (notApplied),
    // Writer resends once; put call 2 is throttled once more, then lands.
    expect(counted.puts).toBe(1 + 2); // index put + two log-create calls
    expect(issued.get("PUT log")).toBe(throttled + 1);
    // A notApplied rejection needs no occupant readback.
    expect(issued.get("GET log")).toBe(HOT_PATH["GET log"]);
    expect(issued.get("PUT index")).toBe(HOT_PATH["PUT index"]);
  });

  test("retries: 2, maxRetries: 2, every log PUT 429 — outer 3 log puts, transport issues 9, NetworkError, no readback", async () => {
    const retries = 2;
    const maxRetries = 2;
    const { counted, issued, commit } = await setup({ retries, maxRetries, fault: throttle429 });
    const err = (await commit().catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(NETWORK_ERROR);
    expect(err.retriable).toBe(true);
    expect(err.cause).toMatchObject({ notApplied: true });
    const logPutCalls = 1 + maxRetries;
    expect(counted.puts).toBe(HOT_PATH["PUT index"] + logPutCalls);
    expect(issued.get("PUT log")).toBe(logPutCalls * (1 + retries));
    expect(issued.get("PUT log")).toBe(9);
    expect(issued.get("GET log")).toBe(HOT_PATH["GET log"]);
  });

  test("defaults, every log PUT SlowDown — outer sees 9 log puts, transport issues 81", async () => {
    const { counted, issued, commit } = await setup({ fault: slowDown503 });
    const err = (await commit().catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(NETWORK_ERROR);
    expect(err.cause).toMatchObject({ notApplied: true });
    const logPutCalls = 1 + S3_REQUEST_MAX_RETRIES;
    expect(counted.puts).toBe(HOT_PATH["PUT index"] + logPutCalls);
    expect(issued.get("PUT log")).toBe(logPutCalls * (1 + S3_REQUEST_MAX_RETRIES));
    expect(issued.get("PUT log")).toBe(81);
    expect(issued.get("GET log")).toBe(HOT_PATH["GET log"]);
  });

  test("defaults, every log PUT 500 (not a throttle) — 81 PUTs then a readback; AmbiguousCommit", async () => {
    const { counted, issued, commit } = await setup({
      fault: () => ({ kind: "respond", response: new Response("boom", { status: 500 }) }),
    });
    const err = (await commit().catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(AMBIGUOUS_COMMIT);
    const logPutCalls = 1 + S3_REQUEST_MAX_RETRIES;
    expect(counted.puts).toBe(HOT_PATH["PUT index"] + logPutCalls);
    expect(issued.get("PUT log")).toBe(logPutCalls * (1 + S3_REQUEST_MAX_RETRIES));
    // The resend budget is spent, so the final readback gets one outer
    // call; the slot is empty (404), so it is not retried.
    expect(issued.get("GET log")).toBe(HOT_PATH["GET log"] + 1);
    expect(counted.gets).toBe(2 + 1);
    expect(counted.lists).toBe(0);
  });

  test("defaults, lost ack (lands, answers 500) — adapter's own resend sees 412; outer 1 log put, transport 2, plus 1 readback", async () => {
    const { counted, issued, commit } = await setup({
      fault: (n) => (n === 0 ? { kind: "land-then", status: 500 } : PASS),
    });
    await expect(commit()).resolves.toMatchObject({ entry: { seq: 0 } });
    // The adapter's second attempt hits the landed object (412); Writer
    // never sees the 500, only the 412, and adopts by occupant readback.
    expect(counted.puts).toBe(HOT_PATH["PUT index"] + 1);
    expect(issued.get("PUT log")).toBe(2);
    expect(issued.get("GET log")).toBe(HOT_PATH["GET log"] + 1);
    expect(outerShape(counted)).toEqual({ gets: 4, puts: 2, lists: 0 });
  });

  // The readback share of the one transient budget. `retries: 0` makes
  // each outer call one HTTP request, so every count below is a Writer
  // decision. Log GET ordinal 0 is the tail probe; readbacks follow.
  const TAIL_PROBE_GETS = 1;
  const fail500 = (): Fault => ({
    kind: "respond",
    response: new Response("boom", { status: 500 }),
  });

  test("retries: 0, maxRetries: 2, every log PUT 500, readback 503 — resends spend the budget, readback gets one try; AmbiguousCommit", async () => {
    const maxRetries = 2;
    const { counted, issued, commit } = await setup({
      retries: 0,
      maxRetries,
      fault: fail500,
      getFault: (n) => (n < TAIL_PROBE_GETS ? PASS : slowDown503()),
    });
    const err = (await commit().catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(AMBIGUOUS_COMMIT);
    // 500 is not notApplied, so the slot is uncertain: the first send plus
    // `maxRetries` resends exhaust the budget before the readback runs.
    expect(issued.get("PUT log")).toBe(1 + maxRetries);
    // The readback's 503 finds no budget left, so it is not retried.
    expect(issued.get("GET log")).toBe(TAIL_PROBE_GETS + 1);
    expect(counted.puts).toBe(HOT_PATH["PUT index"] + 1 + maxRetries);
    expect(counted.lists).toBe(0);
  });

  test("retries: 0, maxRetries: 2, foreign occupant at log/0 read back through 2 SlowDowns — next slot's 500 gets no resend; AmbiguousCommit", async () => {
    const maxRetries = 2;
    const readbackFailures = 2;
    const foreign = JSON.stringify({ session: "foreign-session", seq: 0 });
    const { counted, issued, commit } = await setup({
      retries: 0,
      maxRetries,
      // log/0: a foreign writer lands first, so our create sees a genuine
      // 412 (no budget). log/1: 500 on every send.
      fault: (n) => (n === 0 ? { kind: "occupy-then-pass", body: foreign } : fail500()),
      // Ordinals 1..readbackFailures are the log/0 readbacks.
      getFault: (n) =>
        n >= TAIL_PROBE_GETS && n < TAIL_PROBE_GETS + readbackFailures ? slowDown503() : PASS,
    });
    const err = (await commit().catch((error: unknown) => error)) as BaerlyError;
    expect(err.code).toBe(AMBIGUOUS_COMMIT);
    // The log/0 readback spent the whole budget, so the log/1 create is
    // sent once and never resent.
    expect(readbackFailures).toBe(maxRetries);
    expect(issued.get("PUT log")).toBe(2);
    // tail probe + log/0 readbacks (failures + success) + forward probe
    // of log/1 + one log/1 readback (404 ⇒ not retried).
    expect(issued.get("GET log")).toBe(TAIL_PROBE_GETS + (readbackFailures + 1) + 1 + 1);
    expect(counted.puts).toBe(HOT_PATH["PUT index"] + 2);
  });
});
