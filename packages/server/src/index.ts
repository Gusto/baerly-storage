export {
  type CompactOptions,
  type CompactResult,
  type SnapshotBody,
  SEQ_DIGITS,
  SNAPSHOT_LEVEL,
  compact,
  encodeSnapshotBody,
  loadSnapshotAsMap,
  snapshotKey,
} from "./compactor.ts";
export { type BaerlyConfig, type CollectionDefinition, defineConfig } from "./config.ts";
export { type DevLandingOptions, renderDevLanding } from "./dev-landing.ts";
export {
  type HttpErrorEnvelope,
  type HttpOkEnvelope,
  type HttpOkMeta,
  type HttpStatus,
  type Routes,
  type SinceResponse,
  errorEnvelope,
} from "./contract.ts";
export { type BufferedMutation, type RawStorageApi, type TxContext, Db } from "./db.ts";
export { type RunGcOptions, type RunGcResult, runGc } from "./gc.ts";
export { type CreateRouterOptions, MAX_BODY_BYTES, createRouter, mapError } from "./http/router.ts";
export {
  type ListEventsSinceOptions,
  type LongPollSinceOptions,
  listEventsSince,
  longPollSince,
} from "./http/since.ts";
export {
  type IndexDefinition,
  allIndexKeysFor,
  encodeIndexValue,
  indexKeyFor,
  indexKeyPrefix,
  projectIndexValues,
  validateIndexDefinition,
} from "./indexes.ts";
export { readLogEntry, walkLogRange } from "./log-walk.ts";
export {
  type RebuildIndexOptions,
  type RebuildIndexResult,
  rebuildIndex,
} from "./rebuild-index.ts";
export {
  type MigrateCollectionArgs,
  type MigrateCollectionResult,
  migrateCollection,
} from "./migrate.ts";
export {
  type CategoryName,
  type FlushCanonicalLineOptions,
  type FriendlyLogLevel,
  type MetricsSnapshot,
  type MetricsSummary,
  type ObservabilityConfig,
  type ObservabilityContext,
  type ObservabilityContextInit,
  type ObservationRow,
  type SerializedError,
  type Unit,
  CATEGORY,
  RequestScopedMetricsRecorder,
  alsAwareRecorder,
  configureObservability,
  createObservabilityContext,
  decideSample,
  flushCanonicalLine,
  getCurrentContext,
  getEffectiveSampleRate,
  getLogger,
  observableStorage,
  peekContext,
  runWithContext,
  serializeError,
  withObservability,
} from "./observability/index.ts";
export {
  type CurrentJsonCacheSlot,
  type QueryState,
  type ReadResult,
  type TableReadContext,
  makeQuery,
  runAllWithMeta,
  runFirstWithMeta,
  runInsert,
  serializeManifestPointer,
} from "./query.ts";
export { type SchemaIssue, type SchemaValidator, validateOrThrow } from "./schema.ts";
export {
  type CommitBatchResult,
  type CommitInput,
  type CommitResult,
  type ServerWriterOptions,
  ServerWriter,
} from "./server-writer.ts";
export { makeTable } from "./table.ts";
export {
  type AllowlistIpOptions,
  type AwsIamPrincipal,
  type AwsIamSigV4Options,
  type BearerJwtOptions,
  type CloudflareAccessOptions,
  type Jwk,
  type JwksDocument,
  type JwtAlgorithm,
  type SharedSecretOptions,
  allowlistIp,
  andAll,
  awsIamSigV4,
  bearerJwt,
  cloudflareAccess,
  sharedSecret,
} from "./auth/index.ts";

/**
 * Re-export of {@link claimWriter} from `@baerly/protocol`. Bumping
 * the fence causes any in-flight {@link ServerWriter} commit
 * holding the prior epoch to fail-fast with
 * `BaerlyError{code:"Conflict"}` after its CAS PUT lands (the
 * stale writer's CAS itself may succeed — the fence check is
 * post-write — but the commit return is aborted before the
 * caller observes success). Reserved for admin rotation
 * workflows and initial provisioning. Do NOT call from a
 * normal write path; the fence is split-brain prevention, not
 * a retry primitive.
 */
export { claimWriter } from "@baerly/protocol";

/**
 * Re-export of {@link BaerlyError} and its discriminator type from
 * `@baerly/protocol`. Every failure thrown through this surface is
 * an `BaerlyError`; consumers branch on `error.code` (a
 * {@link BaerlyErrorCode}) rather than `instanceof` chains.
 */
export { BaerlyError, type BaerlyErrorCode } from "@baerly/protocol";

/**
 * Re-export of the locked predicate-AST `Table<T>` and `Query<T>`
 * interfaces from `@baerly/protocol`. These name the read/write
 * handles returned by `Db.table(...)`; consumers that destructure
 * the chain (`type T = Awaited<ReturnType<...>>`) need the named
 * types.
 */
export type { Query, Table } from "@baerly/protocol";
