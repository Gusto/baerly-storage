/**
 * In-memory query evaluation over a folded row map: the predicate
 * filter, the counting pass, `order` with its bounded top-k, and the
 * `limit` cut. `runReadRows`
 * (`./query.ts`) calls these after the snapshot + log fold; they do no
 * I/O.
 */

import {
  compileWire,
  type DocumentData,
  type OrderSpec,
  type PredicateWire,
  QUERY_TOP_K_MAX,
  QUERY_TOP_K_SAMPLE,
} from "@baerly/protocol";

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

/**
 * Compare two primitive order-key values under one direction, as
 * {@link sortByOrderSpec} does: a missing value sorts low under `asc`
 * and high under `desc`; otherwise `<`. {@link orderRows} calls it only
 * once its pre-scan has ruled out objects and `null`.
 */
const compareKey = (a: unknown, b: unknown, desc: boolean): number => {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return desc ? 1 : -1;
  }
  if (b === undefined) {
    return desc ? -1 : 1;
  }
  const cmp = (a as number) < (b as number) ? -1 : 1;
  return desc ? -cmp : cmp;
};

/**
 * Stable multi-key sort built from an `OrderSpec`. Keys are taken in
 * the spec's insertion order, which matches the caller's source-order
 * expectation. `Array.prototype.sort` is stable on Node 26+ and Workerd.
 *
 * Top-level fields only (locked at `OrderSpec<T>`).
 * Values are `DocumentValue` — string / number / boolean / object —
 * but only the primitive types are sensibly orderable; comparing two
 * objects falls through to "considered equal," which preserves the
 * stable-sort order of the input.
 */
export const sortByOrderSpec = <D extends DocumentData, R extends StoredDoc<D>>(
  rows: readonly R[],
  spec: OrderSpec<D>,
): R[] => {
  const entries = Object.entries(spec) as Array<[keyof D, "asc" | "desc"]>;
  return rows.toSorted((a, b) => {
    for (const [field, dir] of entries) {
      const av: D[keyof D] | undefined = a.doc[field];
      const bv: D[keyof D] | undefined = b.doc[field];
      if (av === bv) {
        continue;
      }
      // `undefined` (missing field) sorts low under asc / high under
      // desc — same shape SQL's `NULLS FIRST` gives on asc.
      if (av === undefined) {
        return dir === "desc" ? 1 : -1;
      }
      if (bv === undefined) {
        return dir === "desc" ? -1 : 1;
      }
      // string / number / boolean compare uniformly under `<`. Booleans
      // compare false < true (JS default). Object values fall through
      // as "considered equal" — see JSDoc above.
      if (typeof av === "object" || typeof bv === "object") {
        continue;
      }
      const cmp = av < bv ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
};

/**
 * `sortByOrderSpec(rows, spec)` cut by `limit` as the row path cuts it,
 * without sorting every row when `limit` is small.
 *
 * The bounded path runs when `limit` is an integer in
 * `[1, QUERY_TOP_K_MAX]` below `rows.length` (PostgreSQL's bounded
 * top-N heapsort for `ORDER BY … LIMIT` has the same shape). One O(n)
 * pass checks that each order key holds a single primitive type (plus
 * missing values), under which the comparator is a total preorder; a
 * key holding objects, `null` or mixed types falls back to the full
 * sort, whose comparator is not transitive there. The same pass
 * compares adjacent rows:
 *
 * - No row orders before its predecessor: the input is already in
 *   order, so the first `limit` rows are the answer.
 * - No row orders after its predecessor: the input is in reverse order,
 *   so the answer is read from the end, keeping tied rows in input
 *   order.
 * - Otherwise a max-heap keeps the best `limit` rows under the
 *   comparator, ties broken by input index, which is the stable sort's
 *   order. The heap's result does not depend on the order rows are fed
 *   in, so it reads the input from the end when more compared adjacent
 *   pairs fall than rise (later rows ordering first), which keeps root
 *   replacements rare on nearly reversed input.
 *
 * The output is identical to `sortByOrderSpec(rows, spec).slice(0, limit)`.
 */
export const orderRows = <D extends DocumentData, R extends StoredDoc<D>>(
  rows: R[],
  spec: OrderSpec<D>,
  limit: number | undefined,
): R[] => {
  const n = rows.length;
  if (
    limit === undefined ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > QUERY_TOP_K_MAX ||
    limit >= n
  ) {
    return sortByOrderSpec(rows, spec);
  }
  const fields = Object.keys(spec) as Array<keyof D>;
  const desc = fields.map((field) => spec[field] === "desc");
  const types: Array<string | undefined> = [];
  // Key values of the previous and current row, so each row is read once.
  let prev: unknown[] = [];
  let cur: unknown[] = [];
  let ascents = 0;
  let descents = 0;
  for (let i = 0; i < n; i++) {
    const doc = rows[i]!.doc;
    for (let j = 0; j < fields.length; j++) {
      const value: unknown = doc[fields[j]!];
      if (value !== undefined) {
        const type = typeof value;
        if (type === "object" || (types[j] !== undefined && types[j] !== type)) {
          return sortByOrderSpec(rows, spec).slice(0, limit);
        }
        types[j] = type;
      }
      cur[j] = value;
    }
    // Compare a sample prefix, then only while the input still looks
    // monotone: the counts pick a path, the answer never depends on them.
    if (i > 0 && (i <= QUERY_TOP_K_SAMPLE || ascents === 0 || descents === 0)) {
      let cmp = 0;
      for (let j = 0; j < fields.length && cmp === 0; j++) {
        cmp = compareKey(prev[j], cur[j], desc[j]!);
      }
      if (cmp < 0) {
        ascents++;
      } else if (cmp > 0) {
        descents++;
      }
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  if (descents === 0) {
    return rows.slice(0, limit);
  }
  const compareKeys = (a: number, b: number): number => {
    const x = rows[a]!.doc;
    const y = rows[b]!.doc;
    let cmp = 0;
    for (let j = 0; j < fields.length && cmp === 0; j++) {
      cmp = compareKey(x[fields[j]!], y[fields[j]!], desc[j]!);
    }
    return cmp;
  };
  if (ascents === 0) {
    // Reverse order: take tie groups from the end, each in input order.
    const out: R[] = [];
    let end = n;
    while (out.length < limit) {
      let start = end - 1;
      while (start > 0 && compareKeys(start - 1, start) === 0) {
        start--;
      }
      for (let i = start; i < end && out.length < limit; i++) {
        out.push(rows[i]!);
      }
      end = start;
    }
    return out;
  }
  // The stable sort's order: ties keep input order.
  const compare = (a: number, b: number): number => compareKeys(a, b) || a - b;
  // Max-heap of row indices, full at `limit`: the root is the worst row kept.
  const heap: number[] = [];
  const siftDown = (pos: number): void => {
    for (;;) {
      const left = 2 * pos + 1;
      if (left >= limit) {
        return;
      }
      const right = left + 1;
      const worst = right < limit && compare(heap[right]!, heap[left]!) > 0 ? right : left;
      if (compare(heap[worst]!, heap[pos]!) < 0) {
        return;
      }
      [heap[pos], heap[worst]] = [heap[worst]!, heap[pos]!];
      pos = worst;
    }
  };
  const backward = descents > ascents;
  for (let x = 0; x < n; x++) {
    const i = backward ? n - 1 - x : x;
    if (heap.length < limit) {
      // Heapify once the first `limit` rows are in.
      if (heap.push(i) === limit) {
        for (let pos = (limit >> 1) - 1; pos >= 0; pos--) {
          siftDown(pos);
        }
      }
    } else if (compare(i, heap[0]!) < 0) {
      heap[0] = i;
      siftDown(0);
    }
  }
  return heap.toSorted(compare).map((i) => rows[i]!);
};
