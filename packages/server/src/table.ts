/**
 * `Table<T>` factory. `Db.table(name)` returns
 * the result of `makeTable(ctx)` — a cheap, no-I/O handle that
 * delegates every modifier to `makeQuery` with a fresh empty seed
 * state, and routes `insert` through the shared `runInsert` runtime
 * that `Query.update` / `replace` / `delete` reuse pieces of.
 *
 * `Table.insert(doc)` is the public insert path. The locked
 * `Query<T>` interface (`@baerly/protocol/src/table-api.ts`) intentionally
 * does NOT declare `insert` — chainable inserts are out of scope.
 * For an inserted doc whose predicate-bound shape matters,
 * `db.table(...).insert(...)` is the path; predicates are a read-
 * side concern.
 */

import {
  type ConsistencyLevel,
  type DocumentData,
  type OrderSpec,
  type PredicateWire,
  type Table,
} from "@baerly/protocol";
import { makeQuery, runInsert, type TableReadContext } from "./query.ts";

/**
 * Build a `Table<T>` bound to one `(tenant, table)` read context.
 * Cheap: zero I/O, allocates one closure. Each modifier call returns
 * a FRESH `Query<T>` — calling `.where(p1)` and `.where(p2)` on the
 * same `Table<T>` produces two independent chains.
 *
 * `.count()` shorthand defers to the empty-state `Query<T>.count()`
 * so the fold logic lives in one place.
 *
 * @example
 * ```ts
 * const table = makeTable<Ticket>({
 *   storage,
 *   tablePrefix: "app/tickets/tenant/acme/manifests/tickets",
 *   tableName: "tickets",
 * });
 * const open = await table.where({ status: "open" }).all();
 * ```
 *
 * @internal
 */
export const makeTable = <T extends DocumentData>(ctx: TableReadContext): Table<T> => {
  // Empty seed state. Every modifier merges into a frozen copy.
  const seed = {
    wire: undefined as PredicateWire | undefined,
    order: undefined as OrderSpec<T> | undefined,
    limit: undefined as number | undefined,
    consistency: undefined as ConsistencyLevel | undefined,
  };
  // Kernel-internal `_id`-shaped wire. Bypasses `validateWire`
  // (which rejects top-level `_id`) by construction — the wire is
  // never wire-submitted; it short-circuits to `Map.get` via
  // `singleIdFromPredicate` inside `runRead`.
  const byId = (id: string) => ({
    ...seed,
    wire: { clauses: [{ op: "eq" as const, field: "_id", value: id }] } as PredicateWire,
  });
  return {
    name: ctx.tableName,
    first: () => makeQuery<T>(ctx, seed).first(),
    all: () => makeQuery<T>(ctx, seed).all(),
    count: () => makeQuery<T>(ctx, seed).count(),
    get: (id) => makeQuery<T>(ctx, byId(id)).first(),
    where: (p) => makeQuery<T>(ctx, seed).where(p),
    order: (s) => makeQuery<T>(ctx, { ...seed, order: s }),
    limit: (n) => makeQuery<T>(ctx, { ...seed, limit: n }),
    consistency: (level) => makeQuery<T>(ctx, { ...seed, consistency: level }),
    /**
     * Insert one document. UUIDv7 auto-id when `_id` is absent or
     * empty; otherwise the caller-supplied `_id` is honoured. A
     * pre-commit existence check against the materialised collection
     * surfaces `Conflict` on duplicate `_id` without round-tripping
     * to the writer — matches the locked `Table.insert` throws
     * contract (`@baerly/protocol/src/table-api.ts`).
     *
     * Single-attempt per call: CAS retries (up to 8 attempts) live
     * inside `Writer.commit()`. On retry-budget exhaustion the
     * writer throws `Conflict` and we surface unchanged.
     *
     * @throws BaerlyError code="Conflict" — `_id` collision (pre-commit
     *   check) or CAS retry budget exhausted.
     * @throws BaerlyError code="SchemaError" — from the per-collection
     *   `SchemaValidator` threaded via {@link Db.tableReadContext}.
     */
    insert: (doc) => runInsert<T>(ctx, doc),
    update: (id, patch) => makeQuery<T>(ctx, byId(id)).update(patch),
    replace: (id, doc) => makeQuery<T>(ctx, byId(id)).replace(doc),
    delete: (id) => makeQuery<T>(ctx, byId(id)).delete(),
  };
};
