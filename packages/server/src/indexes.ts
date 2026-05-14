/**
 * Secondary indexes — declarative collection-config-driven
 * index entries that the writer emits inside the same CAS fence as
 * the log entry and content body.
 *
 * This module owns:
 *
 *   - The {@link IndexDefinition} shape (`name`, `on`).
 *   - {@link validateIndexDefinition} — synchronous schema check
 *     for path-segment safety; thrown at `ServerWriter` construction.
 *   - {@link encodeIndexValue} — lex-order-preserving base-32 of the
 *     UTF-8 bytes of a value's canonical JSON form.
 *   - {@link indexKeyFor} / {@link indexKeyPrefix} — the wire-key
 *     shape consumed by the writer's index PUTs and the rebuild
 *     command's idempotent reconciliation.
 *   - {@link projectIndexValues} / {@link allIndexKeysFor} — pure
 *     projections from a doc body to the set of index keys it
 *     produces under a collection's declared indexes.
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
 * Body is zero bytes. Each entry is a fact ("doc `<docId>` has
 * `<field> = <value>`"), not data. Readers list the prefix, extract
 * the doc id from each key, then issue a content GET on each.
 *
 * Encoding is RFC-4648 base-32 (lowercase alphabet `[0-9a-v]`,
 * matching `packages/protocol/src/log.ts:str2uintDesc` style) on the
 * UTF-8 bytes of `JSON.stringify(value)` so that:
 *
 *   - String "5" and number 5 produce distinct encodings
 *     (their JSON forms differ).
 *   - Equal-by-value inputs produce byte-equal segments.
 *   - Lex order under storage `list(prefix)` matches lex order on
 *     the underlying JSON-stringified value bytes.
 *
 * Locked: single-field indexes only on the read path. Composite
 * shape is documented and reserved (the path encoder accepts it).
 *
 * @see docs/spec/sync-protocol.md — fence model these PUTs land
 *      inside (between log PUT and `current.json` CAS-advance).
 */

import {
  BaerlyError,
  type JSONArraylessObject,
  matches,
  type Predicate,
  validatePredicate,
} from "@baerly/protocol";

/**
 * A secondary index declaration. Lives in `baerly.config.ts` under
 * `collections.<name>.indexes[]` and is threaded through
 * `ServerWriter` via `ServerWriterOptions.indexes`.
 *
 * Validated synchronously by {@link validateIndexDefinition} at
 * writer construction; an invalid def throws `BaerlyError{code:
 * "SchemaError"}` before the first commit.
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
   * `SchemaError` from {@link projectIndexValues}. A future change
   * widens the projector to dotted paths (mirroring what
   * `packages/server/src/query.ts` already does on the predicate
   * side).
   */
  readonly on: string | readonly string[];

  /**
   * Optional sparse-projection filter. When present, the writer
   * emits index keys ONLY for docs that satisfy `predicate` under
   * `matches(predicate, body)`. Sparse indexes shrink the on-storage
   * key set proportionally to filter selectivity — an index that
   * matches ~1% of writes pays ~1% of the dense Class-A PUT cost.
   *
   * **Equality-only** (T4): no `$eq`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`
   * operator objects are allowed in this predicate. The restriction
   * keeps the planner's implication checker
   * ({@link "@baerly/protocol".predicateImplies}) simple and
   * sound; range / `$in` filter implication is a deferred follow-up
   * (see `docs/followups/predicate-routing.md`). Operator-shaped
   * filter values throw `SchemaError` at writer construction.
   *
   * Planner cost-bias: a filtered index whose predicate is implied
   * by the query predicate outranks an unfiltered alternative; an
   * unfiltered index outranks a filtered one whose predicate is NOT
   * implied (walking the smaller key set would miss matching docs).
   */
  readonly predicate?: Predicate<JSONArraylessObject>;
}

/** Path-safe segment name. */
const INDEX_NAME_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Lowercase base-32 alphabet, RFC 4648 variant matching the
 * `packages/protocol/src/log.ts:str2uintDesc` style (`[0-9a-v]`).
 * Lex-order-preserving under storage `list(prefix)` semantics.
 */
const B32_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

/**
 * Reject malformed {@link IndexDefinition} shapes synchronously.
 * Thrown at writer construction so a config typo trips before any
 * write lands.
 *
 * @throws BaerlyError code="SchemaError" — `name` doesn't match
 *   `/^[a-z_][a-z0-9_]*$/`; `on` is the empty string or empty
 *   array.
 */
export const validateIndexDefinition = (def: IndexDefinition): void => {
  if (!INDEX_NAME_RE.test(def.name)) {
    throw new BaerlyError(
      "SchemaError",
      `index.name must match /^[a-z_][a-z0-9_]*$/; got ${JSON.stringify(def.name)}`,
    );
  }
  if (typeof def.on === "string") {
    if (def.on.length === 0) {
      throw new BaerlyError("SchemaError", `index ${def.name}.on must be non-empty`);
    }
  } else if (def.on.length === 0) {
    throw new BaerlyError("SchemaError", `index ${def.name}.on must be non-empty array`);
  }
  if (def.predicate !== undefined) {
    try {
      validatePredicate(def.predicate);
    } catch (err) {
      // Surface as SchemaError so the failure mode matches the rest
      // of validateIndexDefinition (writer-construction-time bail-out,
      // not query-time).
      if (err instanceof BaerlyError) {
        throw new BaerlyError(
          "SchemaError",
          `index ${def.name}.predicate is invalid: ${err.message}`,
          err,
        );
      }
      throw err;
    }
    // Belt-and-braces equality-only check. T1 widened
    // `validatePredicate` to accept operator-shaped clauses
    // (`{$eq, $gt, $gte, $lt, $lte, $in}`); T4 restricts filtered
    // indexes to equality-only so the implication checker stays
    // sound. Operator-detection rule mirrors T1's `mergePredicates`:
    // a node is an "operator object" iff EVERY key at that level
    // starts with `$` (CONTRACTS.md §10).
    assertNoOperatorClause(def.predicate, def.name, []);
  }
};

/**
 * Recursive walk that rejects any operator-shaped sub-object inside
 * a filtered-index `predicate`. Throws `SchemaError` on the first
 * violation. Open-world: we only check sub-object nodes whose keys
 * all start with `$`; primitives and non-operator sub-predicates pass
 * through unchanged.
 *
 * Note: `validatePredicate` has already accepted the structural
 * shape, so we don't repeat null / array / reserved-key checks here.
 */
const assertNoOperatorClause = (
  node: Predicate<JSONArraylessObject>,
  defName: string,
  path: ReadonlyArray<string>,
): void => {
  for (const key of Object.keys(node)) {
    const value = (node as Record<string, unknown>)[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== "object" || Array.isArray(value)) continue;
    const subKeys = Object.keys(value as Record<string, unknown>);
    if (subKeys.length > 0 && subKeys.every((k) => k.startsWith("$"))) {
      throw new BaerlyError(
        "SchemaError",
        `index ${defName}.predicate at ${[...path, key].join(".") || "<root>"} is operator-shaped (keys: ${subKeys.join(", ")}); filtered-index predicates are equality-only.`,
      );
    }
    assertNoOperatorClause(value as Predicate<JSONArraylessObject>, defName, [...path, key]);
  }
};

/**
 * Encode an arbitrary `JSONArrayless` value as a path-safe segment.
 * Canonical JSON.stringify ensures equal-by-value inputs (e.g.
 * `{a:1, b:2}` and `{a:1, b:2}`) produce byte-equal segments while
 * structurally-different but visually-similar inputs (`"5"` vs `5`)
 * produce distinct segments.
 *
 * `null` / `undefined` collapse to the sentinel `"0"` so the
 * segment is never empty (an empty segment would collapse a key
 * into `...//docid.json` and break the storage `list(prefix)`
 * walk).
 *
 * **Numeric ranges are not supported by this encoder.** Output is
 * byte-order-preserving on `JSON.stringify(v)`. JSON-stringified
 * numbers don't sort lexicographically by numeric value
 * (`JSON.stringify(9) === "9"` is one byte 0x39 while
 * `JSON.stringify(10) === "10"` is two bytes 0x31 0x30, so
 * `"9" > "10"` byte-wise). The query planner
 * (`./query-planner.ts`) refuses numeric range and `$in` predicates
 * over indexed fields by emitting
 * `FullScanPlan{reason:"numeric-range-on-byte-encoder"}`; the
 * full-scan path is correct for those predicates. A value-order-
 * preserving numeric encoder is a follow-up — see
 * `docs/followups/predicate-routing.md`.
 *
 * String ranges are safe: `"2026-05-13" < "2026-05-14"` byte-wise
 * matches semantic order. ISO 8601 timestamps, alphabetical
 * priorities like `"p1"/"p2"/"p3"`, and any fixed-width string
 * encoding are usable as range-walked indexed fields.
 */
export const encodeIndexValue = (v: unknown): string => {
  // Stringify in canonical form so equal values map to equal keys.
  // null / undefined collapse to the empty string; the trailing
  // sentinel below guarantees a non-empty segment.
  const s = v === null || v === undefined ? "" : JSON.stringify(v);
  const bytes = new TextEncoder().encode(s);
  // Lowercase base-32 of the UTF-8 bytes. Lex-order-preserving
  // under the storage's lex-sort guarantee.
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  // Empty input → "0" so the segment is never empty (would collapse
  // a key into a non-segment `...//docid.json`).
  return out === "" ? "0" : out;
};

/**
 * Storage `list(prefix)` boundary for every entry under one index
 * of a collection: `<logPrefix>/index/<name>/`. Used by the rebuild
 * command's reconciliation walk and by the read-path index hint.
 */
export const indexKeyPrefix = (logPrefix: string, indexName: string): string =>
  `${logPrefix}/index/${indexName}/`;

/**
 * Build the per-doc index key for one `(def, values, docId)`.
 *
 * Single-field: `<logPrefix>/index/<name>/<v0-b32>/<docId>.json`.
 * Composite:    `<logPrefix>/index/<name>/<v0-b32>/<v1-b32>/.../<docId>.json`.
 *
 * Composite shape is accepted but the read path today only
 * consults single-field entries.
 */
export const indexKeyFor = (
  logPrefix: string,
  def: IndexDefinition,
  values: readonly unknown[],
  docId: string,
): string => {
  const segments = values.map(encodeIndexValue).join("/");
  return `${logPrefix}/index/${def.name}/${segments}/${docId}.json`;
};

/**
 * Project the value tuple a doc body produces under one index
 * definition. Returns `undefined` when any indexed field is
 * null / undefined / missing — no index entry for that doc under
 * that index (SQL "NULL values don't enter the index" semantics).
 *
 * @throws BaerlyError code="SchemaError" — `on` contains a dotted
 *   path. A future change lifts this restriction.
 */
export const projectIndexValues = (
  def: IndexDefinition,
  body: JSONArraylessObject | undefined,
): readonly unknown[] | undefined => {
  if (body === undefined) return undefined;
  const fields = typeof def.on === "string" ? [def.on] : def.on;
  const values: unknown[] = [];
  for (const field of fields) {
    // Today we only support top-level fields. Dotted paths land in
    // a follow-up; throw loudly so a config typo doesn't silently
    // produce empty values.
    if (field.includes(".")) {
      throw new BaerlyError(
        "SchemaError",
        `index ${def.name}: dotted-path "on" fields not yet supported (got ${JSON.stringify(field)})`,
      );
    }
    const v = body[field];
    // null/undefined are skipped — no index entry. Mirrors SQL
    // "NULL values don't go into a regular index" semantics.
    if (v === null || v === undefined) return undefined;
    values.push(v);
  }
  return values;
};

/**
 * Compute the full index-key set a single doc produces under every
 * declared index of its collection. Skips indexes whose projection
 * yields `undefined` (null/missing indexed field). Used by both
 * the writer (to PUT new keys) and the rebuild command (to compute
 * the expected key set across the live doc map).
 *
 * Filter-aware (T4): when `def.predicate !== undefined`, the doc
 * must satisfy `matches(def.predicate, body)` or the def contributes
 * zero keys. The writer's diff `oldKeys` vs `newKeys` then covers
 * all four U-quadrants automatically — see the JSDoc on
 * `server-writer.ts` above the index-emission block. `body ===
 * undefined` short-circuits ahead of the filter check (no keys for
 * an unknown pre-image, regardless of filter), preserving the prior
 * D-quadrant behaviour.
 */
export const allIndexKeysFor = (
  logPrefix: string,
  defs: ReadonlyArray<IndexDefinition>,
  body: JSONArraylessObject | undefined,
  docId: string,
): string[] => {
  const keys: string[] = [];
  for (const def of defs) {
    if (def.predicate !== undefined && body !== undefined) {
      if (!matches(def.predicate, body)) continue;
    }
    const values = projectIndexValues(def, body);
    if (values !== undefined) {
      keys.push(indexKeyFor(logPrefix, def, values, docId));
    }
  }
  return keys;
};
