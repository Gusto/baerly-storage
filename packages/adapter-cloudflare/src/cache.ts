/**
 * Cloudflare Cache API integration for the Worker read path.
 * Worker-only; Node has no equivalent and runs cache-less.
 *
 * Contract:
 *  - Only `GET /v1/t/:table` and `GET /v1/t/:table/:id` are cached.
 *  - `GET /v1/since` and `GET /v1/healthz` bypass the cache (the
 *    long-poll's mutating cursor is not cacheable; healthz is
 *    trivially fast and must never go stale).
 *  - Cache key is the request URL + a synthetic `__t=<tenantPrefix>`
 *    query param. This is the load-bearing correctness invariant:
 *    the HTTP contract derives `tenant` from the `Verifier`, not the
 *    URL, so two different Verifier outcomes against the same URL
 *    must NOT share a cache entry. See `packages/server/src/contract.ts`.
 *  - Only 200 responses with non-empty bodies are stored. 401/403/
 *    404/409/500 always bypass `cache.put`. Negative caching is out
 *    of scope (see ticket §Q5).
 *  - Writes (`POST` / `PATCH` / `DELETE`) that return 2xx call
 *    `cache.delete(...)` for every URL their mutation could invalidate:
 *    the per-doc URL (for PATCH / DELETE) and the parent list URL
 *    (for POST / PATCH / DELETE). Best-effort — failures are swallowed.
 *  - No `Cache-Control` header is added. We rely on explicit
 *    invalidation, not TTLs (see ticket §Q2).
 */

/**
 * Methods we treat as mutating for invalidation purposes. Keep this
 * list narrow — adding a method to `WRITE_METHODS` doubles the
 * invalidation surface and matters for correctness.
 */
const WRITE_METHODS = new Set<string>(["POST", "PATCH", "DELETE"]);

/** Pathname prefixes that bypass the cache entirely. */
const BYPASS_PREFIXES = ["/v1/since", "/v1/healthz"];

/**
 * Per-isolate index of LIST cache keys we have populated, keyed by
 * `(tenantPrefix, table)`. Used by {@link invalidateOnWrite} to walk
 * every filtered-URL variant the isolate has cached and `cache.delete`
 * each on a write. Without this index, the Cloudflare Cache API gives
 * us no way to enumerate keys, so a `POST /v1/t/orders` could not bust
 * a cached `GET /v1/t/orders?where={...}` — that GET would serve stale
 * results for up to `max-age=3600` (the TTL the cache was put under).
 *
 * Lifetime tracks the read cache: entries are added on `cache.put` and
 * removed either on {@link invalidateOnWrite} (write-driven sweep) or
 * via the per-entry timer started at put-time (matches the
 * `max-age=3600` TTL so the index never points at a key the cache has
 * already dropped).
 *
 * Bounded by {@link MAX_KEYS_PER_TABLE} per `(tenant, table)` pair via
 * insertion-order eviction (oldest URL is dropped when the cap is
 * reached, which matches the cache's own LRU-ish eviction on memory
 * pressure).
 */
const LIST_KEY_INDEX: Map<string, Map<string, ReturnType<typeof setTimeout>>> = new Map();

/** Per-`(tenant, table)` cap on tracked list URLs. */
const MAX_KEYS_PER_TABLE = 256;

/** Cache TTL — MUST match the `max-age=3600` literal we set on `cache.put`. */
const CACHE_TTL_MS = 3600 * 1000;

/**
 * Compose the index key from tenantPrefix + table. Identical shape
 * means a write under tenant `t1` does NOT scan tenant `t2`'s tracked
 * URLs.
 */
const indexKeyFor = (tenantPrefix: string, table: string): string =>
  `${tenantPrefix}|${table}`;

/**
 * Pull the table segment from a `/v1/t/<table>[/<id>]` pathname.
 * Returns `null` for paths outside `/v1/t/`. Callers must pre-filter
 * via the `pathname.startsWith("/v1/t/")` check before dispatching to
 * cache logic.
 */
const tableFromPath = (pathname: string): string | null => {
  const parts = pathname.split("/").filter(Boolean);
  // parts[0] === "v1", parts[1] === "t", parts[2] === table, parts[3] === id (optional)
  if (parts.length < 3 || parts[0] !== "v1" || parts[1] !== "t") return null;
  return parts[2] ?? null;
};

/**
 * Record that `keyUrl` (the canonical cache-key URL — already carries
 * the synthetic `__t` param from {@link cacheKeyFor}) is a live LIST
 * entry for `(tenantPrefix, table)`. Starts a TTL timer that drops the
 * entry when the cached body expires.
 *
 * If the inner map exceeds {@link MAX_KEYS_PER_TABLE}, evict the
 * oldest entry (insertion-order via Map iteration; matches the cache's
 * own eventual eviction).
 */
function trackListUrl(tenantPrefix: string, table: string, keyUrl: string): void {
  const indexKey = indexKeyFor(tenantPrefix, table);
  let inner = LIST_KEY_INDEX.get(indexKey);
  if (inner === undefined) {
    inner = new Map();
    LIST_KEY_INDEX.set(indexKey, inner);
  }
  // Refresh: clear any pending eviction timer on a repeat put. Drop +
  // re-insert so insertion-order tracking sees this as a fresh entry,
  // which keeps the LRU-ish eviction honest.
  const existing = inner.get(keyUrl);
  if (existing !== undefined) {
    clearTimeout(existing);
    inner.delete(keyUrl);
  }
  // Cap to MAX_KEYS_PER_TABLE — drop oldest if full.
  if (inner.size >= MAX_KEYS_PER_TABLE) {
    const oldest = inner.keys().next().value;
    if (typeof oldest === "string") {
      const t = inner.get(oldest);
      if (t !== undefined) clearTimeout(t);
      inner.delete(oldest);
    }
  }
  const timer = setTimeout(() => {
    const m = LIST_KEY_INDEX.get(indexKey);
    if (m !== undefined) {
      m.delete(keyUrl);
      if (m.size === 0) LIST_KEY_INDEX.delete(indexKey);
    }
  }, CACHE_TTL_MS);
  // workerd's setTimeout does not return a Node `Timer` with .unref();
  // the return value is a numeric id. We don't need .unref() on
  // workerd — the runtime tears down all isolate state on shutdown.
  inner.set(keyUrl, timer);
}

/**
 * Build the canonical cache-key `Request` for a given `(req,
 * tenantPrefix)`. The synthetic `__t` query parameter scopes the
 * cache per-tenant; without it, two tenants with overlapping URLs
 * would share entries — a security bug.
 *
 * The returned `Request` is GET-only by construction — even when
 * `req.method` is POST/PATCH/DELETE we use the GET form for
 * `cache.delete()` so the read-side write and the write-side bust
 * land on the same key.
 */
export function cacheKeyFor(req: Request, tenantPrefix: string): Request {
  const url = new URL(req.url);
  // `set` not `append` — defends against a malicious caller-supplied
  // `?__t=spoof`. The server-controlled value always wins.
  url.searchParams.set("__t", tenantPrefix);
  return new Request(url.toString(), { method: "GET" });
}

/**
 * Should this request bypass the cache layer entirely (both read and
 * invalidate sides)? Healthz + long-poll + anything not under `/v1/t/`.
 */
function bypassesCache(url: URL): boolean {
  if (BYPASS_PREFIXES.some((p) => url.pathname.startsWith(p))) return true;
  // Restrict cache scope to the table routes. Future non-table read
  // routes can opt in by adding their prefix here.
  if (!url.pathname.startsWith("/v1/t/")) return true;
  return false;
}

/**
 * Discriminator returned alongside the response so the adapter can
 * stamp `cache_status` on the canonical line. The cache itself
 * doesn't emit — the adapter owns the canonical line.
 *
 *  - `"hit"`    — the cache returned an entry (both the 304
 *                 If-None-Match path and the body-bearing 200 path
 *                 classify as hits; the cache served the request
 *                 without invoking the handler).
 *  - `"miss"`   — the request was cacheable but the cache had no
 *                 entry; the handler ran and (when the response was
 *                 cacheable) its output was stored.
 *  - `"bypass"` — the request never consulted the cache (non-GET,
 *                 or a path under {@link BYPASS_PREFIXES}, or a path
 *                 outside `/v1/t/`).
 */
export type CacheStatus = "hit" | "miss" | "bypass";

/**
 * Discriminator-tagged return value of {@link withReadCache}. The
 * adapter stamps `cache_status` onto the canonical-line `extra` bag
 * before flushing — see `worker.ts`'s `fetch` handler.
 */
export interface ReadCacheResult {
  readonly response: Response;
  readonly cache_status: CacheStatus;
}

/**
 * Read-path wrapper. Call this in place of invoking the router
 * directly for `GET` requests. Returns `{ response, cache_status }`
 * so the adapter can stamp `cache_status` on the canonical line:
 *
 *  - `cache_status: "bypass"` — non-GET method, or a path under
 *    {@link BYPASS_PREFIXES} (`/v1/since`, `/v1/healthz`), or a path
 *    outside `/v1/t/`. The handler runs verbatim and its response
 *    is returned untouched.
 *  - `cache_status: "hit"`    — the cache had an entry. Returns
 *    either a synthesized 304 (when `If-None-Match` matches the
 *    cached ETag) or the cached body (200). The handler does NOT
 *    run.
 *  - `cache_status: "miss"`   — the cache had no entry. The handler
 *    runs and, if the response is a cacheable 200 with no
 *    `Set-Cookie`, the response is stored before being returned.
 */
export async function withReadCache(
  req: Request,
  tenantPrefix: string,
  handler: () => Promise<Response>,
): Promise<ReadCacheResult> {
  const url = new URL(req.url);
  if (req.method !== "GET" || bypassesCache(url)) {
    return { response: await handler(), cache_status: "bypass" };
  }

  // `caches.default` is Workers-only; DOM's `CacheStorage` lib type
  // doesn't expose it, so we cast through `unknown` to the shape we
  // need. miniflare provides the real binding at runtime.
  const cache = (caches as unknown as { default: Cache }).default;
  const key = cacheKeyFor(req, tenantPrefix);
  const cached = await cache.match(key);
  if (cached !== undefined) {
    const etag = cached.headers.get("etag");
    const ifNoneMatch = req.headers.get("if-none-match");
    if (etag !== null && ifNoneMatch !== null && etag === ifNoneMatch) {
      // 304 has no body, but keeps the ETag so a CDN-aware client
      // can continue revalidating against it.
      return {
        response: new Response(null, {
          status: 304,
          headers: { etag },
        }),
        cache_status: "hit",
      };
    }
    // Body-bearing hit. Clone so the cache entry stays intact for
    // the next request in the same Worker isolate. Strip the
    // synthetic `Cache-Control` header we added at `cache.put` time
    // so the client never sees TTLs we don't honor (§Q2:
    // invalidation-only on the wire).
    const cloned = cached.clone();
    const outHeaders = new Headers(cloned.headers);
    outHeaders.delete("cache-control");
    return {
      response: new Response(cloned.body, {
        status: cloned.status,
        statusText: cloned.statusText,
        headers: outHeaders,
      }),
      cache_status: "hit",
    };
  }

  const fresh = await handler();
  // Only cache stable 200 responses with a non-empty body. The Cache
  // API silently rejects responses with `Set-Cookie`; baerly never
  // sets cookies, but the guard is cheap insurance.
  if (fresh.status === 200 && !fresh.headers.has("set-cookie")) {
    // workerd's `caches.default.put` silently no-ops on responses
    // without a cacheable `Cache-Control` directive. We synthesize
    // one ONLY on the response we hand the cache — the response we
    // return to the caller is untouched (§Q2: invalidation-only on
    // the wire). The TTL value is large because we rely on explicit
    // `invalidateOnWrite` busts, not expiry.
    const headers = new Headers(fresh.headers);
    headers.set("cache-control", "max-age=3600");
    const cacheable = new Response(fresh.clone().body, {
      status: fresh.status,
      statusText: fresh.statusText,
      headers,
    });
    await cache.put(key, cacheable);

    // Track LIST-shape URLs (no `/<id>` segment) so a future write can
    // enumerate-and-bust every filtered variant we've cached. Per-doc
    // URLs (parts.length === 4) don't need indexing — they have a 1:1
    // mapping the write side already knows how to bust by URL.
    const table = tableFromPath(url.pathname);
    if (table !== null) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 3) {
        trackListUrl(tenantPrefix, table, key.url);
      }
    }
  }
  return { response: fresh, cache_status: "miss" };
}

/**
 * Write-path companion. Call this AFTER the handler returns a 2xx
 * for `POST` / `PATCH` / `DELETE`. Invalidates every cache key the
 * mutation could affect:
 *
 *  - `PATCH` / `DELETE /v1/t/:table/:id`  → bust `(table, id)` AND
 *    the parent `(table)` list.
 *  - `POST /v1/t/:table`                  → bust the parent `(table)`
 *    list (the new doc has no prior cache entry).
 *
 * Returns silently on any cache.delete failure — invalidation is
 * best-effort, and a stale entry is recoverable via the 304 path on
 * the next read.
 */
export async function invalidateOnWrite(
  req: Request,
  tenantPrefix: string,
  responseStatus: number,
): Promise<void> {
  if (!WRITE_METHODS.has(req.method)) return;
  if (responseStatus < 200 || responseStatus >= 300) return;

  const url = new URL(req.url);
  if (!url.pathname.startsWith("/v1/t/")) return;

  // `caches.default` is Workers-only; DOM's `CacheStorage` lib type
  // doesn't expose it, so we cast through `unknown` to the shape we
  // need. miniflare provides the real binding at runtime.
  const cache = (caches as unknown as { default: Cache }).default;
  const reqsToDelete: Request[] = [];

  // Always invalidate the URL the write itself hit (covers
  // /v1/t/:table/:id for PATCH/DELETE and /v1/t/:table for POST).
  reqsToDelete.push(cacheKeyFor(req, tenantPrefix));

  // Bust every tracked filtered-list variant for this table. Without
  // this index walk, a POST `/v1/t/orders` would leave
  // `GET /v1/t/orders?where={...}` cached and stale for up to
  // `max-age=3600` — the Cloudflare Cache API has no wildcard or
  // tag-based delete, so we have to remember each URL we put.
  const table = tableFromPath(url.pathname);
  if (table !== null) {
    const indexKey = indexKeyFor(tenantPrefix, table);
    const tracked = LIST_KEY_INDEX.get(indexKey);
    if (tracked !== undefined) {
      for (const [keyUrl, timer] of tracked) {
        clearTimeout(timer);
        // The stored `keyUrl` already includes the synthetic `__t`
        // param (it was `cacheKeyFor(...).url` at put-time), so we
        // reconstruct the GET Request without a second pass through
        // `cacheKeyFor`.
        reqsToDelete.push(new Request(keyUrl, { method: "GET" }));
      }
      LIST_KEY_INDEX.delete(indexKey);
    }

    // Belt-and-braces: also bust the bare list URL even if it was
    // never tracked (a concurrent GET could have populated the cache
    // between the index walk and now). Cheap; one extra delete.
    const bareList = new URL(url.toString());
    bareList.pathname = `/v1/t/${table}`;
    bareList.search = "";
    reqsToDelete.push(
      cacheKeyFor(new Request(bareList.toString(), { method: "GET" }), tenantPrefix),
    );
  }

  // Fire all deletes in parallel. Errors are swallowed; cache
  // invalidation failures are non-fatal.
  await Promise.allSettled(reqsToDelete.map((r) => cache.delete(r)));
}

/**
 * Test-only — clears the per-isolate list-URL index. Call from
 * `afterEach` in cache-status.test.ts so cross-test state doesn't
 * leak. Not part of the package's public API; intentionally
 * undocumented for callers.
 *
 * @internal
 */
// eslint-disable-next-line no-underscore-dangle -- `__`-prefix marks the test-only escape hatch
export function __resetListUrlIndexForTests(): void {
  for (const inner of LIST_KEY_INDEX.values()) {
    for (const timer of inner.values()) clearTimeout(timer);
  }
  LIST_KEY_INDEX.clear();
}
