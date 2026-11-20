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

import { compareDocIds } from "./snapshot-doc-id.ts";

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
 * The cross-type rank of an order-key value: `null` and a missing
 * field, numbers, strings, booleans, objects, arrays. Values of
 * different ranks never compare by value, so no JS `<` coercion
 * (`"10" < 9`, `null < 1`) leaks into the order.
 */
const typeRank = (value: unknown): number => {
  if (value === undefined || value === null) {
    return 0;
  }
  const type = typeof value;
  if (type === "number") {
    return 1;
  }
  if (type === "string") {
    return 2;
  }
  if (type === "boolean") {
    return 3;
  }
  return Array.isArray(value) ? 5 : 4;
};

/**
 * Ascending comparison of two order-key values: by {@link typeRank},
 * then within a rank by `<` (booleans `false < true`). `null` and a
 * missing field tie, as do any two objects and any two arrays, which
 * have no value order; the caller's `_id` tiebreak settles those.
 */
const compareValues = (a: unknown, b: unknown): number => {
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) {
    return rankA < rankB ? -1 : 1;
  }
  if (rankA === 0 || rankA >= 4 || a === b) {
    return 0;
  }
  return (a as number) < (b as number) ? -1 : 1;
};

/**
 * The total order {@link sortByOrderSpec} sorts by: each key in the
 * spec's order by {@link compareValues}, negated under `desc`, then
 * the row's `_id` by UTF-8 byte order. `desc` reverses the whole
 * order, so `null` and missing sort last. The `_id` tiebreak takes the
 * last key's direction (`asc` for an empty spec), which makes `desc` the
 * exact reverse of `asc`. `docId` is the row's `_id`, unique per row, so
 * no two rows tie.
 */
const makeRowComparator = <D extends DocumentData>(
  spec: OrderSpec<D>,
): ((a: StoredDoc<D>, b: StoredDoc<D>) => number) => {
  const fields = Object.keys(spec) as Array<keyof D>;
  const desc = fields.map((field) => spec[field] === "desc");
  const idSign = desc[desc.length - 1] === true ? -1 : 1;
  return (a, b) => {
    for (let j = 0; j < fields.length; j++) {
      const cmp = compareValues(a.doc[fields[j]!], b.doc[fields[j]!]);
      if (cmp !== 0) {
        return desc[j]! ? -cmp : cmp;
      }
    }
    return idSign * compareDocIds(a.docId, b.docId);
  };
};

/**
 * Stable multi-key sort built from an `OrderSpec`, a total order (see
 * `Query.order`): keys are taken in the spec's insertion order, which
 * matches the caller's source-order expectation, then `_id` breaks
 * ties.
 *
 * Top-level fields only (locked at `OrderSpec<T>`).
 */
export const sortByOrderSpec = <D extends DocumentData, R extends StoredDoc<D>>(
  rows: readonly R[],
  spec: OrderSpec<D>,
): R[] => rows.toSorted(makeRowComparator(spec));

/**
 * `sortByOrderSpec(rows, spec)` cut by `limit` as the row path cuts it,
 * without sorting every row when `limit` is small.
 *
 * The bounded path runs when `limit` is an integer in
 * `[1, QUERY_TOP_K_MAX]` below `rows.length` (PostgreSQL's bounded
 * top-N heapsort for `ORDER BY … LIMIT` has the same shape). A linear
 * pass compares adjacent rows under the total order, including the
 * `_id` tiebreak:
 *
 * - Already ordered input returns its first `limit` rows.
 * - Reverse ordered input returns its last `limit` rows in reverse.
 * - Otherwise a max-heap keeps the best `limit` rows. It scans from
 *   the end when more adjacent pairs fall than rise, reducing heap
 *   replacements on nearly reversed input.
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
  const compareRows = makeRowComparator(spec);
  let ascents = 0;
  let descents = 0;
  for (let i = 1; i < n; i++) {
    // Compare a sample prefix, then only while the input still looks
    // monotone: the counts pick a path, the answer never depends on them.
    if (i <= QUERY_TOP_K_SAMPLE || ascents === 0 || descents === 0) {
      const cmp = compareRows(rows[i - 1]!, rows[i]!);
      if (cmp < 0) {
        ascents++;
      } else if (cmp > 0) {
        descents++;
      }
    }
  }
  if (descents === 0) {
    return rows.slice(0, limit);
  }
  const compareKeys = (a: number, b: number): number => compareRows(rows[a]!, rows[b]!);
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
