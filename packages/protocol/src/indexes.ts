/**
 * Secondary-index declaration TYPE.
 *
 * The interface lives in `@baerly/protocol` so cross-platform
 * consumers (client, scaffold `baerly.config.ts`) can reference it
 * without dragging the Node-only server modules into their typecheck
 * graph. The validation / key-encoding / projection IMPLs live in
 * `packages/server/src/indexes.ts` and consume this type via
 * `import type { IndexDefinition } from "@baerly/protocol"`.
 *
 * Wire shape (single-field):
 *
 *   `<logPrefix>/index/<indexName>/<value-b32>/<docId>.json`
 *
 * Wire shape (composite):
 *
 *   `<logPrefix>/index/<indexName>/<a-b32>/<b-b32>/<docId>.json`
 *
 * @see docs/spec/sync-protocol.md — index emission is hybrid around
 *      the commit: additive (new) keys are PUT before the committing
 *      `log/<seq>` create, and stale-key DELETEs land after it.
 * @see packages/server/src/indexes.ts — `validateIndexDefinition`,
 *      `encodeIndexValue`, `indexKeyFor`, `projectIndexValues`,
 *      `allIndexKeysFor` (all impl).
 */

import type { PredicateWire } from "./query/wire.ts";

/**
 * A secondary index declaration. Lives in `baerly.config.ts` under
 * `collections.<name>.indexes[]` and is threaded through
 * `Writer` via `WriterOptions.indexes`.
 *
 * Validated synchronously by `validateIndexDefinition` (in
 * `@baerly/server`) at writer construction — see `name` below.
 */
export interface IndexDefinition {
  /**
   * Stable path-safe identifier, used directly as a key segment under
   * `<logPrefix>/index/<name>/...`. Must match `/^[a-z][a-z0-9_]*$/`.
   * A reserved leading-`_` name throws `InvalidConfig`; a malformed
   * name throws `SchemaError`. See docs/adr/003-layout-versioning-cordon.md.
   */
  readonly name: string;

  /**
   * Field name(s) to index on. `string` is a single-field index.
   * `readonly string[]` is composite. These fields control marker
   * projection; reads always fold the authoritative snapshot and log.
   *
   * Top-level fields only — dotted-path `on` values throw
   * `SchemaError` from `projectIndexValues`.
   */
  readonly on: string | readonly string[];

  /**
   * Optional sparse-projection filter (wire-form). When present, the
   * writer emits index keys ONLY for docs that satisfy `predicate`
   * under `matchesWire(predicate, body)`. Sparse indexes shrink the
   * on-storage key set proportionally to filter selectivity — an
   * index that matches ~1% of writes pays ~1% of the dense Class-A
   * PUT cost.
   *
   * Operators allowed: `eq`, `gt`, `gte`, `lt`, `lte`, `in` — the
   * locked {@link PredicateOpName} vocabulary. The filter controls
   * marker projection only; it does not restrict query membership.
   *
   * Wire shape example:
   * `{ clauses: [{ op: "eq", field: "status", value: "open" }] }`.
   */
  readonly predicate?: PredicateWire;
}
