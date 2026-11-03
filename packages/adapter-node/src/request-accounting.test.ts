/**
 * Characterization: how many HTTP requests the S3 and GCS adapters issue
 * behind ONE outer `Storage` call.
 *
 * Every outer meter in-tree (`wrapCountingStorage`, `observableStorage`)
 * counts at the `Storage` boundary, so it sees one `get` / `put` /
 * `delete` / `list` no matter how many requests the adapter sends. These
 * tests pin both numbers side by side: `outer` from `wrapCountingStorage`,
 * `issued` from the injected `fetch`. Every expectation is derived from
 * the transport constants so the multiplier documents itself:
 *
 * - get / put / delete: `retry()` makes `retries + 1` attempts
 *   (default `S3_REQUEST_MAX_RETRIES`).
 * - list: one request per page, and per page an outer 429 loop of
 *   `LIST_OBJECT_MAX_RETRIES` attempts, each wrapping the ordinary
 *   `retries + 1` loop (which retries 5xx but hands 429 to the outer
 *   loop).
 */

import {
  type BaerlyError,
  LIST_OBJECT_MAX_RETRIES,
  S3_REQUEST_MAX_RETRIES,
  type Storage,
} from "@baerly/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { wrapCountingStorage } from "../../../tests/fixtures/counting-storage.ts";
import { GcsHttpStorage } from "./gcs-http.ts";
import { S3HttpStorage } from "./s3-http.ts";

const NETWORK_ERROR = "NetworkError" as const;

/** Attempts `retry()` makes for one call: the first try plus `retries`. */
const attemptsFor = (retries: number): number => 1 + retries;

interface Adapter {
  readonly name: string;
  /** `retries` omitted ⇒ the adapter default (`S3_REQUEST_MAX_RETRIES`). */
  make(fetchImpl: typeof fetch, retries?: number): Storage;
  /** A successful object GET / PUT response carrying the version token. */
  ok(body?: string): Response;
  listPage(keys: readonly string[], nextToken?: string): string;
}

const s3: Adapter = {
  name: "S3HttpStorage",
  make: (fetchImpl, retries) =>
    new S3HttpStorage({
      endpoint: "https://example.invalid",
      bucket: "b",
      fetch: fetchImpl,
      backoffMs: 0,
      ...(retries !== undefined && { retries }),
    }),
  ok: (body) => new Response(body ?? null, { status: 200, headers: { ETag: '"e"' } }),
  listPage: (keys, nextToken) =>
    `<?xml version="1.0"?><ListBucketResult>` +
    keys.map((k) => `<Contents><Key>${k}</Key><ETag>"e"</ETag></Contents>`).join("") +
    (nextToken !== undefined ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "") +
    `</ListBucketResult>`,
};

const gcs: Adapter = {
  name: "GcsHttpStorage",
  make: (fetchImpl, retries) =>
    new GcsHttpStorage({
      bucket: "b",
      sign: (req) => Promise.resolve(req),
      fetch: fetchImpl,
      backoffMs: 0,
      ...(retries !== undefined && { retries }),
    }),
  ok: (body) => new Response(body ?? null, { status: 200, headers: { "x-goog-generation": "1" } }),
  listPage: (keys, nextToken) =>
    `<?xml version="1.0"?><ListBucketResult>` +
    keys.map((k) => `<Contents><Key>${k}</Key><Generation>1</Generation></Contents>`).join("") +
    (nextToken !== undefined ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "") +
    `</ListBucketResult>`,
};

/** A `fetch` that answers the n-th request (0-based) via `respond`, counting every call. */
const scriptedFetch = (respond: (n: number, req: Request) => Response) => {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const n = urls.length;
    urls.push(req.url);
    return respond(n, req);
  }) as typeof fetch;
  return {
    fetchImpl,
    urls,
    get issued() {
      return urls.length;
    },
  };
};

const fail500 = (): Response => new Response("boom", { status: 500 });
const throttle429 = (): Response => new Response(null, { status: 429 });

const drain = async (iter: AsyncIterable<{ key: string }>): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of iter) {
    out.push(e.key);
  }
  return out;
};

describe.each([s3, gcs])("$name request accounting", (adapter) => {
  describe("get / put / delete retries", () => {
    test("get: 500 ×3 then 200 — outer meter sees 1 get, transport issues 4", async () => {
      const failures = 3;
      const f = scriptedFetch((n) => (n < failures ? fail500() : adapter.ok("x")));
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      await expect(counted.storage.get("k")).resolves.not.toBeNull();
      expect(counted.gets).toBe(1);
      expect(f.issued).toBe(failures + 1);
    });

    test("get: always 500 with default retries — outer 1 get, transport issues 1 + S3_REQUEST_MAX_RETRIES (9)", async () => {
      const f = scriptedFetch(fail500);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      await expect(counted.storage.get("k")).rejects.toMatchObject({ code: NETWORK_ERROR });
      expect(counted.gets).toBe(1);
      expect(f.issued).toBe(attemptsFor(S3_REQUEST_MAX_RETRIES));
      expect(f.issued).toBe(9);
    });

    test("get: always 500 with retries: 2 — outer 1 get, transport issues 3", async () => {
      const retries = 2;
      const f = scriptedFetch(fail500);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, retries));
      await expect(counted.storage.get("k")).rejects.toMatchObject({ code: NETWORK_ERROR });
      expect(counted.gets).toBe(1);
      expect(f.issued).toBe(attemptsFor(retries));
    });

    test("put: 500 ×2 then 200 with retries: 2 — outer 1 put, transport issues 3", async () => {
      const f = scriptedFetch((n) => (n < 2 ? fail500() : adapter.ok()));
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, 2));
      await counted.storage.put("k", new Uint8Array([1]));
      expect(counted.puts).toBe(1);
      expect(f.issued).toBe(3);
    });

    test("put: always 500 with default retries — outer 1 put, transport issues 9", async () => {
      const f = scriptedFetch(fail500);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      await expect(counted.storage.put("k", new Uint8Array([1]))).rejects.toMatchObject({
        code: NETWORK_ERROR,
      });
      expect(counted.puts).toBe(1);
      expect(f.issued).toBe(attemptsFor(S3_REQUEST_MAX_RETRIES));
    });

    test("conditional create throttled on every attempt — outer 1 put, transport issues 9, cause.notApplied", async () => {
      const f = scriptedFetch(throttle429);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      const err = (await counted.storage
        .put("log/0.json", new Uint8Array([1]), { ifNoneMatch: "*" })
        .catch((error: unknown) => error)) as BaerlyError;
      expect(err.code).toBe(NETWORK_ERROR);
      expect(err.cause).toMatchObject({ status: 429, throttled: true, notApplied: true });
      expect(counted.puts).toBe(1);
      expect(f.issued).toBe(attemptsFor(S3_REQUEST_MAX_RETRIES));
    });

    test("delete: always 500 with default retries — outer 1 delete, transport issues 9", async () => {
      const f = scriptedFetch(fail500);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      await expect(counted.storage.delete("k")).rejects.toMatchObject({ code: NETWORK_ERROR });
      expect(counted.deletes).toBe(1);
      expect(f.issued).toBe(attemptsFor(S3_REQUEST_MAX_RETRIES));
    });
  });

  describe("paginated list", () => {
    test("3 pages — outer meter sees 1 list, transport issues 3", async () => {
      const pages = [
        adapter.listPage(["p/a"], "t1"),
        adapter.listPage(["p/b"], "t2"),
        adapter.listPage(["p/c"]),
      ];
      const f = scriptedFetch((n) => new Response(pages[n], { status: 200 }));
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, 0));
      await expect(drain(counted.storage.list("p/"))).resolves.toEqual(["p/a", "p/b", "p/c"]);
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(pages.length);
    });

    test("an exactly-full page at maxKeys stops without a follow-up fetch despite a token", async () => {
      const f = scriptedFetch(() => new Response(adapter.listPage(["p/a", "p/b"], "t1")));
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, 0));
      await expect(drain(counted.storage.list("p/", { maxKeys: 2 }))).resolves.toEqual([
        "p/a",
        "p/b",
      ]);
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(1);
    });

    test("an empty page carrying a token costs another fetch — outer 1 list, transport issues 3", async () => {
      const pages = [
        adapter.listPage([], "t1"),
        adapter.listPage([], "t2"),
        adapter.listPage(["p/a"]),
      ];
      const f = scriptedFetch((n) => new Response(pages[n], { status: 200 }));
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, 0));
      await expect(
        drain(counted.storage.list("p/", { maxKeys: 5, startAfter: "p/" })),
      ).resolves.toEqual(["p/a"]);
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(pages.length);
      expect(f.urls[1]).toContain("continuation-token=t1");
    });
  });

  describe("list 429 loop", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Drain `list` under fake timers, flushing the non-injectable rate-limit delay. */
    const drainUnderFakeTimers = async (storage: Storage): Promise<unknown> => {
      vi.useFakeTimers();
      const settled = drain(storage.list("p/")).then(
        (keys) => ({ keys }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();
      return settled;
    };

    test("429 ×3 then 200 — outer 1 list, transport issues 4", async () => {
      const throttles = 3;
      const f = scriptedFetch((n) =>
        n < throttles ? throttle429() : new Response(adapter.listPage(["p/a"])),
      );
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, 0));
      await expect(drainUnderFakeTimers(counted.storage)).resolves.toEqual({ keys: ["p/a"] });
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(throttles + 1);
    });

    test("429 forever with retries: 0 — still LIST_OBJECT_MAX_RETRIES (10) fetches; retries does not bound the 429 loop", async () => {
      const f = scriptedFetch(throttle429);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, 0));
      const out = (await drainUnderFakeTimers(counted.storage)) as { error: BaerlyError };
      expect(out.error.code).toBe(NETWORK_ERROR);
      expect(out.error.cause).toMatchObject({ status: 429 });
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(LIST_OBJECT_MAX_RETRIES);
      expect(f.issued).toBe(10);
    });

    test("429 forever with default retries — also 10 fetches; the inner loop never retries a 429", async () => {
      const f = scriptedFetch(throttle429);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      const out = (await drainUnderFakeTimers(counted.storage)) as { error: BaerlyError };
      expect(out.error.code).toBe(NETWORK_ERROR);
      expect(f.issued).toBe(LIST_OBJECT_MAX_RETRIES);
    });

    test("500 forever with default retries — 9 fetches; the outer loop never retries a 5xx", async () => {
      const f = scriptedFetch(fail500);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      const out = (await drainUnderFakeTimers(counted.storage)) as { error: BaerlyError };
      expect(out.error.code).toBe(NETWORK_ERROR);
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(attemptsFor(S3_REQUEST_MAX_RETRIES));
    });

    test("500 ×retries then 429, repeating, with retries: 2 — loops multiply to 10 × 3 = 30 fetches", async () => {
      const retries = 2;
      const perAttempt = attemptsFor(retries);
      // Each inner `retry()` run sees `retries` 500s, then a 429 that it
      // hands back as "ratelimited" to the outer loop.
      const f = scriptedFetch((n) =>
        n % perAttempt === perAttempt - 1 ? throttle429() : fail500(),
      );
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, retries));
      const out = (await drainUnderFakeTimers(counted.storage)) as { error: BaerlyError };
      expect(out.error.code).toBe(NETWORK_ERROR);
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(LIST_OBJECT_MAX_RETRIES * perAttempt);
    });

    test("same pattern with default retries — outer meter sees 1 list, transport issues 10 × 9 = 90 for ONE page", async () => {
      const perAttempt = attemptsFor(S3_REQUEST_MAX_RETRIES);
      const f = scriptedFetch((n) =>
        n % perAttempt === perAttempt - 1 ? throttle429() : fail500(),
      );
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      const out = (await drainUnderFakeTimers(counted.storage)) as { error: BaerlyError };
      expect(out.error.code).toBe(NETWORK_ERROR);
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(LIST_OBJECT_MAX_RETRIES * perAttempt);
      expect(f.issued).toBe(90);
    });
  });
});
