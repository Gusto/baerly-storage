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
 * Wire shape (composite — accepted by the encoder, not consulted by
 * the read path today):
 *
 *   `<logPrefix>/index/<indexName>/<a-b32>/<b-b32>/<docId>.json`
 *
 * @see docs/spec/sync-protocol.md — fence model these PUTs land
 *      inside (between log PUT and `current.json` CAS-advance).
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
 * Validated synchronously by `validateIndexDefinition`
 * (in `@baerly/server`) at writer construction; an invalid def
 * throws `BaerlyError{code: "SchemaError"}` before the first commit.
 */
export interface IndexDefinition {
  /**
   * Stable path-safe identifier. Must match `/^[a-z_][a-z0-9_]*$/`
   * — used directly as a key segment under
   * `<logPrefix>/index/<name>/...`.
   */
  readonly name: string;

  /**
   * Field name(s) to index on. `string` is a single-field index
   * (today's read-path target). `readonly string[]` is composite —
   * accepted by the key encoder but the predicate matcher only
   * consults single-field index entries today.
   *
   * Top-level fields only — dotted-path `on` values throw
   * `SchemaError` from `projectIndexValues`. A future change widens
   * the projector to dotted paths (mirroring what
   * `packages/server/src/query.ts` already does on the predicate
   * side).
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
   * locked {@link PredicateOpName} vocabulary. Range-shaped and
   * `in`-shaped filters compose with the planner's cost-bias step
   * via the implication checker, which proves whether a query
   * predicate is contained in the filter's value range. A query
   * that the filter's range / set strictly contains will route
   * through the filtered index in preference to an unfiltered
   * alternative.
   *
   * Wire shape example:
   * `{ clauses: [{ op: "eq", field: "status", value: "open" }] }`.
   *
   * Planner cost-bias: a filtered index whose predicate is implied
   * by the query predicate outranks an unfiltered alternative; an
   * unfiltered index outranks a filtered one whose predicate is NOT
   * implied (walking the smaller key set would miss matching docs).
   */
  readonly predicate?: PredicateWire;
}
