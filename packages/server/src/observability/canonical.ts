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

import { CATEGORY, getEffectiveSampleRate, getLogger, type CategoryName } from "./logger.ts";
import {
  createObservabilityContext,
  getCurrentContext,
  runWithContext,
  type ObservabilityContext,
} from "./context.ts";
import { RequestScopedMetricsRecorder } from "./recorder.ts";
import { serializeError } from "./redact.ts";
import { decideSample } from "./sampling.ts";

/** Discriminator for the canonical line's `category` derivation. */
export type Unit = "http" | "writer" | "maintenance" | "compactor" | "gc" | "rebuild";

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
  writer: CATEGORY.writer,
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
 */
export const withObservability = async <T>(
  unit: Exclude<Unit, "http">,
  fn: (ctx: ObservabilityContext, recorder: RequestScopedMetricsRecorder) => Promise<T>,
): Promise<T> => {
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

/** Convenience getter — returns the context if `runWithContext` is active, else `undefined`. */
export const peekContext = (): ObservabilityContext | undefined => getCurrentContext();

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
