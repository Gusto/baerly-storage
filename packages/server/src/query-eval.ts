/**
 * In-memory query evaluation over a folded row map: the predicate
 * filter, the counting pass, and the `limit` cut. `runReadRows`
 * (`./query.ts`) calls these after the snapshot + log fold; they do no
 * I/O.
 */

import { compileWire, type DocumentData, type PredicateWire } from "@baerly/protocol";

/**
 * A materialised row paired with the `doc_id` it is stored under. The
 * mutation verbs commit under `docId`, and check that the row's own `_id`
 * agrees with it (see `storedRowId` in `./query.ts`).
 */
export interface StoredDoc<D extends DocumentData> {
  readonly docId: string;
  readonly doc: D;
}

/**
 * The rows of `docs` that satisfy `wire`, in map order, built in one pass.
 * With no predicate, every row.
 */
export const filterRows = <D extends DocumentData>(
  docs: ReadonlyMap<string, D>,
  wire: PredicateWire | undefined,
): StoredDoc<D>[] => {
  if (wire === undefined) {
    return Array.from(docs, ([docId, doc]) => ({ docId, doc }));
  }
  const matches = compileWire(wire);
  const rows: StoredDoc<D>[] = [];
  for (const [docId, doc] of docs) {
    if (matches(doc)) {
      rows.push({ docId, doc });
    }
  }
  return rows;
};

/** How many rows of `docs` satisfy `wire`, without materialising them. */
export const countMatches = <D extends DocumentData>(
  docs: ReadonlyMap<string, D>,
  wire: PredicateWire | undefined,
): number => {
  if (wire === undefined) {
    return docs.size;
  }
  const matches = compileWire(wire);
  let count = 0;
  for (const doc of docs.values()) {
    if (matches(doc)) {
      count++;
    }
  }
  return count;
};

/**
 * How many of `n` rows `limit` keeps: the length `rows.slice(0, limit)`
 * would have. Both the row path (which truncates to it) and the count
 * use it, so a count honours `limit` exactly as `all()` does, including
 * a fractional or negative `limit` (`slice` truncates it, and counts a
 * negative end from the back).
 */
export const limitedLength = (n: number, limit: number | undefined): number => {
  if (limit === undefined || !(limit < n)) {
    return n;
  }
  // `|| 0` folds `-0` (from a limit in (-1, 0)) to `0`, as `slice` does.
  const end = Math.trunc(limit) || 0;
  return end < 0 ? Math.max(n + end, 0) : end;
};
