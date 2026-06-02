/**
 * Secondary indexes — declarative collection-config-driven
 * index entries that the writer emits inside the same CAS fence as
 * the log entry and content body.
 *
 * The {@link IndexDefinition} TYPE lives in `@baerly/protocol`
 * (cross-platform). This module owns the runtime helpers that
 * operate on that shape:
 *
 *   - {@link validateIndexDefinition} — synchronous schema check
 *     for path-segment safety; thrown at `Writer` construction.
 *   - {@link encodeIndexValue} — value-order-preserving base-32 of a
 *     type-tagged byte stream (null/bool tag-only, numbers as sortable
 *     IEEE 754, strings as raw UTF-8, objects as `JSON.stringify`
 *     bytes for equality only).
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
 * matching `packages/protocol/src/log.ts:str2uintDesc` style) on a
 * type-tagged byte stream (see {@link encodeIndexValue}) so that:
 *
 *   - String "5" and number 5 produce distinct encodings
 *     (type-tag prefix keeps the slots disjoint).
 *   - Equal-by-value inputs produce byte-equal segments.
 *   - Lex order under storage `list(prefix)` matches value order:
 *     `null < false < true < number < string < object`, with
 *     numeric values ordered by IEEE 754 magnitude (range walks
 *     and `$in` walks over numeric fields are first-class — no
 *     planner fall-back to full-scan).
 *
 * Locked: single-field indexes only on the read path. Composite
 * shape is documented and reserved (the path encoder accepts it).
 *
 * @see docs/spec/sync-protocol.md — fence model these PUTs land
 *      inside (between log PUT and `current.json` CAS-advance).
 */

import {
  BaerlyError,
  type DocumentData,
  encodeJsonBytes,
  type IndexDefinition,
  matchesWire,
  validateWire,
} from "@baerly/protocol";
import { assertNameNotReserved } from "./names.ts";

export type { IndexDefinition };

/** Path-safe segment name. */
const INDEX_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Lowercase base-32 alphabet, RFC 4648 variant matching the
 * `packages/protocol/src/log.ts:str2uintDesc` style (`[0-9a-v]`).
 * Lex-order-preserving under storage `list(prefix)` semantics.
 */
const B32_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

/**
 * Reject malformed {@link IndexDefinition} shapes synchronously, at
 * writer construction. See docs/adr/007-layout-versioning-cordon.md.
 *
 * @throws BaerlyError code="InvalidConfig" — reserved leading-`_` `name`.
 * @throws BaerlyError code="SchemaError" — `name` fails the regex, or `on` is empty.
 */
export const validateIndexDefinition = (def: IndexDefinition): void => {
  assertNameNotReserved(def.name, "index.name");
  if (!INDEX_NAME_RE.test(def.name)) {
    throw new BaerlyError(
      "SchemaError",
      `index.name must match /^[a-z][a-z0-9_]*$/; got ${JSON.stringify(def.name)}`,
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
      validateWire(def.predicate);
    } catch (error) {
      // Surface as SchemaError so the failure mode matches the rest
      // of validateIndexDefinition (writer-construction-time bail-out,
      // not query-time).
      if (error instanceof BaerlyError) {
        throw new BaerlyError(
          "SchemaError",
          `index ${def.name}.predicate is invalid: ${error.message}`,
          error,
        );
      }
      throw error;
    }
  }
};

/**
 * Type-tag bytes for the value-order-preserving wire format. The
 * tag is the LEADING byte of the encoded payload; the values are
 * picked so the type order under byte-wise lex is
 * `null < false < true < number < string < object`.
 *
 * |  Type   | Byte-prefix | Payload                                            |
 * |---------|-------------|----------------------------------------------------|
 * | null    | 0x10        | (none)                                             |
 * | false   | 0x20        | (none)                                             |
 * | true    | 0x21        | (none)                                             |
 * | number  | 0x30        | 8-byte sortable big-endian IEEE 754                |
 * | string  | 0x40        | UTF-8 bytes of the string (no quotes, no escapes)  |
 * | object  | 0x50        | UTF-8 bytes of `JSON.stringify(v)`                 |
 *
 * Local to the encoder by design — these are wire shape, not
 * cross-package protocol constants (see `CLAUDE.md` § "Magic
 * values").
 */
const TYPE_NULL = 0x10;
const TYPE_FALSE = 0x20;
const TYPE_TRUE = 0x21;
const TYPE_NUMBER = 0x30;
const TYPE_STRING = 0x40;
const TYPE_OBJECT = 0x50;

/**
 * Encode a JS double as an 8-byte big-endian sortable IEEE 754
 * payload. Byte-wise lex order on the result matches numeric order
 * across all finite doubles plus `±Infinity`:
 *
 *   1. Get the 8-byte big-endian view of the double.
 *   2. If the sign bit is `0` (zero or positive), flip the sign bit
 *      (XOR `0x80` on byte 0) so positives sort above negatives.
 *   3. If the sign bit is `1` (negative), flip every bit in all 8
 *      bytes so more-negative sorts lower.
 *
 * `NaN` has no order-preserving slot and is rejected — see the
 * `encodeIndexValue` JSDoc for the wire-contract rationale.
 * `-0` and `+0` collapse because the `n === 0 ? 0 : n` coercion below
 * forces both into the positive-zero branch before `setFloat64`.
 */
const encodeNumberPayload = (n: number): Uint8Array => {
  if (Number.isNaN(n)) {
    throw new BaerlyError(
      "SchemaError",
      `encodeIndexValue: NaN is not indexable (the byte encoding has no order-preserving slot for it)`,
    );
  }
  // Coerce `-0` to `+0` so both share the positive-zero serialisation
  // (`setFloat64(-0)` would produce `0x80 00...00` and take the
  // negative-branch all-bits-flip below, collapsing to a *different*
  // byte string than `+0`). Coercing up front keeps the wire stable.
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n === 0 ? 0 : n, false); // big-endian
  const bytes = new Uint8Array(buf);
  if ((bytes[0]! & 0x80) === 0) {
    // Positive (or +0): flip sign bit so positives sort above negatives.
    bytes[0] = bytes[0]! ^ 0x80;
  } else {
    // Negative: flip all bits so more-negative sorts lower.
    for (let i = 0; i < 8; i++) {
      bytes[i] = bytes[i]! ^ 0xff;
    }
  }
  return bytes;
};

/**
 * Compose the typed byte stream for one value. The leading byte is
 * the type tag (see {@link TYPE_NULL} et al.); the payload shape is
 * type-dependent. Strings are emitted as their raw UTF-8 bytes (no
 * JSON quoting / escaping) so byte-wise lex order on encoded strings
 * matches byte-wise lex order on the source UTF-8. Objects fall back
 * to `JSON.stringify` for equality only.
 */
const encodeBytes = (v: unknown): Uint8Array => {
  if (v === null || v === undefined) {
    return new Uint8Array([TYPE_NULL]);
  }
  if (v === false) {
    return new Uint8Array([TYPE_FALSE]);
  }
  if (v === true) {
    return new Uint8Array([TYPE_TRUE]);
  }
  if (typeof v === "number") {
    const payload = encodeNumberPayload(v);
    const out = new Uint8Array(1 + payload.length);
    out[0] = TYPE_NUMBER;
    out.set(payload, 1);
    return out;
  }
  if (typeof v === "string") {
    const utf8 = new TextEncoder().encode(v);
    const out = new Uint8Array(1 + utf8.length);
    out[0] = TYPE_STRING;
    out.set(utf8, 1);
    return out;
  }
  // Objects: equality only; insertion-order dependent (matches today's
  // contract on `JSON.stringify`-based equality).
  const utf8 = encodeJsonBytes(v);
  const out = new Uint8Array(1 + utf8.length);
  out[0] = TYPE_OBJECT;
  out.set(utf8, 1);
  return out;
};

/**
 * Encode an arbitrary `DocumentValue` value as a path-safe segment.
 *
 * Type-tagged byte stream, base-32-encoded for path safety. Lex
 * order on encoded bytes matches:
 *
 *   - **Type order**: `null < false < true < number < string < object`.
 *   - **Within numbers**: IEEE 754 numeric order (sortable
 *     big-endian payload, sign-bit-flipped or all-bits-flipped).
 *     `-Infinity` sorts lowest, `+Infinity` highest.
 *   - **Within strings**: UTF-8 byte order.
 *   - **Within objects**: byte-equality only (still
 *     `JSON.stringify`-insertion-order dependent).
 *
 * Numbers ARE range-safe under this encoder — `9` sorts below `10`
 * as expected. The query planner's old
 * `numeric-range-on-byte-encoder` guard has been removed; range
 * walks and `$in` walks over numeric fields are routed normally.
 *
 * `NaN` throws `BaerlyError{code:"SchemaError"}` at write time —
 * the byte encoding has no order-preserving slot for it, and a
 * silent collapse to the `null` key (as the prior
 * `JSON.stringify`-based encoder did, since
 * `JSON.stringify(NaN) === "null"`) is a worse failure mode than
 * a loud reject.
 *
 * `-0` and `+0` collapse to the same encoding.
 *
 * Equal-by-value inputs (e.g. two `{a:1, b:2}` objects with the
 * same key insertion order) produce byte-equal segments;
 * structurally-different but visually-similar inputs (`"5"` vs `5`)
 * are kept apart by the type-tag prefix.
 *
 * String ranges remain safe: `"2026-05-13" < "2026-05-14"`
 * byte-wise matches semantic order. ISO 8601 timestamps,
 * alphabetical priorities like `"p1"/"p2"/"p3"`, and any
 * fixed-width string encoding are usable as range-walked indexed
 * fields.
 */
export const encodeIndexValue = (v: unknown): string => {
  const bytes = encodeBytes(v);
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
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  // The type-prefix guarantees the byte stream is non-empty for every
  // input, so the "empty → '0'" fallback that the old encoder needed
  // is dead. Encoder output is always non-empty under the new contract.
  return out;
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
 *   path, or the indexed field's value is an array. Both restrictions
 *   are pre-launch; multi-value (array) indexes are a follow-up.
 */
export const projectIndexValues = (
  def: IndexDefinition,
  body: DocumentData | undefined,
): readonly unknown[] | undefined => {
  if (body === undefined) {
    return undefined;
  }
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
    if (v === null || v === undefined) {
      return undefined;
    }
    // Array values are valid in documents (RFC 7386 replacement
    // semantics) but multi-value indexes aren't supported yet — the
    // prefix-tree encoder produces one key per doc, not one per
    // element. Throw loudly so a user indexing a tag list gets a
    // clear error instead of garbage keys.
    if (Array.isArray(v)) {
      throw new BaerlyError(
        "SchemaError",
        `index ${def.name}: cannot index array field "${field}" — multi-value indexes are not supported yet`,
      );
    }
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
 * must satisfy `matchesWire(def.predicate, body)` or the def contributes
 * zero keys. The writer's diff `oldKeys` vs `newKeys` then covers
 * all four U-quadrants automatically — see the JSDoc on
 * `writer.ts` above the index-emission block. `body ===
 * undefined` short-circuits ahead of the filter check (no keys for
 * an unknown pre-image, regardless of filter), preserving the prior
 * D-quadrant behaviour.
 */
export const allIndexKeysFor = (
  logPrefix: string,
  defs: ReadonlyArray<IndexDefinition>,
  body: DocumentData | undefined,
  docId: string,
): string[] => {
  const keys: string[] = [];
  for (const def of defs) {
    if (def.predicate !== undefined && body !== undefined) {
      if (!matchesWire(def.predicate, body)) {
        continue;
      }
    }
    const values = projectIndexValues(def, body);
    if (values !== undefined) {
      keys.push(indexKeyFor(logPrefix, def, values, docId));
    }
  }
  return keys;
};
