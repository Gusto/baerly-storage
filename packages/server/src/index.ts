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
export {
  type BaerlyConfig,
  type CollectionDefinition,
  type CollectionNames,
  type RowOf,
  type UnboundConfig,
  defineConfig,
} from "./config.ts";
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
 * Curated re-export of `@baerly/protocol`'s user-facing symbols.
 * Users only ever import from `@baerly/server`; protocol is an
 * implementation detail of this package and the adapter packages.
 *
 * - {@link BaerlyError} / {@link BaerlyErrorCode}: every failure
 *   thrown through this surface is a `BaerlyError`; consumers
 *   branch on `error.code` rather than `instanceof` chains.
 * - {@link Query} / {@link Table}: the locked predicate-AST
 *   interfaces returned by `Db.table(...)`. Consumers that
 *   destructure the chain need the named types.
 * - {@link claimWriter}: bumps the writer-fence epoch. Reserved
 *   for admin rotation workflows and initial provisioning. Do
 *   NOT call from a normal write path; the fence is split-brain
 *   prevention, not a retry primitive.
 * - {@link Storage} + its result types
 *   ({@link StorageGetResult}, {@link StorageListEntry},
 *   {@link StoragePutResult}): the interface every storage adapter
 *   implements, with the return shapes adapter authors need to
 *   name.
 * - {@link MemoryStorage}: in-process `Storage` impl for tests
 *   and zero-infra dev.
 * - {@link InMemoryMetricsRecorder}: observability recorder users
 *   wire into `Db` for tests and dev probes.
 * - {@link Verifier}: the request-verifier interface that auth
 *   presets and adapter wiring consume.
 */
export {
  BaerlyError,
  type BaerlyErrorCode,
  claimWriter,
  InMemoryMetricsRecorder,
  MemoryStorage,
  type Query,
  type Storage,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutResult,
  type Table,
  type Verifier,
} from "@baerly/protocol";
