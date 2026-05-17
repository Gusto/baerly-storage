/**
 * Cache API integration tests. Runs under the `cloudflare-pool` vitest
 * project (workerd + miniflare) so `caches.default` is a real per-isolate
 * cache.
 *
 * Eight cases:
 *   1. cache miss → handler invoked, response populated
 *   2. cache hit + matching `If-None-Match` → 304
 *   3. cache hit + mismatched `If-None-Match` → 200 cached body
 *   4. `invalidateOnWrite` busts both per-doc and parent list keys
 *   5. `/v1/since` and `/v1/healthz` bypass the cache
 *   6. cross-tenant cache isolation (load-bearing security test)
 *   7. `cacheKeyFor` appends `__t`, preserves other params, method=GET
 *   8. `cacheKeyFor` server-controlled `__t` wins over caller-supplied
 */

import { describe, expect, it } from "vitest";
import { cacheKeyFor, invalidateOnWrite, withReadCache } from "./cache.ts";

const json200 = (body: unknown, etag: string): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", etag },
  });

/**
 * Fresh URL per test so the per-isolate `caches.default` (shared
 * across test files inside one Workerd run) doesn't leak state.
 */
let n = 0;
const freshUrl = (path: string): string =>
  `https://baerly-cache.test/v1/t/${path}-${++n}-${Date.now().toString(36)}`;

describe("withReadCache", () => {
  it("cache miss → invokes handler and populates cache", async () => {
    const url = freshUrl("tickets/abc");
    const req1 = new Request(url, { method: "GET" });
    const req2 = new Request(url, { method: "GET" });
    let calls = 0;
    const handlerA = (): Promise<Response> => {
      calls++;
      return Promise.resolve(json200({ id: "abc", body: "first" }, '"v1"'));
    };
    const handlerB = (): Promise<Response> => {
      calls++;
      return Promise.resolve(json200({ id: "abc", body: "second" }, '"v2"'));
    };

    const { response: res1, cache_status: cs1 } = await withReadCache(req1, "tnt-A", handlerA);
    expect(cs1).toBe("miss");
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { body: string };
    expect(body1.body).toBe("first");

    // Second read should hit the cache and NOT invoke handlerB.
    const { response: res2, cache_status: cs2 } = await withReadCache(req2, "tnt-A", handlerB);
    expect(cs2).toBe("hit");
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { body: string };
    expect(body2.body).toBe("first");
    expect(calls).toBe(1);
  });

  it("cache hit + matching If-None-Match → 304", async () => {
    const url = freshUrl("tickets/inm-match");
    // Prime.
    const primed = await withReadCache(new Request(url, { method: "GET" }), "tnt-A", () =>
      Promise.resolve(json200({ ok: true }, '"v3"')),
    );
    expect(primed.cache_status).toBe("miss");

    const cond = new Request(url, {
      method: "GET",
      headers: { "if-none-match": '"v3"' },
    });
    const { response: res, cache_status } = await withReadCache(cond, "tnt-A", () => {
      throw new Error("handler must not be called on 304 path");
    });
    expect(cache_status).toBe("hit");
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"v3"');
    expect(await res.text()).toBe("");
  });

  it("cache hit + mismatched If-None-Match → 200 cached body", async () => {
    const url = freshUrl("tickets/inm-mismatch");
    // Prime with ETag "v3".
    const primed = await withReadCache(new Request(url, { method: "GET" }), "tnt-A", () =>
      Promise.resolve(json200({ id: "x", v: 3 }, '"v3"')),
    );
    expect(primed.cache_status).toBe("miss");

    const cond = new Request(url, {
      method: "GET",
      headers: { "if-none-match": '"stale"' },
    });
    const { response: res, cache_status } = await withReadCache(cond, "tnt-A", () => {
      throw new Error("handler must not be called on cached-body path");
    });
    expect(cache_status).toBe("hit");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"v3"');
    const body = (await res.json()) as { v: number };
    expect(body.v).toBe(3);
  });

  it("invalidateOnWrite busts both per-doc and parent list keys", async () => {
    // Use a fresh table path so parent / doc URLs are deterministic.
    const tableUrl = `https://baerly-cache.test/v1/t/inv-${++n}-${Date.now().toString(36)}`;
    const docUrl = `${tableUrl}/abc-4`;

    // Prime the list and the per-doc entries.
    let listCalls = 0;
    let docCalls = 0;
    const primeList = await withReadCache(
      new Request(tableUrl, { method: "GET" }),
      "tnt-A",
      () => {
        listCalls++;
        return Promise.resolve(json200({ rows: [] }, '"L1"'));
      },
    );
    expect(primeList.cache_status).toBe("miss");
    const primeDoc = await withReadCache(new Request(docUrl, { method: "GET" }), "tnt-A", () => {
      docCalls++;
      return Promise.resolve(json200({ id: "abc-4" }, '"D1"'));
    });
    expect(primeDoc.cache_status).toBe("miss");
    expect(listCalls).toBe(1);
    expect(docCalls).toBe(1);

    // Confirm warm cache: re-reads do not increment counters.
    const warmList = await withReadCache(
      new Request(tableUrl, { method: "GET" }),
      "tnt-A",
      () => {
        listCalls++;
        return Promise.resolve(json200({}, '"X"'));
      },
    );
    expect(warmList.cache_status).toBe("hit");
    const warmDoc = await withReadCache(new Request(docUrl, { method: "GET" }), "tnt-A", () => {
      docCalls++;
      return Promise.resolve(json200({}, '"X"'));
    });
    expect(warmDoc.cache_status).toBe("hit");
    expect(listCalls).toBe(1);
    expect(docCalls).toBe(1);

    // PATCH the doc → invalidate both keys.
    await invalidateOnWrite(new Request(docUrl, { method: "PATCH" }), "tnt-A", 200);

    // Both re-reads should now miss and call the handler.
    const refillList = await withReadCache(
      new Request(tableUrl, { method: "GET" }),
      "tnt-A",
      () => {
        listCalls++;
        return Promise.resolve(json200({ rows: ["abc-4"] }, '"L2"'));
      },
    );
    expect(refillList.cache_status).toBe("miss");
    const refillDoc = await withReadCache(new Request(docUrl, { method: "GET" }), "tnt-A", () => {
      docCalls++;
      return Promise.resolve(json200({ id: "abc-4", v: 2 }, '"D2"'));
    });
    expect(refillDoc.cache_status).toBe("miss");
    expect(listCalls).toBe(2);
    expect(docCalls).toBe(2);
  });

  it("bypasses /v1/since and /v1/healthz", async () => {
    const sinceUrl = `https://baerly-cache.test/v1/since?cursor=x-${++n}`;
    let sinceCalls = 0;
    const since1 = await withReadCache(
      new Request(sinceUrl, { method: "GET" }),
      "tnt-A",
      () => {
        sinceCalls++;
        return Promise.resolve(json200({ entries: [] }, '"s1"'));
      },
    );
    expect(since1.cache_status).toBe("bypass");
    const since2 = await withReadCache(
      new Request(sinceUrl, { method: "GET" }),
      "tnt-A",
      () => {
        sinceCalls++;
        return Promise.resolve(json200({ entries: [] }, '"s2"'));
      },
    );
    expect(since2.cache_status).toBe("bypass");
    expect(sinceCalls).toBe(2);

    const healthUrl = `https://baerly-cache.test/v1/healthz?probe=${++n}`;
    let healthCalls = 0;
    const health1 = await withReadCache(
      new Request(healthUrl, { method: "GET" }),
      "tnt-A",
      () => {
        healthCalls++;
        return Promise.resolve(json200({ ok: true }, '"h1"'));
      },
    );
    expect(health1.cache_status).toBe("bypass");
    const health2 = await withReadCache(
      new Request(healthUrl, { method: "GET" }),
      "tnt-A",
      () => {
        healthCalls++;
        return Promise.resolve(json200({ ok: true }, '"h2"'));
      },
    );
    expect(health2.cache_status).toBe("bypass");
    expect(healthCalls).toBe(2);
  });

  it("cross-tenant cache isolation (load-bearing security)", async () => {
    // Same URL — different verifier outcomes (`tnt-A` vs `tnt-B`)
    // must NOT share a cache entry.
    const url = freshUrl("xtenant/abc");
    let aCalls = 0;
    let bCalls = 0;

    const { response: resA, cache_status: csA } = await withReadCache(
      new Request(url, { method: "GET" }),
      "tnt-A",
      () => {
        aCalls++;
        return Promise.resolve(json200({ tenant: "A", secret: "A-only" }, '"vA"'));
      },
    );
    expect(csA).toBe("miss");
    const bodyA = (await resA.json()) as { tenant: string; secret: string };
    expect(bodyA.tenant).toBe("A");
    expect(aCalls).toBe(1);

    // Read the same URL as tenant B. Must invoke the B handler and
    // return B's body — NOT A's.
    const { response: resB, cache_status: csB } = await withReadCache(
      new Request(url, { method: "GET" }),
      "tnt-B",
      () => {
        bCalls++;
        return Promise.resolve(json200({ tenant: "B", secret: "B-only" }, '"vB"'));
      },
    );
    expect(csB).toBe("miss");
    const bodyB = (await resB.json()) as { tenant: string; secret: string };
    expect(bCalls).toBe(1);
    expect(bodyB.tenant).toBe("B");
    expect(bodyB.secret).toBe("B-only");

    // And confirm A's cache entry is still there — reading again as
    // A must NOT call the handler.
    const { response: resA2, cache_status: csA2 } = await withReadCache(
      new Request(url, { method: "GET" }),
      "tnt-A",
      () => {
        aCalls++;
        return Promise.resolve(json200({ tenant: "OOPS" }, '"x"'));
      },
    );
    expect(csA2).toBe("hit");
    const bodyA2 = (await resA2.json()) as { tenant: string; secret: string };
    expect(bodyA2.tenant).toBe("A");
    expect(bodyA2.secret).toBe("A-only");
    expect(aCalls).toBe(1);
  });
});

describe("cacheKeyFor", () => {
  it("appends __t scoping param, preserves other params, method is GET", () => {
    const req = new Request("https://baerly-cache.test/v1/t/tickets?limit=10&cursor=abc", {
      method: "POST",
    });
    const key = cacheKeyFor(req, "acme");
    const url = new URL(key.url);
    expect(url.searchParams.get("__t")).toBe("acme");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("cursor")).toBe("abc");
    expect(key.method).toBe("GET");
  });

  it("server-controlled __t wins over caller-supplied ?__t=spoof", () => {
    const req = new Request("https://baerly-cache.test/v1/t/tickets/abc?__t=spoof", {
      method: "GET",
    });
    const key = cacheKeyFor(req, "real-tenant");
    const url = new URL(key.url);
    expect(url.searchParams.get("__t")).toBe("real-tenant");
    // `set` (not `append`) — only one value, no `spoof`.
    expect(url.searchParams.getAll("__t")).toEqual(["real-tenant"]);
  });
});
