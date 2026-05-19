/**
 * Observability — per-unit-of-work context, metrics recorder,
 * canonical-line emission, and the logtape configuration entry point.
 *
 * Consumed by the HTTP router (`http/router.ts`), the maintenance
 * loops (`maintenance.ts`, `compactor.ts`, `gc.ts`,
 * `rebuild-index.ts`), and both adapters (`@baerly/adapter-cloudflare`,
 * `@baerly/adapter-node`). The high-level flow:
 *
 * 1. The adapter calls {@link configureObservability} once at boot.
 * 2. Each unit-of-work creates an {@link ObservabilityContext} (via
 *    {@link createObservabilityContext}, `withObservability` for
 *    non-HTTP units, or `withHttpObservability` for standalone HTTP
 *    callers that don't have an adapter-managed scope) and runs the
 *    work under {@link runWithContext}. `withObservability` is
 *    nesting-aware: nested calls inherit the outer context+recorder
 *    and emit no separate canonical line, so one unit-of-work →
 *    exactly one line.
 * 3. The unit-of-work calls {@link flushCanonicalLine} (or
 *    `withObservability`'s own flush) at the end; verifier-rejected
 *    requests call {@link flushUnauthorizedAndRespond} instead.
 * 4. Adapters pass {@link alsAwareRecorder}(operator) as the storage
 *    observer's metrics sink so storage-level emissions land in BOTH
 *    the operator's long-term recorder AND the active scope's
 *    per-request bag via the ALS lookup.
 *
 * The `@baerly/server` package re-exports its own `errorEnvelope`
 * separately; this barrel is the observability seam only.
 */

export {
  type ObservabilityContext,
  type ObservabilityContextInit,
  createObservabilityContext,
  runWithContext,
  getCurrentContext,
} from "./context.ts";
export { alsAwareRecorder } from "./recorder.ts";
export { decideSample } from "./sampling.ts";
export { type SerializedError, serializeError } from "./redact.ts";
export {
  type CategoryName,
  type FriendlyLogLevel,
  type ObservabilityConfig,
  CATEGORY,
  configureObservability,
  getEffectiveSampleRate,
  getLogger,
} from "./logger.ts";
export {
  type FlushCanonicalLineOptions,
  type Unit,
  flushCanonicalLine,
  flushUnauthorizedAndRespond,
  withHttpObservability,
  withObservability,
} from "./canonical.ts";
export { observableStorage } from "./storage.ts";
export { type Outcome, deriveOutcome } from "./derive-outcome.ts";
