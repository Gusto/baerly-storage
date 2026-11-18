import { FORBIDDEN_MERGE_KEYS } from "./constants.ts";

/**
 * The shape constraint for documents stored in a {@link Collection}.
 *
 * Plain JSON object: string-keyed; values are strings, numbers,
 * booleans, nested {@link DocumentData}, or arrays of
 * {@link DocumentValue}.
 *
 * The document **body** itself must be an object (not an array) —
 * baerly-storage's writer is built on JSON Merge Patch (RFC 7386), which
 * is only defined over object documents. Array *values* at any
 * nested level are fine; per RFC 7386, an array in a patch
 * replaces the target array wholesale (baerly-storage has no array-merge
 * semantics).
 */
export type DocumentData = { [x: string]: DocumentValue };

/**
 * A single field value inside a {@link DocumentData}. The recursive
 * type that backs {@link DocumentData}, also used by predicate and
 * order-spec types in `@baerly/protocol/query`.
 *
 * Arrays are valid values; they are replaced (not merged) on patch.
 */
export type DocumentValue = string | number | boolean | DocumentData | Array<DocumentValue>;

/**
 * The patch an `update` takes for a row of type `T`: a JSON Merge Patch
 * (RFC 7396), typed against the row.
 *
 * - Every key is optional; a key left out is left unchanged.
 * - An optional key also accepts `null`, which deletes the field.
 *   A required key does not: remove it with `replace` instead.
 * - A required object member with a single object type accepts a nested
 *   `MergePatch`, merged field by field. Union-valued members require a
 *   whole value because the current value may belong to another variant.
 * - An optional plain-object member takes its whole value or `null`,
 *   never a nested patch: to change part of an optional object, pass
 *   the whole object or use `replace`.
 * - Arrays and scalars replace the stored value whole; array elements
 *   are never merged.
 *
 * Supplying a whole object still merges its fields; use `replace` to
 * discard existing fields. Values must be plain JSON at runtime; this
 * structural type cannot distinguish data-only classes from interfaces.
 *
 * On an unbound collection (`T` is `DocumentData`) every key is
 * optional, so any field accepts a value, a nested patch or `null`.
 *
 * @example
 * ```ts
 * type Ticket = {
 *   title: string;
 *   note?: string;
 *   meta: { owner: string; reviewer?: string };
 *   extra?: { flag?: boolean };
 * };
 *
 * const patch: MergePatch<Ticket> = {
 *   note: null, // deletes `note`
 *   meta: { reviewer: null }, // merges into the required `meta`
 *   extra: { flag: true }, // supplies the whole optional object
 * };
 * // @ts-expect-error — `title` is required; use `replace` to remove it
 * const bad: MergePatch<Ticket> = { title: null };
 * ```
 */
export type MergePatch<T> = {
  [K in keyof T]?: string extends K
    ? MergePatchObjectValue<T[K]> | null
    : {} extends Pick<T, K>
      ? T[K] | null
      : MergePatchValue<T[K]>;
};

/**
 * Only a single object type guarantees that required nested fields
 * already exist. A union may switch variants, so it takes a whole value.
 */
type MergePatchValue<V> = true extends IsUnion<V> ? V : MergePatchObjectValue<V>;

type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never;

/** Index-signature values stay permissive, including nested patches. */
type MergePatchObjectValue<V> = V extends readonly unknown[]
  ? V
  : V extends object
    ? MergePatch<V>
    : V;

export type JSONObject = { [x: string]: JSONValue };
export type JSONValue = string | number | boolean | null | JSONObject | Array<JSONValue>;

/**
 * Structural equality of two JSON values.
 *
 * Both inputs must already be JSON-normalized, i.e. the result of a
 * `JSON.parse` — typically `JSON.parse(JSON.stringify(body))` compared
 * against a stored row decoded from JSON. The round-trip drops
 * `undefined` properties (as the write path's encoder does) and turns
 * `-0` into `0`; that normalization is the caller's responsibility.
 * Raw inputs holding `undefined` or `-0` are outside the contract.
 *
 * Uses an explicit work stack so comparison does not consume the
 * JavaScript call stack with each nesting level. No depth cap is enforced.
 *
 * - Object key order is ignored; the key sets must match exactly.
 * - Arrays compare element-wise in order, and an array is never equal
 *   to an object (`[1]` vs `{"0":1}` is `false`).
 * - Primitives compare with `===`.
 *
 * Deliberately not `deepEqualDocumentValue`, which cannot tell an array
 * from an index-keyed object.
 */
export function jsonValueEqual(a: JSONValue, b: JSONValue): boolean {
  const pending: Array<[JSONValue, JSONValue]> = [[a, b]];
  while (pending.length > 0) {
    const [left, right] = pending.pop()!;
    if (left === right) {
      continue;
    }
    if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
      return false;
    }
    if (Array.isArray(left)) {
      if (!Array.isArray(right) || left.length !== right.length) {
        return false;
      }
      // Indexed loop, not `every`: `every` skips holes, which would make a
      // sparse array compare asymmetrically.
      for (let i = 0; i < left.length; i++) {
        pending.push([left[i]!, right[i]!]);
      }
      continue;
    }
    if (Array.isArray(right)) {
      return false;
    }
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) {
      return false;
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) {
        return false;
      }
      pending.push([left[key]!, right[key]!]);
    }
  }
  return true;
}

const isPlainObject = (value: DocumentValue | undefined): value is DocumentData =>
  // Stryker disable next-line ConditionalExpression: `value !== null` is a defensive guard — null
  // is not in DocumentValue; null patches are caught by the `patch === null` early-return before
  // isPlainObject is called. Replacing `value !== null` with `true` is equivalent for all
  // reachable call sites: genuine dead-branch equivalence.
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Apply a JSON Merge Patch to a document, exactly as RFC 7396 §2 defines
 * it. This is what `update` commits: `applyMergePatch(row, patch)`.
 *
 * An object patch merges key by key into the target, or into `{}` when
 * the target is absent or not an object. A `null` member deletes that
 * key, at every depth, so a patch never stores a `null` member: under an
 * absent field, `{ meta: { a: 1, b: null } }` stores `meta: { a: 1 }`.
 * A scalar or array patch replaces the target whole; arrays are opaque
 * values, so a `null` inside one is kept. An `undefined` member is
 * absent, as in the patch's JSON form.
 *
 * Two values outside RFC 7396's JSON domain: an `undefined` patch is the
 * identity (returns `target`), and a `null` patch at the root returns
 * `undefined`, since a document cannot be `null`.
 *
 * `__proto__`, `constructor` and `prototype` members are skipped
 * (`FORBIDDEN_MERGE_KEYS`). Recursion follows the patch, whose depth
 * `assertDocumentValues` caps at `MAX_DOCUMENT_DEPTH` before `update`
 * applies it.
 */
export function applyMergePatch<T extends DocumentValue>(
  target: T | undefined,
  patch: Partial<T> | null | undefined,
): T | undefined {
  if (patch === undefined) {
    return target;
  }
  if (patch === null) {
    return undefined;
  }
  if (!isPlainObject(patch as DocumentValue)) {
    return patch as T;
  }
  // An absent or non-object target merges as `{}` (RFC 7396 §2).
  const combined: DocumentData = isPlainObject(target) ? { ...target } : {};
  const members = patch as Record<string, DocumentValue | null | undefined>;
  for (const key of Object.keys(members)) {
    // Object.keys returns own enumerable string keys — but `__proto__`
    // is an own property when patches arrive via JSON.parse (HTTP PATCH
    // bodies hit this path through query.ts:runUpdate). Guard remains
    // load-bearing. See predicate.test.ts for the same vector.
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const value = members[key];
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      delete combined[key];
    } else {
      combined[key] = applyMergePatch(combined[key], value)!;
    }
  }
  return combined as T;
}

/**
 * Coalesce two merge patches into one: the summary patch for `earlier`
 * followed by `later`. Folding from `undefined`,
 * `fold(coalesceMergePatches, undefined, patches)` summarizes a window.
 *
 * Unlike {@link applyMergePatch}, an object patch over an absent or
 * non-object accumulator is taken as written, nulls included, so
 * `coalesceMergePatches(undefined, { x: null })` keeps the delete as
 * `{ x: null }`. The summary is exact only inside the type-stable window
 * `docs/spec/json-merge-patch.md` ("Log can be coalesced") describes: a
 * `later` delete of a key `earlier` set removes it from the summary, and
 * a delete followed by an object re-add cannot be expressed. No runtime
 * path coalesces patches today; `update` commits full post-images.
 */
export function coalesceMergePatches<T extends DocumentValue>(
  earlier: T | undefined,
  later: Partial<T> | null | undefined,
): T | undefined {
  if (later === undefined) {
    return earlier;
  }
  if (later === null) {
    return undefined;
  }

  // Later patch is primitive or an array → replace wholesale.
  if (!isPlainObject(later as DocumentValue)) {
    return later as T;
  }
  // Later patch is a plain object but the accumulator isn't → take it
  // as written, so its deletes survive.
  if (!isPlainObject(earlier)) {
    return later as T;
  }

  const combined = { ...(earlier as DocumentData) } as T;
  for (const key of Object.keys(later) as Array<Extract<keyof T, string>>) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    if (later[key] === null) {
      delete combined[key];
    } else {
      combined[key] = coalesceMergePatches(
        earlier[key] as DocumentValue,
        later[key] as DocumentValue,
      ) as T[Extract<keyof T, string>];
    }
  }
  return combined as T;
}
