/**
 * Secondary-index declaration TYPE.
 *
 * The interface lives in `@baerly/protocol` so cross-platform
 * consumers (client, scaffold `baerly.config.ts`) can reference it
 * without dragging the Node-only server modules into their typecheck
 * graph. `validateIndexDefinition` in `packages/server/src/indexes.ts`
 * checks it at `Db.create`.
 */

import type { PredicateWire } from "./query/wire.ts";

/**
 * A secondary index declaration, under `collections.<name>.indexes[]`
 * in `baerly.config.ts`.
 *
 * **An index does not speed up reads, change which rows a read
 * returns, or cost a write anything.** Every read folds the
 * collection's snapshot and log in full, and no storage call depends on
 * the declaration. The declaration is validated and
 * reserved for a future index-aware storage format; omit it unless an
 * existing config already declares one.
 *
 * `Db.create` validates every declaration and throws on a malformed
 * one; see each field for the rule.
 *
 * @example
 * ```ts
 * { name: "by_status", on: "status" }
 * ```
 */
export interface IndexDefinition {
  /**
   * Stable identifier. Must match `/^[a-z][a-z0-9_]*$/`. A reserved
   * leading-`_` name throws `InvalidConfig`; any other malformed name
   * throws `SchemaError`.
   */
  readonly name: string;

  /**
   * Field name(s) the index covers: a `string` for one field, a
   * non-empty `readonly string[]` for a composite. Top-level fields
   * only: an empty value throws `SchemaError` and a dotted path
   * (`"meta.owner"`) throws `InvalidConfig`, both at `Db.create`.
   * A row may hold any value, arrays included, in a declared field.
   */
  readonly on: string | readonly string[];

  /**
   * Optional filter in wire form, for example
   * `{ clauses: [{ op: "eq", field: "status", value: "open" }] }`.
   * Operators: `eq`, `gt`, `gte`, `lt`, `lte`, `in` (the
   * {@link PredicateOpName} vocabulary). An invalid predicate throws
   * `SchemaError`. It never restricts what a query returns.
   */
  readonly predicate?: PredicateWire;
}
