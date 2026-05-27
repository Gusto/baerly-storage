/**
 * Deterministic JSON serialization with sorted object keys. `useQuery`
 * feeds its `[chainShape, deps]` tuple into this to compute the
 * read-signature that keys the subscription-pool's result cache.
 * Sorting keys means `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` stringify
 * identically, which `JSON.stringify` alone does not guarantee (it
 * preserves insertion order).
 *
 * Inputs are caller-declared `deps` plus the deterministic chain
 * shape — no `undefined`, no functions, no circular references — so
 * a recursive walk terminates and the output is well-defined. Arrays
 * are serialized positionally.
 *
 * @internal
 */
export const stableKey = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    compareStrings(a, b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(",")}}`;
};

// Lex compare for object-key ordering. `localeCompare` is locale-aware
// and would re-order BMP code points; we need byte-stable output so the
// `useEffect` deps key is identical across machines.
const compareStrings = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};
