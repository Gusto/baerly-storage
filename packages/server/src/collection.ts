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
import { assertReadDocId } from "./doc-id.ts";
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
    /**
     * Read the row at `id`. `id` is checked by the stored-id rule (not the
     * NFC write rule) before any I/O, so a row an earlier release stored
     * under a non-NFC id stays readable.
     *
     * @throws BaerlyError code="InvalidConfig" — `id` breaks the key-segment
     *   rule; no row can be stored under it. Nothing was read.
     */
    get: async (id) => {
      assertReadDocId(id);
      return await makeQuery<T>(ctx, byId(id)).first();
    },
    where: (p) => makeQuery<T>(ctx, seed).where(p),
    order: (s) => makeQuery<T>(ctx, { ...seed, order: s }),
    limit: (n) => makeQuery<T>(ctx, { ...seed, limit: n }),
    /**
     * Insert one document. UUIDv7 auto-id when `_id` is absent,
     * `undefined` or `""`; otherwise the caller-supplied `_id` is honoured. The first
     * insert of an `_id` wins: a pre-commit existence check surfaces
     * `AlreadyExists` for a row already committed, and the writer's insert
     * guard surfaces it for one a concurrent insert committed after that
     * check — matches the locked `Collection.insert` throws contract
     * (`@baerly/protocol/src/collection-api.ts`).
     *
     * Single-attempt per call: log-create contention is resolved inside
     * `Writer.commit()`, and its errors surface unchanged.
     *
     * @throws BaerlyError code="AlreadyExists" — a live row holds `_id`,
     *   committed before or concurrently with this call; of concurrent
     *   inserts of one `_id`, at most one commits. Nothing was committed.
     *   Not retriable.
     * @throws BaerlyError code="WriteConflict" — a rejected storage precondition
     *   the writer does not resolve; the write was not committed. The writer
     *   makes one attempt (log-create races are resolved inside it), so
     *   re-run the call to retry. Retriable.
     * @throws BaerlyError code="AmbiguousCommit" — a committing create may be
     *   durable, but its outcome could not be resolved, so the row may or may
     *   not have been inserted. Re-read by a stable `_id`; absence is not proof
     *   of failure. Not retriable-by-default; see `Writer.commit`.
     * @throws BaerlyError code="SchemaError" — from the per-collection
     *   `SchemaValidator` threaded via {@link Db.collectionReadContext}.
     * @throws BaerlyError code="InvalidConfig" — the supplied `_id` is not a
     *   string (`null` included), or breaks the key-segment rule or is not
     *   NFC. Nothing was written.
     */
    insert: (doc) => runInsert<T>(ctx, doc),
    /**
     * Update the row at `id` by JSON-merge-patch. Forwards to the
     * predicate-form `runUpdate` through a `byId` wire, so at most one row
     * is matched. A write to the row that commits after the read is not
     * lost: the patch is re-applied to it, and a row deleted there is left
     * deleted with `modified: 0` (see `runUpdate`).
     *
     * @throws BaerlyError code="WriteConflict" — a rejected storage precondition
     *   the writer does not resolve, or log retention retired part of the
     *   commit window; the write was not committed. The writer makes one
     *   attempt (log-create races are resolved inside it), so re-run the
     *   call to retry. Retriable.
     * @throws BaerlyError code="AmbiguousCommit" — a committing create may be
     *   durable, but its outcome could not be resolved, so the update may or
     *   may not have been applied. Re-read by `id`; absence is not proof of
     *   failure. Not retriable-by-default; see `Writer.commit`.
     * @throws BaerlyError code="SchemaError" — merged post-image rejected by the
     *   collection's bound validator, or `merge(prev, patch)` produced
     *   `undefined`.
     * @throws BaerlyError code="InvalidConfig" — the patch's top-level `_id`
     *   is present and is not `id` (`null` included), or `id` is not NFC.
     * @throws BaerlyError code="InvalidResponse" — the stored row's `_id` is
     *   not the string `id`; repair it with `replace(id, doc)`.
     */
    update: (id, patch) => makeQuery<T>(ctx, byId(id)).update(patch),
    /**
     * Replace the row at `id` wholesale, preserving doc identity. Last
     * writer wins against a concurrent update; a concurrent delete is not
     * undone (see `runReplaceById`).
     *
     * @throws BaerlyError code="NotFound" — no row exists at `id`, including
     *   one a concurrent delete removed after the read.
     * @throws BaerlyError code="WriteConflict" — a rejected storage precondition
     *   the writer does not resolve; the write was not committed. The writer
     *   makes one attempt (log-create races are resolved inside it), so
     *   re-run the call to retry. Retriable.
     * @throws BaerlyError code="AmbiguousCommit" — a committing create may be
     *   durable, but its outcome could not be resolved, so the replace may or
     *   may not have been applied. Re-read by `id`; absence is not proof of
     *   failure. Not retriable-by-default; see `Writer.commit`.
     * @throws BaerlyError code="SchemaError" — post-image rejected by the
     *   collection's bound validator.
     * @throws BaerlyError code="InvalidConfig" — `id` breaks the key-segment
     *   rule or is not NFC. Nothing was written.
     */
    replace: (id, doc) => runReplaceById<T>(ctx, id, doc),
    /**
     * Tombstone the row at `id`. Forwards to the predicate-form `runDelete`
     * through a `byId` wire, so at most one row is matched. A missing row is
     * not an error — `deleted` is `0`. `id` need not be NFC, so a row an
     * earlier release stored under a non-NFC id stays deletable. A row a
     * concurrent delete removed after the read is not deleted again (nor a
     * re-insert of its `_id`): `deleted` is `0` (see `runDelete`).
     *
     * @throws BaerlyError code="WriteConflict" — a rejected storage precondition
     *   the writer does not resolve; the write was not committed. The writer
     *   makes one attempt (log-create races are resolved inside it), so
     *   re-run the call to retry. Retriable.
     * @throws BaerlyError code="AmbiguousCommit" — a committing create may be
     *   durable, but its outcome could not be resolved, so the tombstone may or
     *   may not have been applied. Re-read by `id`; absence is not proof of
     *   failure. Not retriable-by-default; see `Writer.commit`.
     * @throws BaerlyError code="InvalidResponse" — the stored row's `_id` is
     *   not the string `id`; repair it with `replace(id, doc)`.
     */
    delete: (id) => makeQuery<T>(ctx, byId(id)).delete(),
  };
};
