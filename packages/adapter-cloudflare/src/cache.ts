/**
 * Cloudflare Cache API integration for the Worker read path.
 * Worker-only; Node has no equivalent and runs cache-less.
 *
 * Contract:
 *  - Only `GET /v1/t/:table/:id` is cached. LIST URLs
 *    (`GET /v1/t/:table`, with or without filters) bypass the cache.
 *    The Cloudflare Cache API exposes no enumeration primitive, so
 *    filtered-LIST variants (`?where=...`) cannot be safely
 *    invalidated on writes; rather than ship a per-isolate index
 *    that only partially survives across the colo-shared cache, we
 *    skip list caching entirely. If LIST caching ever becomes a
 *    bottleneck, revisit with a cross-isolate primitive (CF Cache
 *    Tags, KV-backed invalidation, etc).
 *  - `GET /v1/since` and `GET /v1/healthz` also bypass the cache
 *    (the long-poll's mutating cursor is not cacheable; healthz is
 *    trivially fast and must never go stale).
 *  - Cache key is the request URL + a synthetic `__t=<tenantPrefix>`
 *    query param. This is the load-bearing correctness invariant:
 *    the HTTP contract derives `tenant` from the `Verifier`, not the
 *    URL, so two different Verifier outcomes against the same URL
 *    must NOT share a cache entry. See `packages/server/src/contract.ts`.
 *  - Only 200 responses with non-empty bodies are stored. 401/403/
 *    404/409/500 always bypass `cache.put`. Negative caching is out
 *    of scope.
 *  - `PATCH` / `DELETE` that return 2xx call `cache.delete()` on the
 *    per-doc URL they hit. `POST` targets a LIST URL (uncached), so
 *    nothing to bust. Best-effort — failures are swallowed.
 *  - No `Cache-Control` header is added on the wire. We rely on
 *    explicit invalidation, not TTLs.
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
 * `Cache-Control: max-age=<n>` value we set on the cacheable response
 * handed to `cache.put`. workerd's `caches.default.put` silently
 * no-ops on responses without a cacheable directive, so we synthesize
 * one. The value is large because we rely on explicit per-doc
 * invalidation, not expiry — see `invalidateOnWrite`.
 */
const CACHE_TTL_SECONDS = 3600;

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
 * invalidate sides)? Healthz + long-poll + anything that isn't a
 * per-doc URL (`/v1/t/:table/:id`).
 */
function bypassesCache(url: URL): boolean {
  if (BYPASS_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    return true;
  }
  if (!url.pathname.startsWith("/v1/t/")) {
    return true;
  }
  // LIST URLs (`/v1/t/<table>` with no `/<id>`) bypass — see header
  // docstring for why filtered-LIST caching isn't safe here.
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4) {
    return true;
  }
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
 *                 LIST URL, a path under {@link BYPASS_PREFIXES}, or
 *                 a path outside `/v1/t/`).
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
 *  - `cache_status: "bypass"` — non-GET method, LIST URL, or a path
 *    under {@link BYPASS_PREFIXES} (`/v1/since`, `/v1/healthz`), or
 *    a path outside `/v1/t/`. The handler runs verbatim and its
 *    response is returned untouched.
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
    // so the client never sees TTLs we don't honor (invalidation-only
    // on the wire).
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
    // return to the caller is untouched (invalidation-only on the
    // wire).
    const headers = new Headers(fresh.headers);
    headers.set("cache-control", `max-age=${CACHE_TTL_SECONDS}`);
    const cacheable = new Response(fresh.clone().body, {
      status: fresh.status,
      statusText: fresh.statusText,
      headers,
    });
    await cache.put(key, cacheable);
  }
  return { response: fresh, cache_status: "miss" };
}

/**
 * Write-path companion. Call this AFTER the handler returns a 2xx
 * for `PATCH` / `DELETE` on a per-doc URL — busts the cache entry
 * for that URL. `POST` targets a LIST URL (uncached), so nothing to
 * bust; this function returns without touching the cache. Failures
 * are swallowed; a stale entry is recoverable via the 304 path on
 * the next read.
 */
export async function invalidateOnWrite(
  req: Request,
  tenantPrefix: string,
  responseStatus: number,
): Promise<void> {
  if (!WRITE_METHODS.has(req.method)) {
    return;
  }
  if (responseStatus < 200 || responseStatus >= 300) {
    return;
  }
  const url = new URL(req.url);
  if (bypassesCache(url)) {
    return;
  }
  // `caches.default` is Workers-only; DOM's `CacheStorage` lib type
  // doesn't expose it, so we cast through `unknown` to the shape we
  // need. miniflare provides the real binding at runtime.
  const cache = (caches as unknown as { default: Cache }).default;
  await cache.delete(cacheKeyFor(req, tenantPrefix));
}
