/**
 * @internal — test-only widening of `@baerly/server`'s public option
 * types plus internal commit-path primitives exposed to test
 * fixtures and the CLI's admin restore tool. Production callers see
 * the narrow `CompactOptions` / `RunGcOptions` / `MaintenanceOptions`
 * from `@baerly/server` and `Db.collection(...)` for writes; everything
 * here is for test fixtures and the operator restore path.
 *
 * This subpath is intentionally NOT in `publishConfig.exports`, so the
 * published `@baerly/server` package does not surface it.
 */
export type { InternalCompactOptions } from "../compactor.ts";
export type { InternalRunGcOptions } from "../gc.ts";
export type { InternalMaintenanceOptions } from "../maintenance-options.ts";
export { type RetireLogRangeResult, retireLogRange } from "../log-retention.ts";
export { type CommitInput, type CommitResult, type WriterOptions, Writer } from "../writer.ts";
export { assertPathSegment, MAX_SEGMENT_BYTES } from "../path-segment.ts";
export {
  type AdoptionContext,
  type AdoptionDecision,
  tryAdoptOwnSessionLogEntry,
} from "../log-conflict-adoption.ts";
export { InMemoryMetricsRecorder } from "./in-memory-metrics.ts";
export {
  decodeSnapshotChunk,
  encodeSnapshotChunk,
  snapshotChunkKey,
  type SnapshotChunk,
} from "../snapshot-chunk.ts";
export {
  decodeSnapshotManifest,
  encodeSnapshotManifest,
  snapshotManifestKey,
  type SnapshotChunkDescriptor,
  type SnapshotManifest,
} from "../snapshot-manifest.ts";
export {
  foldChunkedSnapshotReference,
  type ReferenceFold,
  type ReferenceMutation,
  type ReferenceRow,
} from "../chunked-snapshot-reference.ts";
export {
  openSnapshotView,
  type OpenSnapshotViewInput,
  type SnapshotRow,
  type SnapshotView,
} from "../snapshot-view.ts";
