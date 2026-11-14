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
import {
  type RequestHold,
  type RequestLedger,
  setRequestHoldResolver,
  setRequestLedgerResolver,
} from "@baerly/protocol";
// Type-only import — `maintenance.ts` imports this module's runtime
// values (`getCurrentContext`), so a value import here would form a
// runtime cycle. A type-only edge erases at build time, so tsgo /
// rolldown see no cycle.
import type { MaintenanceDispatch } from "../maintenance.ts";
import type { ReadEnvelope } from "../read-admission.ts";
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
  /**
   * The invocation's storage request budget. Set by the adapter that owns
   * the invocation (an HTTP request, a Workers cron tick) with its host's
   * limits. Every storage attempt run inside this context, `waitUntil`
   * work included, is charged to it by `retryStorageCall`, and one that
   * does not fit is refused before it is sent. Absent ⇒ nothing is charged.
   */
  readonly ledger?: RequestLedger;
  /**
   * A hold on `ledger` that storage calls in this context draw on first.
   * Set only by the writer, on a child context scoped to one commit slot's
   * calls (`Writer#withCommitHold`); work dispatched from outside that
   * scope never sees it.
   */
  readonly hold?: RequestHold;
}

/**
 * {@link ObservabilityContext} plus the adapter-set host wiring the kernel
 * reads: the write-tick maintenance dispatch and the read envelope. The
 * kernel's {@link createObservabilityContext} / {@link getCurrentContext}
 * use this type; the published `/observability` entry re-exports them
 * typed with the narrower public context.
 *
 * @internal
 */
export interface InternalObservabilityContext extends ObservabilityContext {
  /**
   * Per-request write-tick maintenance dispatch config. Set by the
   * adapter (NOT `Db.create`) so the inherently-per-request
   * `dispatch = ctx.waitUntil` and the env-var-derived caps ride the
   * same scope the kernel write-tick reads from. The `Writer`
   * consults `getCurrentContext()?.maintenance` at the post-commit
   * dispatch point. Absent ⇒ inline dispatch + CF-free-safe caps.
   */
  readonly maintenance?: MaintenanceDispatch;
  /**
   * The host's read envelope, set by the adapter with its host's bounds.
   * A read whose staged work falls outside it is refused whole with
   * `CapacityExceeded` (see `read-admission.ts`). Absent ⇒ reads are
   * bounded by the ledger alone.
   */
  readonly readEnvelope?: ReadEnvelope;
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
  /** Storage request budget. See {@link ObservabilityContext.ledger}. */
  readonly ledger?: RequestLedger;
}

/**
 * {@link ObservabilityContextInit} plus the adapter-set host wiring of
 * {@link InternalObservabilityContext}.
 *
 * @internal
 */
export interface InternalObservabilityContextInit extends ObservabilityContextInit {
  /** Write-tick maintenance dispatch config. See {@link InternalObservabilityContext.maintenance}. */
  readonly maintenance?: MaintenanceDispatch;
  /** Read envelope. See {@link InternalObservabilityContext.readEnvelope}. */
  readonly readEnvelope?: ReadEnvelope;
}

/**
 * Factory for {@link ObservabilityContext}. We use a factory rather
 * than a class so consumers can structural-type the result and so
 * the `AsyncLocalStorage` slot type stays a plain interface — no
 * surprises around `instanceof` across realms (Workers vs Node).
 */
export const createObservabilityContext = (
  init: InternalObservabilityContextInit = {},
): InternalObservabilityContext => ({
  request_id: init.request_id ?? crypto.randomUUID(),
  started_at: performance.now(),
  fields: new Map(),
  recorder: init.recorder ?? new RequestScopedMetricsRecorder(),
  ...(init.maintenance !== undefined && { maintenance: init.maintenance }),
  ...(init.ledger !== undefined && { ledger: init.ledger }),
  ...(init.readEnvelope !== undefined && { readEnvelope: init.readEnvelope }),
});

/**
 * Module-level slot. One instance per process — the Workers
 * Runtime's `nodejs_compat` flag wires `node:async_hooks` to a
 * per-request scope, so cross-request bleed is impossible there.
 */
const als = new AsyncLocalStorage<InternalObservabilityContext>();

// Adapters import only `@baerly/protocol`, so `retryStorageCall` finds the
// active invocation's ledger through this resolver.
setRequestLedgerResolver(() => als.getStore()?.ledger);
setRequestHoldResolver(() => als.getStore()?.hold);

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
export const getCurrentContext = (): InternalObservabilityContext | undefined => als.getStore();
