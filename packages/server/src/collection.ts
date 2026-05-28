/**
 * `Collection<T>` factory. `Db.collection(name)` returns the result of
 * `makeCollection(ctx)` — a cheap, no-I/O handle. By-id mutations route
 * through dedicated runners: `insert` → `runInsert`,
 * `replace(id, doc)` → `runReplaceById`. `update(id, patch)` and
 * `delete(id)` forward to the predicate-form runners via a `byId`
 * wire — those Query verbs are genuinely bulk, so the by-id case is
 * just a one-row predicate.
 *
 * `Collection.insert(doc)` is the public insert path. The locked
 * `Query<T>` interface (`@baerly/protocol/src/collection-api.ts`) intentionally
 * does NOT declare `insert` — chainable inserts are out of scope.
 * For an inserted doc whose predicate-bound shape matters,
 * `db.collection(...).insert(...)` is the path; predicates are a read-
 * side concern.
 */

import {
  type Collection,
  type DocumentData,
  type OrderSpec,
  type PredicateWire,
} from "@baerly/protocol";
import { makeQuery, runInsert, runReplaceById, type CollectionReadContext } from "./query.ts";

/**
 * Build a `Collection<T>` bound to one `(tenant, collection)` read context.
 * Cheap: zero I/O, allocates one closure. Each modifier call returns
 * a FRESH `Query<T>` — calling `.where(p1)` and `.where(p2)` on the
 * same `Collection<T>` produces two independent chains.
 *
 * `.count()` shorthand defers to the empty-state `Query<T>.count()`
 * so the fold logic lives in one place.
 *
 * @example
 * ```ts
 * const collection = makeCollection<Ticket>({
 *   storage,
 *   collectionPrefix: "app/tickets/tenant/acme/manifests/tickets",
 *   collectionName: "tickets",
 * });
 * const open = await collection.where({ status: "open" }).all();
 * ```
 *
 * @internal
 */
export const makeCollection = <T extends DocumentData>(
  ctx: CollectionReadContext,
): Collection<T> => {
  // Empty seed state. Every modifier merges into a frozen copy.
  const seed = {
    wire: undefined as PredicateWire | undefined,
    order: undefined as OrderSpec<T> | undefined,
    limit: undefined as number | undefined,
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
    name: ctx.collectionName,
    first: () => makeQuery<T>(ctx, seed).first(),
    all: () => makeQuery<T>(ctx, seed).all(),
    count: () => makeQuery<T>(ctx, seed).count(),
    get: (id) => makeQuery<T>(ctx, byId(id)).first(),
    where: (p) => makeQuery<T>(ctx, seed).where(p),
    order: (s) => makeQuery<T>(ctx, { ...seed, order: s }),
    limit: (n) => makeQuery<T>(ctx, { ...seed, limit: n }),
    /**
     * Insert one document. UUIDv7 auto-id when `_id` is absent or
     * empty; otherwise the caller-supplied `_id` is honoured. A
     * pre-commit existence check against the materialised collection
     * surfaces `Conflict` on duplicate `_id` without round-tripping
     * to the writer — matches the locked `Collection.insert` throws
     * contract (`@baerly/protocol/src/collection-api.ts`).
     *
     * Single-attempt per call: CAS retries (up to 8 attempts) live
     * inside `Writer.commit()`. On retry-budget exhaustion the
     * writer throws `Conflict` and we surface unchanged.
     *
     * @throws BaerlyError code="Conflict" — `_id` collision (pre-commit
     *   check) or CAS retry budget exhausted.
     * @throws BaerlyError code="SchemaError" — from the per-collection
     *   `SchemaValidator` threaded via {@link Db.collectionReadContext}.
     */
    insert: (doc) => runInsert<T>(ctx, doc),
    update: (id, patch) => makeQuery<T>(ctx, byId(id)).update(patch),
    replace: (id, doc) => runReplaceById<T>(ctx, id, doc),
    delete: (id) => makeQuery<T>(ctx, byId(id)).delete(),
  };
};
