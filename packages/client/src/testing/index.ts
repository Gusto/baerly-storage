import type { Fetcher } from "../request.ts";

/**
 * In-memory `fetch` impl for unit tests. Construct one, register
 * response handlers per `method + path` pattern, and pass it as the
 * `BaerlyClient`'s `fetch` option.
 *
 * `MockFetch` is NOT a full HTTP-server impl — it doesn't honour
 * query-string variation or body content beyond what each handler
 * inspects manually. Each `on(...)` call binds a method + path-
 * template; the matched handler runs the request arbitrarily.
 *
 * Internal-only: imported by `@baerly/client`'s own tests via
 * relative paths; not re-exported through the `baerly-storage`
 * subpath map.
 *
 * @example
 * ```ts
 * const mock = new MockFetch();
 * mock.on("GET", "/v1/c/tickets", () =>
 *   new Response(JSON.stringify({
 *     data: [{ _id: "a" }],
 *     _meta: { manifest_pointer: "none@0", fresh: true },
 *   })),
 * );
 * const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
 * const rows = await client.collection("tickets").where({}).all();
 * ```
 */
export class MockFetch {
  private handlers: Array<{
    method: string;
    pattern: RegExp;
    handle: (req: Request) => Promise<Response> | Response;
  }> = [];

  /**
   * Register a handler. `pathPattern` is either a string template
   * (with `:name` segments → `[^/]+` and static text regex-escaped)
   * or a raw `RegExp` for advanced matches. The matched range
   * includes the query-string boundary so `"/v1/c/tickets"` also
   * matches `/v1/c/tickets?where=...`.
   */
  on(
    method: string,
    pathPattern: string | RegExp,
    handle: (req: Request) => Promise<Response> | Response,
  ): this {
    const pattern =
      typeof pathPattern === "string"
        ? new RegExp(
            `^${pathPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-zA-Z]+/g, "[^/]+")}(?:\\?|$)`,
          )
        : pathPattern;
    this.handlers.push({ method: method.toUpperCase(), pattern, handle });
    return this;
  }

  /**
   * The `fetch`-compatible function to pass into
   * `createBaerlyClient({ fetch })`. Returns a 500 with an
   * `HttpErrorEnvelope`-shaped body when no handler matches —
   * surfaces as a `BaerlyError` in tests so unhandled paths
   * fail loudly.
   */
  fetch: Fetcher = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    for (const h of this.handlers) {
      if (h.method !== req.method) {
        continue;
      }
      if (!h.pattern.test(url.pathname + url.search)) {
        continue;
      }
      return h.handle(req);
    }
    return new Response(
      JSON.stringify({
        error: {
          code: "Internal",
          message: `MockFetch: no handler for ${req.method} ${url.pathname}`,
        },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  };
}
