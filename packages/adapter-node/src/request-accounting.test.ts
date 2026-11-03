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
 * - get / put / delete: `retryStorageCall` makes `retries + 1` attempts
 *   (default `STORAGE_RETRY_MAX_ATTEMPTS`, 3), throttles and 5xx alike.
 * - list: one request per page, each page under the same single
 *   `retries + 1` budget; 429 and 5xx share one counter per page.
 */

import { type BaerlyError, STORAGE_RETRY_MAX_ATTEMPTS, type Storage } from "@baerly/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { wrapCountingStorage } from "../../../tests/fixtures/counting-storage.ts";
import { GcsHttpStorage } from "./gcs-http.ts";
import { S3HttpStorage } from "./s3-http.ts";

const NETWORK_ERROR = "NetworkError" as const;

/** Attempts `retryStorageCall` makes for one call: the first try plus `retries`. */
const attemptsFor = (retries: number): number => 1 + retries;

/** Attempts per call (and per list page) when `retries` is omitted. */
const DEFAULT_ATTEMPTS = STORAGE_RETRY_MAX_ATTEMPTS;

interface Adapter {
  readonly name: string;
  /** `retries` omitted ⇒ the adapter default (`STORAGE_RETRY_MAX_ATTEMPTS - 1`). */
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
    test("get: 500 ×2 then 200 — outer meter sees 1 get, transport issues 3", async () => {
      const failures = DEFAULT_ATTEMPTS - 1;
      const f = scriptedFetch((n) => (n < failures ? fail500() : adapter.ok("x")));
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      await expect(counted.storage.get("k")).resolves.not.toBeNull();
      expect(counted.gets).toBe(1);
      expect(f.issued).toBe(failures + 1);
    });

    test("get: always 500 with default retries — outer 1 get, transport issues STORAGE_RETRY_MAX_ATTEMPTS (3)", async () => {
      const f = scriptedFetch(fail500);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      await expect(counted.storage.get("k")).rejects.toMatchObject({ code: NETWORK_ERROR });
      expect(counted.gets).toBe(1);
      expect(f.issued).toBe(DEFAULT_ATTEMPTS);
      expect(f.issued).toBe(3);
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

    test("put: always 500 with default retries — outer 1 put, transport issues 3", async () => {
      const f = scriptedFetch(fail500);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      await expect(counted.storage.put("k", new Uint8Array([1]))).rejects.toMatchObject({
        code: NETWORK_ERROR,
      });
      expect(counted.puts).toBe(1);
      expect(f.issued).toBe(DEFAULT_ATTEMPTS);
    });

    test("conditional create throttled on every attempt — outer 1 put, transport issues 3, cause.notApplied", async () => {
      const f = scriptedFetch(throttle429);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      const err = (await counted.storage
        .put("log/0.json", new Uint8Array([1]), { ifNoneMatch: "*" })
        .catch((error: unknown) => error)) as BaerlyError;
      expect(err.code).toBe(NETWORK_ERROR);
      expect(err.cause).toMatchObject({ status: 429, throttled: true, notApplied: true });
      expect(counted.puts).toBe(1);
      expect(f.issued).toBe(DEFAULT_ATTEMPTS);
    });

    test("delete: 500 ×2 then 204 with retries: 2 — outer 1 delete, transport issues 3", async () => {
      const retries = 2;
      const f = scriptedFetch((n) =>
        n < retries ? fail500() : new Response(null, { status: 204 }),
      );
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, retries));
      await counted.storage.delete("k");
      expect(counted.deletes).toBe(1);
      expect(f.issued).toBe(attemptsFor(retries));
    });

    test("delete: always 500 with default retries — outer 1 delete, transport issues 3", async () => {
      const f = scriptedFetch(fail500);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      await expect(counted.storage.delete("k")).rejects.toMatchObject({ code: NETWORK_ERROR });
      expect(counted.deletes).toBe(1);
      expect(f.issued).toBe(DEFAULT_ATTEMPTS);
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
      // A follow-up request is answered 403 (not retried) so an adapter
      // that ignores the cap fails fast instead of paging forever.
      const f = scriptedFetch((n) =>
        n === 0
          ? new Response(adapter.listPage(["p/a", "p/b"], "t1"))
          : new Response(null, { status: 403 }),
      );
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

    /** Drain `list` under fake timers, flushing any backoff delay. */
    const drainUnderFakeTimers = async (storage: Storage): Promise<unknown> => {
      vi.useFakeTimers();
      const settled = drain(storage.list("p/")).then(
        (keys) => ({ keys }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();
      return settled;
    };

    test("429 ×2 then 200 — outer 1 list, transport issues 3", async () => {
      const throttles = DEFAULT_ATTEMPTS - 1;
      const f = scriptedFetch((n) =>
        n < throttles ? throttle429() : new Response(adapter.listPage(["p/a"])),
      );
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      await expect(drainUnderFakeTimers(counted.storage)).resolves.toEqual({ keys: ["p/a"] });
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(throttles + 1);
    });

    test("two pages, each throttled STORAGE_RETRY_MAX_ATTEMPTS - 1 times — the budget is per page; transport issues 2 × 3", async () => {
      const throttlesPerPage = DEFAULT_ATTEMPTS - 1;
      const perPage = throttlesPerPage + 1;
      const f = scriptedFetch((n) => {
        if (n % perPage < throttlesPerPage) {
          return throttle429();
        }
        return new Response(
          n < perPage ? adapter.listPage(["p/a"], "t1") : adapter.listPage(["p/b"]),
        );
      });
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      await expect(drainUnderFakeTimers(counted.storage)).resolves.toEqual({
        keys: ["p/a", "p/b"],
      });
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(2 * DEFAULT_ATTEMPTS);
      expect(f.issued).toBe(6);
      expect(f.urls[perPage]).toContain("continuation-token=t1");
    });

    test("429 forever with retries: 0 — 1 fetch; retries bounds the 429 path too", async () => {
      const f = scriptedFetch(throttle429);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, 0));
      const out = (await drainUnderFakeTimers(counted.storage)) as { error: BaerlyError };
      expect(out.error.code).toBe(NETWORK_ERROR);
      expect(out.error.retriable).toBe(true);
      expect(out.error.cause).toMatchObject({ status: 429 });
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(attemptsFor(0));
      expect(f.issued).toBe(1);
    });

    test("429 forever with default retries — 3 fetches, retriable NetworkError with status 429 and the hint", async () => {
      const f = scriptedFetch(
        () => new Response(null, { status: 429, headers: { "Retry-After": "1" } }),
      );
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      const out = (await drainUnderFakeTimers(counted.storage)) as { error: BaerlyError };
      expect(out.error.code).toBe(NETWORK_ERROR);
      expect(out.error.retriable).toBe(true);
      expect(out.error.cause).toMatchObject({ status: 429, retryAfterSeconds: 1 });
      expect(f.issued).toBe(DEFAULT_ATTEMPTS);
    });

    test("500 forever with default retries — 3 fetches", async () => {
      const f = scriptedFetch(fail500);
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      const out = (await drainUnderFakeTimers(counted.storage)) as { error: BaerlyError };
      expect(out.error.code).toBe(NETWORK_ERROR);
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(DEFAULT_ATTEMPTS);
    });

    test("500 and 429 alternating with retries: 2 — one counter per page, so 3 fetches", async () => {
      const retries = 2;
      const f = scriptedFetch((n) => (n % 2 === 0 ? fail500() : throttle429()));
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl, retries));
      const out = (await drainUnderFakeTimers(counted.storage)) as { error: BaerlyError };
      expect(out.error.code).toBe(NETWORK_ERROR);
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(attemptsFor(retries));
    });

    test("429 and 500 alternating with default retries — outer meter sees 1 list, transport issues 3 for ONE page", async () => {
      const f = scriptedFetch((n) => (n % 2 === 0 ? throttle429() : fail500()));
      const counted = wrapCountingStorage(adapter.make(f.fetchImpl));
      const out = (await drainUnderFakeTimers(counted.storage)) as { error: BaerlyError };
      expect(out.error.code).toBe(NETWORK_ERROR);
      expect(counted.lists).toBe(1);
      expect(f.issued).toBe(DEFAULT_ATTEMPTS);
      expect(f.issued).toBe(3);
    });
  });
});
