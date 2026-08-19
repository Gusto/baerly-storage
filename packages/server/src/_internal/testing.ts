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

import { BaerlyError } from "@baerly/protocol";
import type { CodecCode } from "../snapshot-codec.ts";

/** Patterns matching a validated field *value* leaking into a codec error message, as opposed to just the field name or a constraint description. */
export const LEAK_PATTERNS: readonly RegExp[] = [
  /incarnation:\s*["']?[0-9a-f]{32}["']?/i,
  /digest:\s*["']?[0-9a-f]{64}["']?/i,
  /first_id:\s*["'][^"']{1,256}["']/,
  /last_id:\s*["'][^"']{1,256}["']/,
  /byte_length:\s*\d{4,}/,
  /row_count:\s*\d{3,}/,
];

/**
 * Assert that a codec operation rejects with `expectedCode` and fails
 * closed: no validated field value leaked into the thrown message.
 *
 * Re-throws the original `BaerlyError` on failure so it can still be
 * asserted on by the caller (e.g. `expect(...).rejects.toMatchObject(...)`).
 * Always async and always awaits `operation()`, so it works uniformly for
 * codecs like `decodeSnapshotChunk` that only throw after their first
 * `await` — a sync wrapper would see those as "succeeded" (a pending
 * promise, not yet rejected) rather than catching the eventual rejection.
 */
export async function assertFailClosed(
  operation: () => unknown,
  expectedCode: CodecCode,
): Promise<never> {
  let result: unknown;
  try {
    result = await operation();
  } catch (error) {
    if (!(error instanceof BaerlyError)) {
      throw new Error(
        `assertFailClosed: expected BaerlyError with code ${expectedCode} but got ${String(error)}`,
        { cause: error },
      );
    }
    if (error.code !== expectedCode) {
      throw new Error(`assertFailClosed: expected code ${expectedCode} but got ${error.code}`, {
        cause: error,
      });
    }
    for (const pattern of LEAK_PATTERNS) {
      if (pattern.test(error.message)) {
        throw new Error(
          `assertFailClosed: error message may leak authoritative data: ${error.message}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
  throw new Error(
    `assertFailClosed: expected ${expectedCode} but operation succeeded with ${JSON.stringify(result)}`,
  );
}

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
