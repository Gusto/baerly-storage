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
    return <T>patch;
  }
  const combined = typeof target === "object" ? { ...target } : <T>{};
  for (let key in patch) {
    // reject prototype pollution
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (patch[key] === null) {
      delete combined[key];
    } else {
      combined[key] = merge<any>(target![key], patch[key]!);
    }
  }
  return <T>combined;
}

export function fold<T extends JSONArrayless>(
  ...patches: (Partial<T> | undefined)[]
): Partial<T> | undefined {
  return patches.reduce<Partial<T> | undefined>(
    (acc, patch) => merge<T>(<T>acc, patch),
    <Partial<T>>{},
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
    const val = diff((target as any)[key], (source as any)[key]);
    if (val !== undefined) (<any>patch)[key] = val;
  }
  return patch;
}
