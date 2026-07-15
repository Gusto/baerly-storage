/**
 * Canonical-log-line flusher.
 *
 * One HTTP request emits exactly one canonical line at its end. The
 * line carries: the request id, the duration, the outcome string,
 * the HTTP status, every entry the per-request
 * {@link RequestScopedMetricsRecorder} accumulated, every entry the
 * {@link ObservabilityContext.fields} bag picked up along the way,
 * and a redacted error structure on the failure path.
 *
 * Every HTTP request emits a line; level is computed from
 * status/error.
 *
 * Level mapping at emit time (wire status is authoritative):
 *
 * - `status >= 500` → `error`
 * - `status >= 400` → `warn` (client error — a 4xx is the caller's
 *   fault, not a server fault; an attached structured error, including
 *   a 409 Conflict, does NOT escalate it)
 * - `status` 2xx/3xx with an attached `error` → `error` (anomalous)
 * - no `status`, `error` present → `error`
 * - otherwise → `info`
 */

import { BaerlyError } from "@baerly/protocol";
import { errorEnvelope } from "../contract.ts";
import { CATEGORY, getLogger } from "./logger.ts";
import {
  createObservabilityContext,
  runWithContext,
  type ObservabilityContext,
} from "./context.ts";
import { deriveOutcome } from "./derive-outcome.ts";
import type { RequestScopedMetricsRecorder } from "./recorder.ts";

/** Options accepted by {@link flushCanonicalLine}. */
export interface FlushCanonicalLineOptions {
  readonly unit: "http";
  /** HTTP status code. Influences the level decision. */
  readonly status?: number;
  /**
   * Short outcome tag. In production all callsites route through
   * {@link deriveOutcome} which yields one of `"read"` /
   * `"committed"` / `"conflict"` / `"error"`; the field is typed
   * `string` so test fixtures and future units can pass a
   * unit-specific tag without type gymnastics.
   */
  readonly outcome: string;
  /** Thrown value on the failure path. */
  readonly error?: unknown;
  /** Caller-supplied extra fields, spread onto the line last (override fields/summary). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Emit (or suppress) the canonical line for this unit-of-work.
 *
 * Idempotent in the sense that the caller is expected to call it
 * exactly once per unit-of-work. Calling it twice will produce two
 * lines — there is no internal latch.
 */
export const flushCanonicalLine = (
  ctx: ObservabilityContext,
  recorder: RequestScopedMetricsRecorder,
  opts: FlushCanonicalLineOptions,
): void => {
  const level = pickLevel(opts);
  const properties = buildProperties(ctx, recorder, opts, level);
  const logger = getLogger(CATEGORY.http);

  switch (level) {
    case "error": {
      logger.error("canonical", properties);
      return;
    }
    case "warn": {
      logger.warn("canonical", properties);
      return;
    }
    case "info": {
      logger.info("canonical", properties);
      return;
    }
  }
};

/**
 * HTTP unit-of-work scope. Opens an {@link ObservabilityContext} from the
 * inbound `Request` (request id from `x-request-id` header or generated),
 * runs `fetch(req)` under {@link runWithContext}, and flushes the canonical
 * line in finally with `unit: "http"`.
 *
 * Production adapters open their own context BEFORE calling
 * `createRouter().fetch`; this helper is for standalone callers (tests,
 * one-off harnesses) that want one canonical line per request without
 * managing the bracket themselves.
 *
 * Behaviour mirrors what the legacy `app.use("*", ...)` middleware
 * did in Mode B (no ambient context): canonical line on every
 * request in `finally`. Because this wrapper sits OUTSIDE
 * `app.fetch`, errors absorbed by `app.onError` reach the caller as
 * a non-2xx `Response` whose body is the {@link HttpErrorEnvelope};
 * the helper reconstructs a `BaerlyError` from that envelope so the
 * canonical line carries the same `{ code, message }` shape it would
 * have under the in-Hono middleware.
 */
export const withHttpObservability = async (
  req: Request,
  fetch: (req: Request) => Promise<Response> | Response,
): Promise<Response> => {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const ctx = createObservabilityContext({
    request_id: requestId,
  });

  const path = new URL(req.url).pathname;

  return runWithContext(ctx, async () => {
    let response: Response | undefined;
    let caughtError: unknown;
    try {
      response = await fetch(req);
      return response;
    } catch (error) {
      // Rare: a throw escaped `app.onError` (e.g. a non-Error
      // rejection that compose rethrows). The caller sees the throw;
      // we record it on the canonical line as best we can.
      caughtError = error;
      throw error;
    } finally {
      // Wire status: from the Response when the inner fetch resolved,
      // else 500 for the escaped-throw fallback (matches the
      // adapter-cloudflare worker.ts pattern).
      const status = response !== undefined ? response.status : 500;

      // Reconstruct the structured error from the wire envelope on
      // any non-2xx response. `app.onError` has already converted the
      // original throw into an `HttpErrorEnvelope` body; parsing it
      // back into a `BaerlyError` lets the canonical line carry the
      // same `{ code, message }` shape the in-Hono middleware would
      // have read off `c.error`.
      let effectiveError: unknown = caughtError;
      if (effectiveError === undefined && response !== undefined && status >= 400) {
        effectiveError = await reconstructErrorFromEnvelope(response);
      }

      flushCanonicalLine(ctx, ctx.recorder, {
        unit: "http",
        status,
        outcome: deriveOutcome(req.method, status, effectiveError),
        ...(effectiveError !== undefined && { error: effectiveError }),
        extra: { method: req.method, path },
      });
    }
  });
};

/**
 * Best-effort BaerlyError reconstruction from a non-2xx
 * {@link HttpErrorEnvelope}. Used by {@link withHttpObservability} to
 * preserve the canonical-line `error` shape across `app.onError`
 * (which swallows the original throw).
 *
 * Failures (non-JSON body, missing fields, already-consumed stream)
 * fall through to `undefined` — the canonical line then surfaces only
 * the wire status, which is the worst-case behaviour the legacy
 * middleware would have produced on an unrecognised throw shape.
 */
const reconstructErrorFromEnvelope = async (response: Response): Promise<unknown> => {
  try {
    const body = (await response.clone().json()) as {
      readonly error?: { readonly code?: string; readonly message?: string };
    };
    const code = body.error?.code;
    const message = body.error?.message;
    if (typeof code !== "string" || typeof message !== "string") {
      return undefined;
    }
    return new BaerlyError(code as BaerlyError["code"], message);
  } catch {
    return undefined;
  }
};

/**
 * Verifier rejected the request — log the warn, flush the canonical
 * line, and return the 401 envelope Response. Adapters call this
 * inside `runWithContext(obsCtx, ...)` so the canonical line lands on
 * the same context the rest of the request would have used.
 *
 * Both adapters share this so the 401 wire shape AND the
 * observability record are byte-identical across runtimes.
 */
export const flushUnauthorizedAndRespond = (
  obsCtx: ObservabilityContext,
  req: Request,
): Response => {
  getLogger(CATEGORY.http).warn("verifier_rejected", { reason: "null" });
  const path = new URL(req.url).pathname;
  flushCanonicalLine(obsCtx, obsCtx.recorder, {
    unit: "http",
    status: 401,
    outcome: "error",
    extra: { method: req.method, path },
  });
  return new Response(
    JSON.stringify(errorEnvelope("Unauthorized", "Missing or invalid Authorization header")),
    { status: 401, headers: { "content-type": "application/json" } },
  );
};

// ---------- internals ----------

type Level = "info" | "warn" | "error";

const pickLevel = (opts: FlushCanonicalLineOptions): Level => {
  // Wire status is authoritative when present. A client error (4xx) is a
  // `warn` even when a structured error is attached (as
  // `withHttpObservability` reconstructs one for every non-2xx). This is
  // deliberate: a 4xx is the caller's fault, not a server fault. The
  // reachable 409 is a duplicate-`_id` insert (a reused id or a
  // double-submitted POST); ordinary write contention is absorbed by the
  // log forward-probe as a 412 counter, not a client 409. 401/404/400 are
  // likewise the caller's fault. Escalating any of them to `error` would
  // burn error budget and page on-call for normal operation. `error` is
  // reserved for genuine server faults.
  if (opts.status !== undefined) {
    if (opts.status >= 500) {
      return "error";
    }
    if (opts.status >= 400) {
      return "warn";
    }
    // A 2xx/3xx that still carries an error is anomalous (a throw that
    // resolved a success status) — surface it.
    return opts.error !== undefined ? "error" : "info";
  }
  // No wire status to classify by (e.g. an escaped throw before a
  // Response existed): an attached error is all we have to go on.
  return opts.error !== undefined ? "error" : "info";
};

const buildProperties = (
  ctx: ObservabilityContext,
  recorder: RequestScopedMetricsRecorder,
  opts: FlushCanonicalLineOptions,
  level: Level,
): Record<string, unknown> => {
  const duration_ms = Math.max(0, performance.now() - ctx.started_at);
  const props: Record<string, unknown> = {
    ...recorder.summarize(),
    request_id: ctx.request_id,
    duration_ms,
    outcome: opts.outcome,
  };
  if (opts.status !== undefined) {
    props["status"] = opts.status;
  }

  // ctx.fields can override summary entries (operator-driven
  // override); opts.extra wins last so callers retain final say.
  for (const [k, v] of ctx.fields) {
    props[k] = v;
  }
  if (opts.extra !== undefined) {
    Object.assign(props, opts.extra);
  }

  if (opts.error !== undefined) {
    props["error"] = serializeError(opts.error, level === "error");
  }

  return props;
};

/**
 * Shape carried by the canonical line under its `error` key.
 *
 * `code` is one of `BaerlyErrorCode` for known `BaerlyError`s, or the
 * literal `"Internal"` for anything else. The string-typing keeps the
 * consumer-side handling grep-friendly.
 */
export interface SerializedError {
  readonly code: string;
  readonly message: string;
  readonly stack?: string;
}

/**
 * Convert an unknown thrown value into a {@link SerializedError}.
 *
 * Two rules:
 *
 * 1. `BaerlyError` — preserve its `code` discriminant verbatim.
 * 2. Any other error or non-error value — collapse to
 *    `{ code: "Internal", message: <stringified> }`.
 *
 * Stacks are included when `includeStack` is `true`. Callers pass
 * `level === "error"` to honor the "stacks only at error level" rule.
 *
 * @param err The thrown value (anything `try { ... } catch (e)` can yield).
 * @param includeStack If `true`, include the stack trace when `err` is
 *   an `Error` (or `BaerlyError`) with a `stack` property. Defaults to `false`.
 */
export const serializeError = (err: unknown, includeStack = false): SerializedError => {
  if (err instanceof BaerlyError) {
    const base: SerializedError = { code: err.code, message: err.message };
    return includeStack && err.stack !== undefined ? { ...base, stack: err.stack } : base;
  }

  if (err instanceof Error) {
    const base: SerializedError = { code: "Internal", message: err.message };
    return includeStack && err.stack !== undefined ? { ...base, stack: err.stack } : base;
  }

  if (typeof err === "object" && err !== null) {
    try {
      return { code: "Internal", message: JSON.stringify(err) };
    } catch {
      return { code: "Internal", message: "[unserializable object]" };
    }
  }
  return { code: "Internal", message: String(err) };
};
