import { BaerlyError, type BaerlyErrorCode } from "@baerly/protocol";
import type { HttpErrorEnvelope, HttpOkEnvelope } from "./contract.ts";

/**
 * Pluggable fetch implementation. Defaults to `globalThis.fetch`;
 * tests override with a {@link MockFetch}.
 */
export type Fetcher = (req: Request) => Promise<Response>;

export interface RequestOptions {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * Internal carrier passed to every {@link request} call. Built once
 * by `createBaerlyClient` from `BaerlyClientOptions`.
 *
 * `headers` is the shared template; callers MUST clone before
 * mutating (each request adds `content-type`).
 */
export interface RequestContext {
  readonly baseUrl: string;
  readonly fetch: Fetcher;
  readonly headers: Headers;
}

const parseSuccessfulJson = async (
  res: Response,
  opts: Pick<RequestOptions, "method" | "path">,
): Promise<unknown> => {
  try {
    return await res.json();
  } catch (error) {
    throw new BaerlyError(
      "InvalidResponse",
      `Response to ${opts.method} ${opts.path} was not valid JSON`,
      error,
      undefined,
      res.status,
    );
  }
};

/**
 * Issue one HTTP request and unwrap the response per the locked
 * status-code policy in `packages/server/src/contract.ts:73-89`:
 *
 * - 204 → `undefined as T` (DELETE success — no body).
 * - 201 → raw parsed body as T (POST insert success — body `{ _id }`).
 * - 4xx / 5xx → parse `HttpErrorEnvelope` and throw
 *   {@link BaerlyError} with `status` set to the wire HTTP code.
 *   Bodies that carry no envelope (a proxy or CDN answering for the
 *   server) still get a structured throw, with the code synthesized
 *   from the status: `NetworkError` for 5xx, `Internal` for 4xx.
 * - 200 on non-`GET` (PATCH, future mutations) → raw parsed body
 *   as T (e.g. `{ modified }`).
 * - 200 on `GET /v1/since` → raw `SinceResponse` as T (no `data` unwrap).
 * - 200 on any other `GET` → `HttpOkEnvelope<T>.data`.
 */
export const request = async <T>(ctx: RequestContext, opts: RequestOptions): Promise<T> => {
  const headers = new Headers(ctx.headers);
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const init: RequestInit = {
    method: opts.method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  };
  const req = new Request(`${ctx.baseUrl}${opts.path}`, init);
  const res = await ctx.fetch(req);

  // 204 No Content — never a body; cast the "no value" to T. The
  // only caller (`delete`) types T = undefined so this is safe.
  if (res.status === 204) {
    return undefined as T;
  }

  // 201 Created — body is `{ _id }`, not `HttpOkEnvelope`. The only
  // caller (`insert`) types T = `{ _id }` so we return the parsed
  // body raw.
  if (res.status === 201) {
    return (await parseSuccessfulJson(res, opts)) as T;
  }

  // 4xx / 5xx — `HttpErrorEnvelope`. Parse + throw.
  if (!res.ok) {
    let envelope: HttpErrorEnvelope | undefined;
    try {
      envelope = (await res.json()) as HttpErrorEnvelope;
    } catch {
      // Non-JSON body (e.g. an upstream proxy 502). Fall through to
      // the synthesized code below so consumers still get a
      // structured throw.
    }
    // No envelope means the response came from something between the
    // caller and the server — a load balancer, CDN, or service mesh —
    // so the server's own failure class is unavailable and we infer
    // one from the status. A 5xx from that layer is a transport
    // condition that clears when the backend comes back, and
    // `NetworkError` is the only synthesized code whose default
    // `retriable` says so. `Internal` does not: the React
    // subscription pool treats a non-retriable error as permanently
    // terminal, so labelling a rolling-deploy 502 `Internal` would
    // park every live query on a dead poll until the user remounted.
    // A 4xx without an envelope is a caller or routing fault, which
    // retrying cannot clear — it stays `Internal`.
    const synthesized: BaerlyErrorCode = res.status >= 500 ? "NetworkError" : "Internal";
    const code: BaerlyErrorCode = envelope?.error?.code ?? synthesized;
    const message = envelope?.error?.message ?? `HTTP ${res.status}`;
    throw new BaerlyError(
      code,
      message,
      undefined,
      envelope?.error?.issues,
      res.status,
      envelope?.error?.resolution,
      envelope?.error?.retriable,
    );
  }

  // 200 — only GET reads ship `HttpOkEnvelope<T>`. PATCH (and any
  // future non-GET mutation that hits 200) ships its body raw. GET
  // /v1/since also ships raw (`SinceResponse`).
  const body = await parseSuccessfulJson(res, opts);
  if (opts.method !== "GET") {
    return body as T;
  }
  if (opts.path.startsWith("/v1/since")) {
    return body as T;
  }
  if (typeof body !== "object" || body === null || !("data" in body)) {
    throw new BaerlyError(
      "InvalidResponse",
      `Response to ${opts.method} ${opts.path} missing 'data' field`,
      undefined,
      undefined,
      res.status,
    );
  }
  return (body as HttpOkEnvelope<T>).data;
};
