import { FORBIDDEN_MERGE_KEYS } from "./constants.ts";

/**
 * The shape constraint for documents stored in a {@link Table}.
 *
 * Plain JSON object: string-keyed; values are strings, numbers,
 * booleans, or nested {@link DocumentData}. Arrays are allowed only
 * inside nested objects, never at the top level — JSON Merge Patch
 * (RFC 7386) can't deep-merge top-level arrays, and Baerly's writer
 * path is built on merge patch.
 */
export type DocumentData = { [x: string]: DocumentValue };

/**
 * A single field value inside a {@link DocumentData}. The recursive
 * type that backs {@link DocumentData}, also used by predicate and
 * order-spec types in `@baerly/protocol/query`.
 */
export type DocumentValue = string | number | boolean | DocumentData;

export type JSONObject = { [x: string]: JSONValue };
export type JSONValue = string | number | boolean | null | JSONObject | Array<JSONValue>;

/**
 * JSON Merge Patch (RFC 7386)
 * Update target JSON with a merge patch.
 * This routine does not support arrays
 */
export function merge<T extends DocumentValue>(
  target: T | undefined,
  patch: Partial<T> | null | undefined,
): T | undefined {
  // If patch is an array or a primitive, just return it

  if (patch === undefined) {
    return target;
  }
  if (patch === null) {
    return undefined;
  }

  if (typeof patch !== "object" || typeof target !== "object") {
    return patch as T;
  }
  const combined = typeof target === "object" ? { ...target } : ({} as T);
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
