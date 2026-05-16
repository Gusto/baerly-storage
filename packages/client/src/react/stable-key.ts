/**
 * Deterministic JSON serialization with sorted object keys. The live-
 * read hooks (`useLiveQuery`, `useLiveDocument`) feed the result into
 * a `useEffect` deps array so consumers can pass inline predicate
 * objects (`{ status: filter }`) without churning a refetch on every
 * render. Sorting keys means `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }`
 * stringify identically, which `JSON.stringify` alone does not
 * guarantee (it preserves insertion order).
 *
 * Predicates carry `JSONArraylessObject` shapes — no `undefined`, no
 * functions, no circular references — so a recursive walk terminates
 * and the output is well-defined. Arrays are kept (predicate
 * comparators may include array literals like `{ status: ["open"] }`
 * in a future grammar; we serialize them positionally).
 *
 * @internal
 */
export const stableKey = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(",")}}`;
};
