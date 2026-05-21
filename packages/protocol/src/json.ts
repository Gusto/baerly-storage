import { FORBIDDEN_MERGE_KEYS } from "./constants.ts";

/**
 * The shape constraint for documents stored in a {@link Table}.
 *
 * Plain JSON object: string-keyed; values are strings, numbers,
 * booleans, nested {@link DocumentData}, or arrays of
 * {@link DocumentValue}.
 *
 * The document **body** itself must be an object (not an array) —
 * Baerly's writer is built on JSON Merge Patch (RFC 7396), which
 * is only defined over object documents. Array *values* at any
 * nested level are fine; per RFC 7396, an array in a patch
 * replaces the target array wholesale (Baerly has no array-merge
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

export type JSONObject = { [x: string]: JSONValue };
export type JSONValue = string | number | boolean | null | JSONObject | Array<JSONValue>;

const isPlainObject = (
  value: DocumentValue | undefined,
): value is DocumentData =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * JSON Merge Patch (RFC 7396).
 *
 * Update `target` with a merge patch. Plain-object values recurse
 * key-by-key; primitives, arrays, and type-mismatched values replace
 * the target wholesale. A `null` value in `patch` deletes the key.
 *
 * RFC 7396 explicitly treats arrays as opaque values: an array in a
 * patch replaces the target array — there is no element-wise merge.
 */
export function merge<T extends DocumentValue>(
  target: T | undefined,
  patch: Partial<T> | null | undefined,
): T | undefined {
  if (patch === undefined) {
    return target;
  }
  if (patch === null) {
    return undefined;
  }

  // Patch is primitive or an array → replace target wholesale.
  if (!isPlainObject(patch as DocumentValue)) {
    return patch as T;
  }
  // Patch is a plain object but target isn't → replace.
  if (!isPlainObject(target)) {
    return patch as T;
  }

  const combined = { ...(target as DocumentData) } as T;
  for (const key of Object.keys(patch) as Array<Extract<keyof T, string>>) {
    // Object.keys returns own enumerable string keys — but `__proto__`
    // is an own property when patches arrive via JSON.parse (HTTP PATCH
    // bodies hit this path through query.ts:runUpdate). Guard remains
    // load-bearing. See predicate.test.ts for the same vector.
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    if (patch[key] === null) {
      delete combined[key];
    } else {
      combined[key] = merge(target[key] as DocumentValue, patch[key] as DocumentValue) as T[Extract<
        keyof T,
        string
      >];
    }
  }
  return combined as T;
}
