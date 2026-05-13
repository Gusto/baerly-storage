import { FORBIDDEN_MERGE_KEYS } from "./constants.ts";

export type JSONArraylessObject = { [x: string]: JSONArrayless };
export type JSONArrayless = string | number | boolean | JSONArraylessObject;

export type JSONObject = { [x: string]: JSONValue };
export type JSONValue = string | number | boolean | null | JSONObject | Array<JSONValue>;

export const clone = <T extends JSONValue>(state: T): T => structuredClone(state);

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

  if (patch === undefined) return target;
  if (patch === null) return undefined;

  if (typeof patch !== "object" || typeof target !== "object") {
    return patch as T;
  }
  const combined = typeof target === "object" ? { ...target } : ({} as T);
  for (const key of Object.keys(patch) as Array<Extract<keyof T, string>>) {
    // Object.keys returns own enumerable string keys — but `__proto__`
    // is an own property when patches arrive via JSON.parse (HTTP PATCH
    // bodies hit this path through query.ts:runUpdate). Guard remains
    // load-bearing. See predicate.test.ts for the same vector.
    if (FORBIDDEN_MERGE_KEYS.has(key)) continue;
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

export function fold<T extends JSONArrayless>(
  ...patches: (Partial<T> | undefined)[]
): Partial<T> | undefined {
  return patches.reduce<Partial<T> | undefined>(
    (acc, patch) => merge<T>(acc as T, patch),
    {} as Partial<T>,
  );
}

/**
 * JSON Merge Diff
 * The inverse of JSON-merge-patch
 */
export function diff<T extends JSONArrayless>(
  target: T | undefined,
  source: T | undefined,
): Partial<T> | undefined | null {
  if (source === target) return undefined;
  if (source !== undefined && target === undefined) return null;
  if (typeof target !== "object" || typeof source !== "object") return target;
  // recursive diff against two objects: walk the union of keys so that
  // keys present only in `source` produce a deletion (`null`) in the patch.
  const patch: Partial<T> = {};
  const allKeys = new Set([...Object.keys(target), ...Object.keys(source)]);
  for (const key of allKeys) {
    const tVal: JSONArrayless | undefined = (target as JSONArraylessObject | undefined)?.[key];
    const sVal: JSONArrayless | undefined = (source as JSONArraylessObject | undefined)?.[key];
    const val = diff(tVal, sVal);
    if (val !== undefined) (patch as JSONArraylessObject)[key] = val as JSONArrayless;
  }
  return patch;
}
