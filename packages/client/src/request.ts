import { BaerlyError, isBaerlyErrorCode } from "@baerly/protocol";
import type { HttpErrorEnvelope, HttpOkEnvelope } from "./contract.ts";
import {
  backoffMillis,
  parseRetryAfterMillis,
  REQUEST_RETRY_MAX_ATTEMPTS,
  REQUEST_RETRY_MAX_DELAY_MILLIS,
  sleep,
} from "./request-retry.ts";

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
  /** `false` makes a `GET` single-attempt, for callers that own their own retry loop. */
  readonly retry?: false;
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
      { cause: error, status: res.status },
    );
  }
};

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "AbortError";

/**
 * Decode a non-ok response into the error `request` throws, plus whether
 * the server itself produced it (`enveloped`).
 *
 * No envelope means the response came from something between the
 * caller and the server — a load balancer, CDN, rate limiter, or
 * service mesh — so the server's own failure class is unavailable and
 * we infer one from the status. 5xx, 408 Request Timeout and 429 Too
 * Many Requests are transient conditions that clear on their own, and
 * `NetworkError` is the only synthesized code whose `retriable` says
 * so. `Internal` does not: the React subscription pool treats a
 * non-retriable error as permanently terminal, so labelling a
 * rolling-deploy 502 or an edge 429 `Internal` would park every live
 * query on a dead poll until the user remounted. Any other 4xx without
 * an envelope is a caller or routing fault that retrying cannot clear,
 * so it stays `Internal`.
 *
 * A code this build doesn't know (minted by a newer server, or
 * `Conflict` from an older one) gets the same status-derived code, so
 * a newer server's 503 backpressure keeps a subscription reconnecting
 * and `code` never holds a string outside `BaerlyErrorCode`. Only the
 * message carries over: `resolution`, `issues` and `_id` belong to the
 * undecoded code and would contradict the synthesized one, so the
 * whole wire error rides on `cause` instead.
 */
const decodeFailure = async (
  res: Response,
): Promise<{ readonly error: BaerlyError; readonly enveloped: boolean }> => {
  let envelope: HttpErrorEnvelope | undefined;
  try {
    envelope = (await res.json()) as HttpErrorEnvelope;
  } catch {
    // Non-JSON body (e.g. an upstream proxy 502). Fall through to
    // the synthesized code below so consumers still get a
    // structured throw.
  }
  const wire = envelope?.error;
  const wireCode = wire?.code;
  if (wire !== undefined && isBaerlyErrorCode(wireCode)) {
    return {
      enveloped: true,
      error: new BaerlyError(wireCode, wire.message ?? `HTTP ${res.status}`, {
        issues: wire.issues,
        status: res.status,
        resolution: wire.resolution,
        _id: wire._id,
      }),
    };
  }
  const transient = res.status >= 500 || res.status === 408 || res.status === 429;
  return {
    enveloped: wire !== undefined,
    error: new BaerlyError(
      transient ? "NetworkError" : "Internal",
      wire?.message ?? `HTTP ${res.status}`,
      { cause: wire, status: res.status },
    ),
  };
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
 *   from the status: `NetworkError` for 5xx, `Internal` for 4xx. An
 *   envelope whose code this build doesn't know is treated the same way.
 * - 200 on non-`GET` (PATCH, future mutations) → raw parsed body
 *   as T (e.g. `{ modified }`).
 * - 200 on `GET /v1/since` → raw `SinceResponse` as T (no `data` unwrap).
 * - 200 on any other `GET` → `HttpOkEnvelope<T>.data`.
 *
 * `GET` alone is retried: up to `REQUEST_RETRY_MAX_ATTEMPTS` attempts
 * after a thrown `fetch` or an envelope-less transient failure (5xx, 408,
 * 429), with jittered backoff or the server's `Retry-After` (a hint above
 * `REQUEST_RETRY_MAX_DELAY_MILLIS` ends the retries instead). An enveloped
 * error is never retried — the server adapter already retried it — and an
 * abort stops at once. The final failure is thrown unchanged. Non-`GET`
 * requests make exactly one attempt.
 */
export const request = async <T>(ctx: RequestContext, opts: RequestOptions): Promise<T> => {
  const headers = new Headers(ctx.headers);
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const maxAttempts =
    opts.method === "GET" && opts.retry !== false ? REQUEST_RETRY_MAX_ATTEMPTS : 1;

  for (let attempt = 1; ; attempt++) {
    const retriesLeft = attempt < maxAttempts;
    let res: Response;
    try {
      // A fresh `Request` per attempt: a `Request` is single-use.
      res = await ctx.fetch(
        new Request(`${ctx.baseUrl}${opts.path}`, {
          method: opts.method,
          headers,
          body,
          signal: opts.signal,
        }),
      );
    } catch (error) {
      if (!retriesLeft || opts.signal?.aborted === true || isAbortError(error)) {
        throw error;
      }
      await sleep(backoffMillis(attempt - 1), opts.signal);
      continue;
    }

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

    // 4xx / 5xx — `HttpErrorEnvelope`. Parse + throw, or retry a GET.
    if (!res.ok) {
      const hintMillis = parseRetryAfterMillis(res.headers.get("retry-after"));
      const { error, enveloped } = await decodeFailure(res);
      if (!retriesLeft || enveloped || error.code !== "NetworkError") {
        throw error;
      }
      if (hintMillis !== undefined && hintMillis > REQUEST_RETRY_MAX_DELAY_MILLIS) {
        throw error;
      }
      await sleep(hintMillis ?? backoffMillis(attempt - 1), opts.signal);
      continue;
    }

    // 200 — only GET reads ship `HttpOkEnvelope<T>`. PATCH (and any
    // future non-GET mutation that hits 200) ships its body raw. GET
    // /v1/since also ships raw (`SinceResponse`).
    const parsed = await parseSuccessfulJson(res, opts);
    if (opts.method !== "GET") {
      return parsed as T;
    }
    if (opts.path.startsWith("/v1/since")) {
      return parsed as T;
    }
    if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) {
      throw new BaerlyError(
        "InvalidResponse",
        `Response to ${opts.method} ${opts.path} missing 'data' field`,
        { status: res.status },
      );
    }
    return (parsed as HttpOkEnvelope<T>).data;
  }
};
