import { FORBIDDEN_MERGE_KEYS } from "./constants.ts";

export type JSONArraylessObject = { [x: string]: JSONArrayless };
export type JSONArrayless = string | number | boolean | JSONArraylessObject;

export type JSONObject = { [x: string]: JSONValue };
export type JSONValue = string | number | boolean | null | JSONObject | Array<JSONValue>;

/**
 * JSON Merge Patch (RFC 7386)
 * Update target JSON with a merge patch.
 * This routine does not support arrays
 */
export function merge<T extends JSONArrayless>(
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
      combined[key] = merge(target[key] as JSONArrayless, patch[key] as JSONArrayless) as T[Extract<
        keyof T,
        string
      >];
    }
  }
  return combined as T;
}
