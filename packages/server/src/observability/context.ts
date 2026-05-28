/**
 * Per-request observability context.
 *
 * One `ObservabilityContext` is created at the entry of each unit-of-
 * work (HTTP request, maintenance tick, GC sweep, rebuild run) and
 * carried through the call tree via {@link runWithContext} /
 * {@link getCurrentContext}, which delegates to a single module-level
 * `AsyncLocalStorage` instance.
 *
 * The context is intentionally tiny: an externally-set
 * {@link request_id}, a high-resolution `started_at`, and a mutable
 * {@link fields} bag used to accumulate canonical-line attributes
 * during the unit's lifecycle.
 *
 * The context shape is `readonly` everywhere it can be — only the
 * contents of `fields` are intended to mutate during a request. The
 * {@link fields} map itself is not `readonly` because callers (the
 * canonical-line emitter, middleware, the collection API once Dispatch
 * 3+ wires it up) need to set entries.
 *
 * The context carries no sampling state — every unit-of-work emits
 * one canonical line unconditionally; there is nothing to gate.
 *
 * ## Time source
 *
 * `started_at` uses `performance.now()` so durations can be
 * computed without worrying about wall-clock skew (NTP step,
 * leap-second smearing). `performance.now()` is part of both Node
 * 18+ and the Workers Runtime; we don't fall back to `Date.now()`.
 *
 * @example
 * ```ts
 * const ctx = createObservabilityContext({});
 * await runWithContext(ctx, async () => {
 *   const inner = getCurrentContext();
 *   inner?.fields.set("collection", "tickets");
 *   await doWork();
 * });
 * ```
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { RequestScopedMetricsRecorder } from "./recorder.ts";

/** Read-mostly per-request observability state. */
export interface ObservabilityContext {
  /** Externally-correlatable request identifier (UUID-ish). */
  readonly request_id: string;
  /** Monotonic `performance.now()` reading captured at construction. */
  readonly started_at: number;
  /**
   * Mutable bag for canonical-line attributes. Callers `obs.fields.set("k", v)`;
   * the canonical-line flusher spreads this onto the emitted properties at
   * end-of-request.
   */
  readonly fields: Map<string, unknown>;
  /**
   * Per-request metrics bag. Lives on the context so adapters can
   * reach it from inside the `Db`'s `MetricsRecorder` callback via
   * `getCurrentContext()?.recorder` — no parallel `AsyncLocalStorage`
   * lookup. The canonical-line flusher reads its `summarize()` at
   * end-of-request and spreads the result onto the emitted line.
   */
  readonly recorder: RequestScopedMetricsRecorder;
}

/**
 * Optional construction inputs. All fields are optional so callers in
 * unit-of-work entry middleware (HTTP router, maintenance scheduler)
 * can pass only what they have. Defaults:
 *
 * - `request_id`: a fresh `crypto.randomUUID()`. Pass an externally-
 *   supplied id (`X-Request-Id` header, scheduler-supplied tag) to
 *   propagate correlation downstream.
 * - `recorder`: a fresh {@link RequestScopedMetricsRecorder}. Tests can
 *   pass an externally-constructed recorder to assert on its
 *   `snapshot()` after the unit-of-work completes; production callers
 *   should accept the default.
 */
export interface ObservabilityContextInit {
  readonly request_id?: string;
  readonly recorder?: RequestScopedMetricsRecorder;
}

/**
 * Factory for {@link ObservabilityContext}. We use a factory rather
 * than a class so consumers can structural-type the result and so
 * the `AsyncLocalStorage` slot type stays a plain interface — no
 * surprises around `instanceof` across realms (Workers vs Node).
 */
export const createObservabilityContext = (
  init: ObservabilityContextInit = {},
): ObservabilityContext => ({
  request_id: init.request_id ?? crypto.randomUUID(),
  started_at: performance.now(),
  fields: new Map(),
  recorder: init.recorder ?? new RequestScopedMetricsRecorder(),
});

/**
 * Module-level slot. One instance per process — the Workers
 * Runtime's `nodejs_compat` flag wires `node:async_hooks` to a
 * per-request scope, so cross-request bleed is impossible there.
 */
const als = new AsyncLocalStorage<ObservabilityContext>();

/**
 * Run `fn` with `ctx` active as the current observability context.
 * Inside `fn` (and any `await`-chained continuation rooted in `fn`),
 * {@link getCurrentContext} returns `ctx`. Outside, it returns the
 * previously-active context (or `undefined`).
 *
 * `runWithContext` is async-safe via `AsyncLocalStorage`; it propagates
 * through `await`, `Promise.all`, `setTimeout`, and `queueMicrotask`.
 *
 * Returns `fn`'s return value verbatim — including its promise
 * identity, so callers can `await` or chain off it without extra
 * indirection.
 */
export const runWithContext = <T>(
  ctx: ObservabilityContext,
  fn: () => T | Promise<T>,
): T | Promise<T> => als.run(ctx, fn);

/** Returns the currently-active context, or `undefined` outside one. */
export const getCurrentContext = (): ObservabilityContext | undefined => als.getStore();
