export type JSONArraylessObject = { [x: string]: JSONArrayless };
export type JSONArrayless = string | number | boolean | JSONArraylessObject;

export type JSONObject = { [x: string]: JSONValue };
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONObject
  | Array<JSONValue>;

export const clone = <T extends JSONValue>(state: T): T =>
  JSON.parse(JSON.stringify(state));

/**
 * JSON Merge Patch (RFC 7386)
 * Update target JSON with a merge patch.
 * This routine does not support arrays
 */
export function merge<T extends JSONArrayless>(
  target: T | undefined,
  patch: Partial<T> | null | undefined
): T | undefined {
  // If patch is an array or a primitive, just return it

  if (patch === undefined) return target;
  if (patch === null) return undefined;

  if (typeof patch !== "object" || typeof target !== "object") {
    return <T>patch;
  }
  const combined = typeof target === "object" ? { ...target } : <T>{};
  for (let key in patch) {
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
    <Partial<T>>{}
  );
}

/**
 * JSON Merge Diff
 * The inverse of JSON-merge-patch
 */
export function diff<T extends JSONArrayless>(
  target: T | undefined,
  source: T | undefined
): Partial<T> | undefined | null {
  if (source === target) return undefined;
  if (source !== undefined && target === undefined) return null;
  if (typeof target !== "object" || typeof source !== "object") return target;
  // recursive diff against two objects
  const patch: Partial<T> = {};
  const targeKeys = Object.keys(target);
  const sourceKeys = Object.keys(source);
  for (let i = 0; i < Math.max(targeKeys.length, sourceKeys.length); i++) {
    const key = targeKeys[i] || sourceKeys[i];
    const val = diff(target[key], source[key]);
    if (val !== undefined) (<any>patch)[key] = val;
  }
  return patch;
}
