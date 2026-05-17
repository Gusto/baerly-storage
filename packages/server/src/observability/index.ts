/**
 * Observability module — dormant.
 *
 * Nothing in `@baerly/server`'s existing surface (`Db`,
 * `ServerWriter`, the HTTP router, the maintenance loops) imports
 * from here yet. Wiring lands in subsequent commits.
 *
 * See the per-file docstrings for the local invariants of each
 * piece. The high-level flow once wired is:
 *
 * 1. The HTTP/maintenance entry middleware calls
 *    {@link configureObservability} once at boot.
 * 2. Each unit-of-work creates an {@link ObservabilityContext} +
 *    {@link RequestScopedMetricsRecorder}, runs the work under
 *    {@link runWithContext}, and calls {@link flushCanonicalLine}
 *    (or {@link withObservability} for non-HTTP units) at the end.
 * 3. `Db.create({ metrics: teeMetricsRecorders(perRequest, operator) })`
 *    feeds writer/maintenance emissions into the per-request
 *    recorder while preserving the operator's long-term sink.
 * 4. Storage adapters are wrapped with {@link observableStorage}
 *    so storage-level metrics + per-call DEBUG events flow through
 *    the same channel.
 */

export {
  type ObservabilityContext,
  type ObservabilityContextInit,
  createObservabilityContext,
  runWithContext,
  getCurrentContext,
} from "./context.ts";
export {
  type MetricsSnapshot,
  type MetricsSummary,
  type ObservationRow,
  RequestScopedMetricsRecorder,
  alsAwareRecorder,
} from "./recorder.ts";
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
  peekContext,
  withObservability,
} from "./canonical.ts";
export { observableStorage } from "./storage.ts";
export { type Outcome, deriveOutcome } from "./derive-outcome.ts";
