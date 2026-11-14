/**
 * Public barrel for `baerly-storage`. The canonical top-level
 * surface — read/write API, config types, storage adapter
 * contracts, and the curated protocol-kernel re-exports.
 *
 * Subpaths carry the rest of the surface:
 *
 * - `@gusto/baerly-storage/auth` — auth presets (`bearerJwt`,
 *   `cloudflareAccess`, `sharedSecret`).
 * - `@gusto/baerly-storage/http` — `createRouter`, `mapError`,
 *   `listEventsSince`, `longPollSince`, body-size cap.
 * - `@gusto/baerly-storage/maintenance` — `runScheduledMaintenance`,
 *   the opt-in scheduled pass.
 * - `@gusto/baerly-storage/observability` — context, recorder,
 *   canonical-line helpers, logger config.
 *
 * Kernel internals the CLI, adapters, and bench share (snapshot codec,
 * log walk, verifier resolution) live on the unpublished
 * `@baerly/server/_internal/kernel` subpath.
 */

export {
  type BaerlyAppConfig,
  type BaerlyConfig,
  type CollectionDefinition,
  type CollectionNames,
  type RowOf,
  type UnboundConfig,
  defineConfig,
} from "@baerly/protocol";
export { Db } from "./db.ts";
export type { IndexDefinition } from "./indexes.ts";
export type { SchemaIssue, SchemaValidator } from "./schema.ts";

/**
 * Curated re-export of `@baerly/protocol`'s user-facing symbols.
 * Users only ever import from `baerly-storage` (this package's
 * published name); protocol is an implementation detail of this
 * package and the adapter packages.
 *
 * - {@link BaerlyError} / {@link BaerlyErrorCode} / {@link BaerlyErrorOptions}: every failure
 *   thrown through this surface is a `BaerlyError`; consumers
 *   branch on `error.code` rather than `instanceof` chains.
 * - {@link Query} / {@link Collection}: the locked predicate-AST
 *   interfaces returned by `Db.collection(...)`. Consumers that
 *   destructure the chain need the named types.
 * - {@link Predicate} / {@link PredicateArg}: the equality-object and
 *   `.where(...)`-argument shapes. Consumers writing a helper that
 *   forwards a predicate — or naming a collection handle in a shared
 *   interface — need these instead of hand-rolling a structural shim.
 * - {@link Storage} + its result types
 *   ({@link StorageGetResult}, {@link StorageListEntry},
 *   {@link StoragePutResult}): the interface every storage adapter
 *   implements, with the return shapes adapter authors need to
 *   name.
 * - {@link MemoryStorage}: in-process `Storage` impl for tests
 *   and zero-infra dev.
 * - {@link Verifier} / {@link VerifierResult}: the request-verifier
 *   interface that auth presets and adapter wiring consume, and the
 *   `{ tenantPrefix, identity }` shape it returns on success.
 */
export {
  BaerlyError,
  type BaerlyErrorCode,
  type BaerlyErrorOptions,
  type DocumentData,
  MemoryStorage,
  type Query,
  type Storage,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutResult,
  type Collection,
  type Predicate,
  type PredicateArg,
  type Verifier,
  type VerifierResult,
} from "@baerly/protocol";
