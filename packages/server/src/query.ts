/**
 * Phase-4 read engine: `Query<T>` builder + the three read terminals
 * (`first`, `all`, `count`) that fold the log under a fresh
 * `current.json` snapshot.
 *
 * Every modifier (`.where` / `.order` / `.limit`) returns a NEW
 * `Query<T>` carrying merged frozen state — the input state is never
 * mutated. Identity inequality between the original and the returned
 * builder is intentional: callers cannot share a chain.
 *
 * `.where()` AND-merges through `mergePredicates` (ticket 08).
 * `.order()` and `.limit()` are last-call-wins (state replace).
 *
 * Each terminal reads `current.json` FRESH and walks `[0, next_seq)`
 * directly — no cache, no `list()` round-trip. Per Phase-3 multi-
 * instance rules, every read sees a fresh CAS snapshot.
 *
 * @see ../../../.claude/research/planning/tickets/09-table-and-query-reads.md
 */

import {
  type JSONArraylessObject,
  type LogEntry,
  matches,
  merge,
  mergePredicates,
  MPS3Error,
  type OrderSpec,
  type Predicate,
  type Query,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";

/**
 * What a `Query<T>` needs to issue a read against the bucket. The
 * `Db` builds this once and hands it to `Table` / `Query`; the chain
 * carries it forward unchanged.
 *
 * The `tablePrefix` shape matches what `ServerWriter` writes under —
 * e.g. `"app/<app>/tenant/<tenant>/manifests/<name>"`. Drift between
 * the reader and writer prefix is the most likely bug class; both
 * compose the same string from `app`/`tenant`/`name`.
 *
 * @internal
 */
export interface TableReadContext {
  readonly storage: Storage;
  /** Physical key prefix — already includes `app/<app>/tenant/<tenant>/manifests/<name>`. */
  readonly tablePrefix: string;
  readonly tableName: string;
}

/**
 * Frozen state carried along a `Query<T>` chain. Every modifier
 * produces a fresh `QueryState<T>` via spread + `Object.freeze`; the
 * predicate / order / limit fields are never mutated in place.
 *
 * @internal
 */
export interface QueryState<T extends JSONArraylessObject> {
  readonly predicate: Predicate<T> | undefined;
  readonly order: OrderSpec<T> | undefined;
  readonly limit: number | undefined;
}

/**
 * Build a `Query<T>` from a context + frozen state. Every modifier
 * returns a NEW `Query<T>` carrying merged state — the input state
 * is never mutated. Identity inequality with the input chain is
 * intentional.
 *
 * @example
 * ```ts
 * const q = makeQuery<Ticket>(ctx, { predicate: undefined, order: undefined, limit: undefined });
 * const open = await q.where({ status: "open" }).order({ created_at: "desc" }).limit(10).all();
 * ```
 *
 * @internal
 */
export const makeQuery = <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
): Query<T> => {
  const frozen: QueryState<T> = Object.freeze({ ...state });
  return {
    where: (p) =>
      makeQuery<T>(ctx, {
        ...frozen,
        predicate: frozen.predicate === undefined ? p : mergePredicates<T>(frozen.predicate, p),
      }),
    order: (s) => makeQuery<T>(ctx, { ...frozen, order: s }),
    limit: (n) => makeQuery<T>(ctx, { ...frozen, limit: n }),
    first: async () => {
      const rows = await runRead<T>(ctx, { ...frozen, limit: 1 });
      return rows[0]; // undefined when rows.length === 0
    },
    all: () => runRead<T>(ctx, frozen),
    count: async () => (await runRead<T>(ctx, frozen)).length,
    update: () => {
      throw new MPS3Error(
        "Internal",
        "Query.update is not implemented in ticket 09 (read-only). Mutations land in ticket 10.",
      );
    },
    replace: () => {
      throw new MPS3Error(
        "Internal",
        "Query.replace is not implemented in ticket 09 (read-only). Mutations land in ticket 10.",
      );
    },
    delete: () => {
      throw new MPS3Error(
        "Internal",
        "Query.delete is not implemented in ticket 09 (read-only). Mutations land in ticket 10.",
      );
    },
  };
};

/**
 * Load `current.json` fresh, walk `[0, next_seq)` in parallel, fold
 * per-`doc_id`, then apply predicate / order / limit in memory.
 *
 * Error mapping:
 *   - `current.json` missing → empty result (table not provisioned).
 *   - `current.json` malformed → `InvalidResponse` (from `readCurrentJson`).
 *   - log entry missing in `[0, next_seq)` → `Internal`.
 *   - log entry malformed → `InvalidResponse`.
 */
const runRead = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
): Promise<T[]> => {
  // ── Step 1. Read current.json fresh. ──────────────────────────────
  // Skipping any cache is intentional: per Phase-3 multi-instance
  // rules, each read sees a fresh CAS snapshot. The writer reads
  // current.json fresh on every commit; the reader matches.
  const currentJsonKey = `${ctx.tablePrefix}/current.json`;
  const head = await readCurrentJson(ctx.storage, currentJsonKey);

  // Not-found is "table not yet provisioned" — return empty rather
  // than throw. Mirrors `Storage.get` returning null on miss.
  if (head === null) return [];

  // Phase-5 `head.json.snapshot` pointer is ignored here; the reader
  // walks the log from 0. Once snapshots land, the loop will start
  // from the snapshot's per-doc map and skip entries with
  // `seq < snapshot.seq_end` — no shape change.

  const nextSeq = head.json.next_seq;
  if (nextSeq === 0) return [];

  // ── Step 2. Parallel-fetch every log entry [0, next_seq). ─────────
  const logKeys: string[] = [];
  for (let s = 0; s < nextSeq; s++) {
    logKeys.push(`${ctx.tablePrefix}/log/${s}.json`);
  }
  const entries = await Promise.all(logKeys.map(async (k) => readLogEntry(ctx.storage, k)));

  // ── Step 3. Fold per doc_id. ──────────────────────────────────────
  // I / U: post-image overwrite (today's per-doc-replace model).
  //        `merge(prev, entry.new)` degenerates to overwrite because
  //        `entry.new` is the full post-image; the call is here for
  //        forward compatibility with the Phase-9 partial-patch era.
  // D: tombstone — remove from the map.
  // T / M: ignored (T not yet wired; M is a marker).
  const docs = new Map<string, T>();
  for (const entry of entries) {
    if (entry.collection !== ctx.tableName) continue;
    if (entry.doc_id === undefined) continue;
    switch (entry.op) {
      case "I":
      case "U": {
        if (entry.new === undefined) continue;
        const prev = docs.get(entry.doc_id);
        const next = merge(prev as JSONArraylessObject | undefined, entry.new) as T;
        docs.set(entry.doc_id, next);
        break;
      }
      case "D":
        docs.delete(entry.doc_id);
        break;
      case "T":
      case "M":
        // No-op for this ticket; T/M are forward-compatibility shapes.
        break;
    }
  }

  // ── Step 4. Apply predicate. ──────────────────────────────────────
  let rows = Array.from(docs.values());
  if (state.predicate !== undefined) {
    const p = state.predicate;
    rows = rows.filter((d) => matches(p, d));
  }

  // ── Step 5. Apply order. ──────────────────────────────────────────
  if (state.order !== undefined) {
    rows = sortByOrderSpec(rows, state.order);
  }

  // ── Step 6. Apply limit. ──────────────────────────────────────────
  if (state.limit !== undefined && state.limit < rows.length) {
    rows = rows.slice(0, state.limit);
  }

  return rows;
};

const readLogEntry = async (storage: Storage, key: string): Promise<LogEntry> => {
  const got = await storage.get(key);
  if (got === null) {
    // A missing seq inside `[0, next_seq)` is a protocol invariant
    // violation — mirrors `ServerWriter.#readLogEntry`.
    throw new MPS3Error(
      "Internal",
      `Query.read: missing log entry at ${key}; protocol invariant violation`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(got.body)) as LogEntry;
  } catch (e) {
    throw new MPS3Error("InvalidResponse", `Query.read: malformed log entry at ${key}`, e);
  }
};

/**
 * Stable multi-key sort built from an `OrderSpec`. Keys are taken in
 * the spec's insertion order, which matches the caller's source-order
 * expectation. `Array.prototype.sort` is stable on Node 24+ and Workerd.
 *
 * Top-level fields only (locked at `Predicate<T>`/`OrderSpec<T>`).
 * Values are `JSONArrayless` — string / number / boolean / object —
 * but only the primitive types are sensibly orderable; comparing two
 * objects falls through to "considered equal," which preserves the
 * stable-sort order of the input.
 */
const sortByOrderSpec = <T extends JSONArraylessObject>(rows: T[], spec: OrderSpec<T>): T[] => {
  const entries = Object.entries(spec) as Array<[keyof T, "asc" | "desc"]>;
  return rows.toSorted((a, b) => {
    for (const [field, dir] of entries) {
      const av: T[keyof T] | undefined = a[field];
      const bv: T[keyof T] | undefined = b[field];
      if (av === bv) continue;
      // `undefined` (missing field) sorts low under asc / high under
      // desc — same shape SQL's `NULLS FIRST` gives on asc.
      if (av === undefined) return dir === "desc" ? 1 : -1;
      if (bv === undefined) return dir === "desc" ? -1 : 1;
      // string / number / boolean compare uniformly under `<`. Booleans
      // compare false < true (JS default). Object values fall through
      // as "considered equal" — see JSDoc above.
      if (typeof av === "object" || typeof bv === "object") continue;
      const cmp = av < bv ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
};
