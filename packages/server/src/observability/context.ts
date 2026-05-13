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
 * {@link request_id}, a high-resolution `started_at`, a mutable
 * {@link fields} bag used to accumulate canonical-line attributes
 * during the unit's lifecycle, and two boolean toggles the sampler
 * + canonical-line flusher consult at end-of-request.
 *
 * The context shape is `readonly` everywhere it can be — only the
 * two sampling booleans and the contents of `fields` are intended
 * to mutate during a request. The {@link fields} map itself is not
 * `readonly` because callers (the canonical-line emitter,
 * middleware, the table API once Dispatch 3+ wires it up) need to
 * set entries.
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
   * Result of the head-based sampling decision, made once at context
   * construction. The canonical-line flusher emits only when this is
   * `true` OR {@link force_kept_by_error} is `true`.
   */
  sampled_by_head: boolean;
  /**
   * Set by the error path of the canonical-line flusher. Forces the
   * canonical line through regardless of the sampler's decision.
   */
  force_kept_by_error: boolean;
}

/**
 * Optional construction inputs. All fields are optional so callers in
 * unit-of-work entry middleware (HTTP router, maintenance scheduler)
 * can pass only what they have. Defaults:
 *
 * - `request_id`: a fresh `crypto.randomUUID()`. Pass an externally-
 *   supplied id (`X-Request-Id` header, scheduler-supplied tag) to
 *   propagate correlation downstream.
 * - `sampled_by_head`: `false`. The sampler decides at the same time
 *   the context is created, so the entry middleware passes the result
 *   of `decideSample(...)` directly.
 */
export interface ObservabilityContextInit {
  readonly request_id?: string;
  readonly sampled_by_head?: boolean;
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
  sampled_by_head: init.sampled_by_head ?? false,
  force_kept_by_error: false,
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
