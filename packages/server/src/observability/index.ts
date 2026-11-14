/**
 * Observability — per-HTTP-request context, metrics recorder,
 * canonical-line emission, and the logtape configuration entry point.
 *
 * Consumed by the HTTP router (`http/router.ts`) and both adapters
 * (`@baerly/adapter-cloudflare`, `@baerly/adapter-node`). The
 * high-level flow:
 *
 * 1. The adapter calls {@link configureObservability} once at boot.
 * 2. Each HTTP request creates an {@link ObservabilityContext} (via
 *    {@link createObservabilityContext} or `withHttpObservability`
 *    for standalone callers that don't have an adapter-managed
 *    scope) and runs the work under {@link runWithContext}.
 * 3. The adapter calls {@link flushCanonicalLine} at end-of-request;
 *    verifier-rejected requests call `flushUnauthorizedAndRespond`
 *    (adapter wiring on `@baerly/server/_internal/observability`).
 * 4. Kernel emissions (Writer histograms, compactor / GC gauges,
 *    storage decorator counters) reach the per-request recorder via
 *    the ALS lookup inside emission sites
 *    (`getCurrentContext()?.recorder`). Background runs outside any
 *    HTTP scope emit to the no-op default — by design.
 *
 * The `@baerly/server` package re-exports its own `errorEnvelope`
 * separately; this barrel is the observability seam only.
 */

import {
  type ObservabilityContext,
  type ObservabilityContextInit,
  createObservabilityContext as createContext,
  getCurrentContext as currentContext,
} from "./context.ts";

export {
  type ObservabilityContext,
  type ObservabilityContextInit,
  runWithContext,
} from "./context.ts";

/**
 * Build a per-unit-of-work {@link ObservabilityContext}. Pass it to
 * {@link runWithContext}; every kernel emission inside reaches its
 * recorder.
 */
export const createObservabilityContext: (init?: ObservabilityContextInit) => ObservabilityContext =
  createContext;

/** Returns the currently-active context, or `undefined` outside one. */
export const getCurrentContext: () => ObservabilityContext | undefined = currentContext;
export {
  type CategoryName,
  type FriendlyLogLevel,
  type ObservabilityConfig,
  CATEGORY,
  configureObservability,
  getLogger,
} from "./logger.ts";
export {
  type FlushCanonicalLineOptions,
  flushCanonicalLine,
  withHttpObservability,
} from "./canonical.ts";
export { observableStorage } from "./storage.ts";
export { type Outcome, deriveOutcome } from "./derive-outcome.ts";
// Re-exported so consumers can type `MetricsRecorder`-shaped values
// (the kernel emission contract) without reaching into the
// unpublished `@baerly/protocol` workspace package.
export type { MetricsRecorder } from "@baerly/protocol";
// Re-exported so a consumer writing a custom `observability.sink` can
// type it as `Sink` without adding a direct dependency on the
// transitive `@logtape/logtape` package (which pnpm's strict
// node_modules would not resolve from a scaffolded app).
export type { Sink, LogRecord } from "@logtape/logtape";
