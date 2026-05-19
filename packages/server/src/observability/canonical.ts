/**
 * Canonical-log-line flusher.
 *
 * One unit-of-work — an HTTP request, a maintenance tick, a GC
 * sweep, a rebuild run — emits exactly one canonical line at its
 * end. The line carries: the request id, the duration, the
 * outcome string, the HTTP status (when applicable), every entry
 * the per-request {@link RequestScopedMetricsRecorder} accumulated,
 * every entry the {@link ObservabilityContext.fields} bag picked
 * up along the way, and a redacted error structure on the failure
 * path.
 *
 * The line is suppressed when:
 *
 * - `ctx.sampled_by_head === false` AND
 * - `ctx.force_kept_by_error === false` (no error force-keep).
 *
 * Error force-keep mutates `ctx.force_kept_by_error = true` on the
 * way in so a downstream layer that re-reads the context sees the
 * decision was overridden. (`sampled_by_head` stays as the sampler
 * left it — the sampler is one-shot and we don't want to lose that
 * provenance.)
 *
 * Level mapping at emit time:
 *
 * - `error` present → `error`
 * - `status >= 500` → `error`
 * - `status >= 400` → `warn`
 * - otherwise → `info`
 */

import { BaerlyError } from "@baerly/protocol";
import { errorEnvelope } from "../contract.ts";
import { CATEGORY, getEffectiveSampleRate, getLogger, type CategoryName } from "./logger.ts";
import {
  createObservabilityContext,
  getCurrentContext,
  runWithContext,
  type ObservabilityContext,
} from "./context.ts";
import { deriveOutcome } from "./derive-outcome.ts";
import { RequestScopedMetricsRecorder } from "./recorder.ts";
import { serializeError } from "./redact.ts";
import { decideSample } from "./sampling.ts";

/** Discriminator for the canonical line's `category` derivation. */
export type Unit = "http" | "maintenance" | "compactor" | "gc" | "rebuild";

/** Options accepted by {@link flushCanonicalLine}. */
export interface FlushCanonicalLineOptions {
  readonly unit: Unit;
  /** HTTP status code (HTTP unit only). Influences the level decision. */
  readonly status?: number;
  /** Short outcome tag ("ok", "conflict", "not_found", "client_error", "internal_error", ...). */
  readonly outcome: string;
  /** Thrown value on the failure path. Triggers `force_kept_by_error`. */
  readonly error?: unknown;
  /** Caller-supplied extra fields, spread onto the line last (override fields/summary). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

const UNIT_TO_CATEGORY: Readonly<Record<Unit, CategoryName>> = {
  http: CATEGORY.http,
  maintenance: CATEGORY.maintenance,
  compactor: CATEGORY.compactor,
  gc: CATEGORY.gc,
  rebuild: CATEGORY.rebuild,
};

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
  // Force-keep on error path. This flips `force_kept_by_error`
  // for the caller's benefit so subsequent code can detect "we
  // kept this line even though the sampler said no" without
  // re-deriving from the absence of an error.
  if (opts.error !== undefined) {
    ctx.force_kept_by_error = true;
  }

  if (!ctx.force_kept_by_error && !ctx.sampled_by_head) {
    return;
  }

  const level = pickLevel(opts);
  const properties = buildProperties(ctx, recorder, opts, level);
  const logger = getLogger(UNIT_TO_CATEGORY[opts.unit]);

  switch (level) {
    case "error":
      logger.error("canonical", properties);
      return;
    case "warn":
      logger.warn("canonical", properties);
      return;
    case "info":
      logger.info("canonical", properties);
      return;
  }
};

/**
 * Wrap a non-HTTP unit-of-work in a per-request context + recorder,
 * flush the canonical line on completion, and re-throw any error
 * after flushing.
 *
 * Sampling is applied head-style at entry; the body sees an
 * already-decided context and can read `ctx.sampled_by_head` if it
 * wants to skip expensive debug instrumentation. The error path
 * always emits regardless.
 *
 * Nesting-aware: when an outer context is already active (e.g.
 * `runScheduledMaintenance` calling `compact()` / `runGc()`, or a
 * caller wrapping a primitive inside their own scope), this just
 * runs `fn` against the outer ctx+recorder and emits NO separate
 * canonical line — the outer scope owns the line. The invariant is
 * "one unit-of-work, one canonical line"; a nested primitive call
 * is part of the outer unit-of-work, not a unit-of-work of its own.
 */
export const withObservability = async <T>(
  unit: Exclude<Unit, "http">,
  fn: (ctx: ObservabilityContext, recorder: RequestScopedMetricsRecorder) => Promise<T>,
): Promise<T> => {
  const outer = getCurrentContext();
  if (outer !== undefined) {
    // Nested call — inherit outer ctx+recorder, do not flush.
    return fn(outer, outer.recorder);
  }

  const ctx = createObservabilityContext();
  ctx.sampled_by_head = decideSample(ctx.request_id, getEffectiveSampleRate());

  // The recorder lives on the context so adapters (and any code
  // reaching `getCurrentContext()`) can find it; the body callback
  // also receives it positionally for ergonomic emission.
  const recorder = ctx.recorder;

  try {
    const result = await runWithContext(ctx, () => fn(ctx, recorder));
    flushCanonicalLine(ctx, recorder, { unit, outcome: "ok" });
    return result;
  } catch (err) {
    flushCanonicalLine(ctx, recorder, { unit, outcome: "error", error: err });
    throw err;
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
 * did in Mode B (no ambient context): sampling head-style at entry,
 * canonical line on every request in `finally`. Because this wrapper
 * sits OUTSIDE `app.fetch`, errors absorbed by `app.onError` reach the
 * caller as a non-2xx `Response` whose body is the
 * {@link HttpErrorEnvelope}; the helper reconstructs a `BaerlyError`
 * from that envelope so the canonical line carries the same
 * `{ code, message }` shape it would have under the in-Hono middleware.
 */
export const withHttpObservability = async (
  req: Request,
  fetch: (req: Request) => Promise<Response> | Response,
): Promise<Response> => {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const sampleRate = getEffectiveSampleRate();
  const ctx = createObservabilityContext({
    request_id: requestId,
    sampled_by_head: decideSample(requestId, sampleRate),
  });

  const path = new URL(req.url).pathname;

  return runWithContext(ctx, async () => {
    let response: Response | undefined;
    let caughtError: unknown;
    try {
      response = await fetch(req);
      return response;
    } catch (err) {
      // Rare: a throw escaped `app.onError` (e.g. a non-Error
      // rejection that compose rethrows). The caller sees the throw;
      // we record it on the canonical line as best we can.
      caughtError = err;
      throw err;
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
    if (typeof code !== "string" || typeof message !== "string") return undefined;
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
  if (opts.error !== undefined) return "error";
  if (opts.status !== undefined) {
    if (opts.status >= 500) return "error";
    if (opts.status >= 400) return "warn";
  }
  return "info";
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
  if (opts.status !== undefined) props["status"] = opts.status;

  // ctx.fields can override summary entries (operator-driven
  // override); opts.extra wins last so callers retain final say.
  for (const [k, v] of ctx.fields) props[k] = v;
  if (opts.extra !== undefined) Object.assign(props, opts.extra);

  if (opts.error !== undefined) {
    props["error"] = serializeError(opts.error, level === "error");
  }

  return props;
};
