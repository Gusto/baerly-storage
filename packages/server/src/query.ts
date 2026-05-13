/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/db.ts`'s `Table<T>` /
   `Query<T>` declarations); mutation verbs surface and route it by name. */

/**
 * Phase-4 read engine + mutation terminals: `Query<T>` builder, the
 * three read terminals (`first`, `all`, `count`) that fold the log
 * under a fresh `current.json` snapshot, and the four mutation
 * terminals (`insert`, `update`, `replace`, `delete`) that each
 * compile to one or more `ServerWriter.commit()` round-trips.
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
 * Mutation terminals are SINGLE-ATTEMPT per call site. CAS contention
 * retries (up to 8 attempts) live inside `ServerWriter.commit()`; the
 * verbs do NOT add their own retry loop. On retry-budget exhaustion
 * `commit()` throws `BaerlyError{code:"Conflict"}` and the verb
 * surfaces it unchanged — the caller's option is to wrap in
 * `db.transaction(...)` (ticket 11).
 *
 * @see ../../../.claude/research/planning/tickets/09-table-and-query-reads.md
 * @see ../../../.claude/research/planning/tickets/10-query-mutations.md
 */

import {
  type ConsistencyLevel,
  type CurrentJson,
  type CurrentJsonRead,
  type JSONArraylessObject,
  logSeqStartOf,
  MANIFEST_POINTER_EMPTY_SNAPSHOT,
  matches,
  merge,
  mergePredicates,
  type MetricsRecorder,
  validatePredicate,
  BaerlyError,
  type OrderSpec,
  type Predicate,
  type Query,
  readCurrentJson,
  type Storage,
  uuidv7,
} from "@baerly/protocol";
import { loadSnapshotAsMap } from "./compactor.ts";
import type { TxContext } from "./db.ts";
import { encodeIndexValue } from "./indexes.ts";
import { walkLogRange } from "./log-walk.ts";
import { ServerWriter } from "./server-writer.ts";

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
  /**
   * When defined, mutation verbs (`Table.insert`, `Query.update`,
   * `Query.replace`, `Query.delete`) buffer a {@link BufferedMutation}
   * onto `txCtx.mutations` instead of calling `ServerWriter.commit`
   * directly. Reads ignore `txCtx` entirely — they go through
   * `Storage` live, by design (ticket 11 §1, no MVCC). Threaded in
   * by `Db.transaction(...)`; `undefined` outside a transaction.
   *
   * @internal
   */
  readonly txCtx?: TxContext;
  /**
   * Per-(Db × table) single-slot cache the `eventual` read path
   * serves from. Mutated by `runRead` after a successful `strong`
   * read so the next `eventual` call can skip the `readCurrentJson`
   * round-trip and reuse the captured snapshot/log head. Lifetime:
   * the `Db` instance — allocated by {@link Db.table} (and the
   * `Db.transaction` body's scoped context). Two `Table` handles
   * over the same name share one slot.
   *
   * `value === null` means "cache not anchored yet on this isolate";
   * a first-ever `eventual` read falls through to a `strong`-style
   * anchor (the contract is "may be one pointer behind reality,"
   * not "may be empty on cold start"). After at least one read the
   * slot holds the full {@link CurrentJsonRead} the last `strong`
   * call observed, including the etag — the `manifestPointer`
   * surfaced on the read result is recomputed from this slot.
   *
   * @internal
   */
  readonly currentJsonCache: CurrentJsonCacheSlot;
  /**
   * Optional metrics sink threaded from {@link Db}. Forwarded to every
   * {@link ServerWriter} the mutation terminals construct so the
   * writer's existing emissions (`db.write.class_a_ops_per_logical_write`,
   * `db.r2.put.412_total`, `db.r2.put.429_total`, etc.) reach the
   * operator's recorder. `undefined` means "no metrics" — the
   * {@link ServerWriter} defaults to {@link noopMetricsRecorder} on
   * its own, so threading is strictly additive.
   *
   * @internal
   */
  readonly metrics?: MetricsRecorder;
}

/**
 * Mutable single-slot cache shared by `eventual` reads over a
 * `(Db, table)` pair. The cache slot is a tiny object so the
 * `TableReadContext` itself can stay `readonly` while the
 * underlying value is swapped in place.
 *
 * @internal
 */
export interface CurrentJsonCacheSlot {
  /**
   * Last `strong`-read `current.json` head, or `null` when the cache
   * has not been anchored yet on this isolate. `eventual` reads
   * serve from this value; a first-ever `eventual` read on a `null`
   * slot falls through to a `strong`-style anchor (see
   * {@link TableReadContext.currentJsonCache}).
   */
  value: CurrentJsonRead | null;
}

/**
 * What `runRead` hands back: the materialised rows plus the cursor
 * + freshness pair surfaced as `_meta` on read response envelopes
 * (see `contract.ts:HttpOkMeta`). The public `Query<T>` terminals
 * destructure and discard the cursor — only the in-router
 * `*WithMeta` helpers consume it.
 *
 * @internal
 */
export interface ReadResult<T extends JSONArraylessObject> {
  readonly rows: T[];
  readonly manifestPointer: string;
  readonly fresh: boolean;
}

/**
 * Serialise a {@link CurrentJson} head into the wire cursor format
 * `"<snapshot>@<next_seq>"`. `null` snapshots stringify as
 * {@link MANIFEST_POINTER_EMPTY_SNAPSHOT} so the cursor is never the
 * empty string.
 *
 * @internal — exported for `query.test.ts`.
 */
export const serializeManifestPointer = (json: CurrentJson): string =>
  `${json.snapshot ?? MANIFEST_POINTER_EMPTY_SNAPSHOT}@${json.next_seq}`;

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
  /**
   * Read consistency level for the terminal call. `undefined` is
   * treated as `"strong"` by `runRead`. Mutation paths force
   * `strong` internally regardless of this field.
   */
  readonly consistency: ConsistencyLevel | undefined;
  /**
   * Phase-8 index hint. When defined and the predicate matches the
   * shape `{ <indexedField>: <value> }`, the read path walks
   * `<tablePrefix>/index/<useIndex>/<value-b32>/` and issues a
   * content GET per matching key instead of folding the snapshot
   * and log. Mismatched predicate shape falls back to the table
   * scan (best-effort, ticket §3.6). Phase 9 adds an auto-picker.
   *
   * @internal
   */
  readonly useIndex: string | undefined;
}

/**
 * Build a `Query<T>` from a context + frozen state. Every modifier
 * returns a NEW `Query<T>` carrying merged state — the input state
 * is never mutated. Identity inequality with the input chain is
 * intentional.
 *
 * @example
 * ```ts
 * const q = makeQuery<Ticket>(ctx, { predicate: undefined, order: undefined, limit: undefined, consistency: undefined, useIndex: undefined });
 * const open = await q.where({ status: "open" }).order({ created_at: "desc" }).limit(10).all();
 * ```
 *
 * @internal
 */
export const makeQuery = <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
): Query<T> => {
  // Operator-policy boundary is public contract: reject `$`-keys
  // synchronously, here, before any `Query<T>` carries an invalid
  // predicate forward. Covers both entry points — `Table.where(p)`
  // routes through `makeQuery({ predicate: p, ... })`, and
  // `Query.where(p)` routes through the merged result below. Empty
  // / undefined predicates short-circuit inside `validatePredicate`
  // (an `{}` predicate has no keys to walk).
  if (state.predicate !== undefined) validatePredicate<T>(state.predicate);
  const frozen: QueryState<T> = Object.freeze({ ...state });
  return {
    where: (p) => {
      // Validate the incoming fragment before merge so error messages
      // pin the offender to `p`, not the merged whole. `makeQuery`
      // re-validates the result on the next hop — the operator-policy
      // boundary is the public contract surface (ticket 12).
      validatePredicate<T>(p);
      return makeQuery<T>(ctx, {
        ...frozen,
        predicate: frozen.predicate === undefined ? p : mergePredicates<T>(frozen.predicate, p),
      });
    },
    order: (s) => makeQuery<T>(ctx, { ...frozen, order: s }),
    limit: (n) => makeQuery<T>(ctx, { ...frozen, limit: n }),
    consistency: (level) => makeQuery<T>(ctx, { ...frozen, consistency: level }),
    useIndex: (name) => makeQuery<T>(ctx, { ...frozen, useIndex: name }),
    first: async () => {
      const { rows } = await runRead<T>(ctx, { ...frozen, limit: 1 });
      return rows[0]; // undefined when rows.length === 0
    },
    all: async () => (await runRead<T>(ctx, frozen)).rows,
    count: async () => (await runRead<T>(ctx, frozen)).rows.length,
    update: (patch) => runUpdate<T>(ctx, frozen, patch),
    replace: (doc) => runReplace<T>(ctx, frozen, doc),
    delete: () => runDelete<T>(ctx, frozen),
  };
};

/**
 * Server-internal read entry surfacing the manifest-pointer cursor
 * and freshness flag alongside the first matched row. The HTTP
 * router calls this directly so the read-response handler can pack
 * `_meta` onto the envelope; the public `Query<T>.first()` terminal
 * destructures the row out and discards the cursor to keep the
 * locked interface signature.
 *
 * @internal
 */
export const runFirstWithMeta = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
): Promise<{ row: T | undefined; manifestPointer: string; fresh: boolean }> => {
  // Mirror the operator-policy boundary check that `makeQuery` runs
  // for chain-based reads: predicates with `$`-keys throw
  // `InvalidConfig` before any I/O. Routes that bypass `Db.table` /
  // `Query.where` must still surface the same error class.
  if (state.predicate !== undefined) validatePredicate<T>(state.predicate);
  const { rows, manifestPointer, fresh } = await runRead<T>(ctx, { ...state, limit: 1 });
  return { row: rows[0], manifestPointer, fresh };
};

/**
 * Server-internal read entry mirroring `runFirstWithMeta` for the
 * list/predicate route. Returns the materialised rows + cursor +
 * freshness so the HTTP router can pack `_meta` onto the envelope.
 *
 * @internal
 */
export const runAllWithMeta = <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
): Promise<ReadResult<T>> => {
  // See `runFirstWithMeta` — match `makeQuery`'s predicate validation
  // so router calls that skip the chain still surface `InvalidConfig`
  // on `$`-keys.
  if (state.predicate !== undefined) validatePredicate<T>(state.predicate);
  return runRead<T>(ctx, state);
};

// ---------------------------------------------------------------------
// Mutation terminals (ticket 10)
// ---------------------------------------------------------------------

/**
 * Build a fresh `ServerWriter` bound to this table's `current.json`.
 * Construction is zero-I/O (server-writer.ts:160) so we mint one per
 * `commit()` rather than caching on the chain — same writer object
 * shared across N commits would inherit retry-budget state we want
 * fresh per call.
 */
const writerFor = (ctx: TableReadContext): ServerWriter =>
  new ServerWriter({
    storage: ctx.storage,
    currentJsonKey: `${ctx.tablePrefix}/current.json`,
    ...(ctx.metrics !== undefined ? { options: { metrics: ctx.metrics } } : {}),
  });

/**
 * `Table.insert` / `Query.insert` implementation. Mints a UUIDv7 `_id`
 * when the caller omits it (or supplies an empty string); honours a
 * caller-supplied non-empty `_id`. On collision (the materialised
 * collection already carries that `_id`) throws
 * `BaerlyError{code:"Conflict"}` BEFORE issuing the writer round-trip
 * — matches the locked `Table.insert` contract
 * (`packages/protocol/src/db.ts:123–125`).
 *
 * The emitted `LogEntry` has `op:"I"` and `new === patch === {...doc, _id}`
 * (today's per-doc-replace model — `packages/protocol/src/log.ts:67–72`).
 *
 * @throws BaerlyError code="Conflict" — `_id` collision (pre-commit check) or
 *   CAS retry budget exhausted inside `ServerWriter.commit()`.
 * @throws BaerlyError code="SchemaError" — inherited from
 *   `ServerWriter.validateInput`.
 *
 * @internal — exported for `Table.insert` in `./table.ts` to delegate
 *             without duplicating the auto-id / collision-check /
 *             commit pipeline.
 */
export const runInsert = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  doc: Partial<T> & JSONArraylessObject,
): Promise<{ _id: string }> => {
  // Auto-id semantics: caller-supplied non-empty `_id` wins; otherwise
  // mint a UUIDv7. The locked contract
  // (`packages/protocol/src/db.ts:120–122`) names UUIDv7 as the
  // auto-id source.
  const supplied = doc._id;
  const _id = typeof supplied === "string" && supplied.length > 0 ? supplied : uuidv7();
  // The locked input type `Partial<T> & JSONArraylessObject` is an
  // intersection of optional-keyed and required-keyed: at runtime the
  // JSONArraylessObject half is authoritative (Partial widens types
  // but doesn't add `undefined` to the runtime shape). Cast through
  // the runtime-authoritative half.
  const body: JSONArraylessObject = { ...(doc as JSONArraylessObject), _id };

  // Pre-commit `_id`-collision check. Costs one log walk; matches the
  // locked `Table.insert` throws contract
  // (`packages/protocol/src/db.ts:123–125`). Without it a caller-
  // supplied duplicate `_id` would land a second `I` entry that the
  // read fold collapses silently — a contract violation. The CAS
  // retry budget in `ServerWriter` does not surface this case
  // (no `current.json` conflict; both writes succeed at different seqs).
  //
  // Inside a transaction the read sees LIVE state (no MVCC, no read-
  // your-writes); a buffered insert in the same transaction is NOT
  // visible here. The collision check still defends against a doc
  // ALREADY committed to the bucket.
  const existing = await runRead<JSONArraylessObject>(ctx, {
    predicate: { _id } as Predicate<JSONArraylessObject>,
    order: undefined,
    limit: 1,
    // Insert's `_id`-collision check is a mutation precondition;
    // it must always see the latest view. See `runUpdate` for the
    // shared rationale.
    consistency: "strong",
    useIndex: undefined,
  });
  if (existing.rows.length > 0) {
    throw new BaerlyError(
      "Conflict",
      `Query.insert: _id ${JSON.stringify(_id)} already exists in collection ${JSON.stringify(ctx.tableName)}`,
    );
  }

  if (ctx.txCtx !== undefined) {
    assertTxBindMatches(ctx);
    ctx.txCtx.mutations.push({ op: "I", docId: _id, body });
    return { _id };
  }

  // Single-attempt at the verb level; CAS retries are internal to
  // `ServerWriter.commit()`. If `commit` throws `Conflict`, the
  // budget is exhausted and we surface unchanged.
  await writerFor(ctx).commit({
    op: "I",
    collection: ctx.tableName,
    docId: _id,
    body,
  });

  return { _id };
};

/**
 * `Query.update` implementation. Materialises the predicate/order/
 * limit-filtered match set, applies RFC 7386 `merge(prev, patch)`
 * per row, and emits one `op:"U"` `LogEntry` per affected `doc_id`
 * — one `ServerWriter.commit()` round-trip apiece.
 *
 * Atomicity is per row, not across the N-row batch. The locked
 * contract (`packages/protocol/src/db.ts:178–184`) is explicit on
 * this: all-or-nothing across multiple rows is what
 * `db.transaction(...)` (ticket 11) exists to deliver.
 *
 * `replica_identity` defaults to `PATCH_ONLY` for every collection
 * today — emitted `U` entries carry `{ new, patch }` (equal) and
 * neither `old` nor `key_old`. Consumers rebuilding pre-images
 * under `PATCH_ONLY` need to maintain a shadow table — see
 * `packages/protocol/src/log.ts:102–118`.
 *
 * @throws BaerlyError code="Conflict" — any one row's CAS retry budget
 *   exhausted inside `ServerWriter.commit()`. The partial-progress
 *   `modified` count is NOT returned in that case.
 * @throws BaerlyError code="SchemaError" — `merge(prev, patch)` produced
 *   `undefined` (defensive — `Partial<T>` cannot be `null` at the
 *   root in the type system).
 */
const runUpdate = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
  patch: Partial<T>,
): Promise<{ modified: number }> => {
  // Mutations are always strong: the row-cardinality precondition
  // (`replace`'s length !== 1) and per-row CAS would silently
  // misfire on a stale cache. Force the level regardless of the
  // chain's setting.
  const { rows } = await runRead<T>(ctx, { ...state, consistency: "strong" });
  const tx = ctx.txCtx;
  if (tx !== undefined) assertTxBindMatches(ctx);
  let modified = 0;
  for (const doc of rows) {
    const merged = merge(doc as JSONArraylessObject, patch as Partial<JSONArraylessObject>);
    if (merged === undefined) {
      // `merge(target, patch)` returns undefined only when patch is
      // null at the root. `Partial<T>` cannot be `null` at the type
      // level; defensive check for runtime caller misuse via cast.
      throw new BaerlyError(
        "SchemaError",
        `Query.update: merge produced undefined for doc ${JSON.stringify(doc._id)}`,
      );
    }
    if (tx !== undefined) {
      tx.mutations.push({ op: "U", docId: String(doc._id), body: merged });
    } else {
      await writerFor(ctx).commit({
        op: "U",
        collection: ctx.tableName,
        docId: String(doc._id),
        body: merged,
      });
    }
    modified++;
  }
  return { modified };
};

/**
 * `Query.replace` implementation. Strict row-cardinality precondition:
 * zero matches → `Conflict` (with cardinality in message); more than
 * one match → `Conflict` (same shape). Exactly one match: emit a
 * single `op:"U"` `LogEntry` carrying `doc` as the post-image
 * (`new === patch === doc` under today's per-doc-replace model).
 *
 * The matched row's `_id` is preserved on the emitted entry's
 * `doc_id` even if the supplied `doc` carries a different `_id` —
 * preserves doc identity across replaces. The locked contract
 * (`packages/protocol/src/db.ts:187–192`) does not pin this either
 * way; preserving identity is the safe default.
 *
 * @throws BaerlyError code="Conflict" — zero or more than one row
 *   matched (cardinality is named in the message), OR the writer's
 *   CAS retry budget exhausted.
 */
const runReplace = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
  doc: T,
): Promise<void> => {
  // Mutations are always strong: the row-cardinality precondition
  // (`replace`'s length !== 1) and per-row CAS would silently
  // misfire on a stale cache. Force the level regardless of the
  // chain's setting.
  const { rows: found } = await runRead<T>(ctx, { ...state, consistency: "strong" });
  if (found.length !== 1) {
    throw new BaerlyError(
      "Conflict",
      `Query.replace: expected exactly 1 match, got ${found.length}`,
    );
  }
  const existingId = String(found[0]!._id);
  // Force the matched row's `_id` onto the post-image so the doc_id
  // on the emitted entry matches the row we resolved against.
  const body: JSONArraylessObject = { ...(doc as JSONArraylessObject), _id: existingId };
  if (ctx.txCtx !== undefined) {
    assertTxBindMatches(ctx);
    ctx.txCtx.mutations.push({ op: "U", docId: existingId, body });
    return;
  }
  await writerFor(ctx).commit({
    op: "U",
    collection: ctx.tableName,
    docId: existingId,
    body,
  });
};

/**
 * `Query.delete` implementation. Tombstones every matched row with a
 * single `op:"D"` `LogEntry` per `doc_id`. No `body` on `D` ops —
 * `ServerWriter.validateInput` (server-writer.ts:386–396) would
 * reject one — and `replica_identity` defaults to `PATCH_ONLY`, so
 * emitted entries carry neither `new`/`patch` nor `old`/`key_old`.
 * Consumers rebuilding pre-images under `PATCH_ONLY` need to
 * maintain a shadow table — see `packages/protocol/src/log.ts:102–118`.
 *
 * Atomicity is per row, not across the N-row batch — same shape as
 * `Query.update`. `db.transaction(...)` (ticket 11) is where
 * all-or-nothing semantics will live.
 *
 * @throws BaerlyError code="Conflict" — any one row's CAS retry budget
 *   exhausted. The partial-progress `deleted` count is NOT returned
 *   in that case.
 */
const runDelete = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
): Promise<{ deleted: number }> => {
  // Mutations are always strong: the row-cardinality precondition
  // (`replace`'s length !== 1) and per-row CAS would silently
  // misfire on a stale cache. Force the level regardless of the
  // chain's setting.
  const { rows } = await runRead<T>(ctx, { ...state, consistency: "strong" });
  const tx = ctx.txCtx;
  if (tx !== undefined) assertTxBindMatches(ctx);
  let deleted = 0;
  for (const doc of rows) {
    if (tx !== undefined) {
      tx.mutations.push({ op: "D", docId: String(doc._id) });
    } else {
      await writerFor(ctx).commit({
        op: "D",
        collection: ctx.tableName,
        docId: String(doc._id),
      });
    }
    deleted++;
  }
  return { deleted };
};

/**
 * Runtime guard for the txCtx-Table-name binding. The type system
 * already prevents the legitimate path (the body callback gets one
 * `Table<T>`, no `Db`), so this only catches a bug where a stale
 * `Query<T>` outlives its `Table<T>` and is somehow re-attached to a
 * transaction over a different table. Documented in ticket 11 §6.1.
 *
 * @throws BaerlyError code="Internal" — txCtx ↔ Table name mismatch.
 */
const assertTxBindMatches = (ctx: TableReadContext): void => {
  if (ctx.txCtx === undefined) return;
  if (ctx.txCtx.table !== ctx.tableName) {
    throw new BaerlyError(
      "Internal",
      `Transaction context bound to ${JSON.stringify(ctx.txCtx.table)} but mutation issued on table ${JSON.stringify(ctx.tableName)}`,
    );
  }
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
): Promise<ReadResult<T>> => {
  // ── Step 1. Read current.json (strong: fresh; eventual: cached). ──
  // `strong` mirrors Phase-3 multi-instance rules: every read sees
  // a fresh CAS snapshot, matching the writer's per-commit GET.
  // `eventual` skips the GET and serves the view this isolate
  // observed when it last advanced (the cache slot, anchored by
  // the previous strong read). First-ever eventual on a cold cache
  // falls through to a strong-style anchor — the contract is "may
  // be one pointer behind reality," not "may be empty on cold
  // start." So the first read MUST anchor.
  const currentJsonKey = `${ctx.tablePrefix}/current.json`;
  const level: ConsistencyLevel = state.consistency ?? "strong";
  let head: CurrentJsonRead | null;
  if (level === "strong" || ctx.currentJsonCache.value === null) {
    head = await readCurrentJson(ctx.storage, currentJsonKey);
    ctx.currentJsonCache.value = head;
  } else {
    head = ctx.currentJsonCache.value;
  }

  // Capture the wire cursor before the rest of the fold runs. A
  // not-found head ("table not yet provisioned") still emits a
  // well-defined cursor so the wire shape never carries `""`.
  const manifestPointer =
    head === null ? `${MANIFEST_POINTER_EMPTY_SNAPSHOT}@0` : serializeManifestPointer(head.json);
  // `fresh` is "this call asked for strong" — an eventual read that
  // anchored on cold start is still semantically eventual from the
  // caller's perspective.
  const fresh = level === "strong";

  // Not-found is "table not yet provisioned" — return empty rather
  // than throw. Mirrors `Storage.get` returning null on miss.
  if (head === null) return { rows: [], manifestPointer, fresh };

  // ── Phase-8: optional index-walk fast path. ─────────────────────
  // When the caller opted in via `.useIndex(name)` and the predicate
  // matches one of the shapes the encoder can satisfy on a single-
  // field index (one top-level field = one literal value), walk the
  // index prefix instead of folding the snapshot + log. The fast
  // path:
  //   1. List `<tablePrefix>/index/<name>/<value-b32>/`.
  //   2. Extract `_id` from each key.
  //   3. Resolve each id via a tail walk over `(snapshot, log)` —
  //      cheap because we fetch only the matching rows.
  //   4. Re-apply the predicate in memory (defends against a
  //      logically-stale index entry).
  //   5. Apply order / limit.
  //
  // Mismatched predicate shape (multi-field, no predicate, etc.)
  // falls through to the table-scan path below. This is best-effort
  // per ticket §3.6: stale entries are dropped silently.
  if (state.useIndex !== undefined && state.predicate !== undefined) {
    const fastRows = await tryIndexWalk<T>(ctx, head.json, state);
    if (fastRows !== undefined) {
      let rows = fastRows;
      if (state.order !== undefined) rows = sortByOrderSpec(rows, state.order);
      if (state.limit !== undefined && state.limit < rows.length) {
        rows = rows.slice(0, state.limit);
      }
      return { rows, manifestPointer, fresh };
    }
  }

  // Load the snapshot, if any. The compactor (ticket 14) guarantees:
  // `snapshot !== null` iff `log_seq_start > 0`. The snapshot is
  // sealed by its filename hash; `loadSnapshotAsMap` recomputes on
  // load and throws `Internal` on mismatch. Entries with
  // `seq < log_seq_start` have been folded into the snapshot (or
  // dropped on truncation) and MUST NOT be GET-required here — the
  // bucket may have already swept them (ticket 15).
  const nextSeq = head.json.next_seq;
  const logSeqStart = logSeqStartOf(head.json);
  const baseDocs: Map<string, JSONArraylessObject> =
    head.json.snapshot === null
      ? new Map()
      : await loadSnapshotAsMap(ctx.storage, head.json.snapshot, ctx.tableName);

  // ── Step 2. Bounded parallel-fetch of [log_seq_start, next_seq). ──
  const entries = await walkLogRange(ctx.storage, ctx.tablePrefix, logSeqStart, nextSeq);

  // ── Step 3. Fold per doc_id, seeded from the snapshot. ────────────
  // I / U: post-image overwrite (today's per-doc-replace model). The
  //        writer emits `entry.new` as the FULL post-image
  //        (`packages/protocol/src/log.ts:67–72`: `new === patch`),
  //        so the fold is a straight `set`, not a `merge`. Phase-9's
  //        partial-merge writer will introduce `entry.patch !== entry.new`
  //        — at that point the fold switches to `merge(prev, entry.patch)`
  //        for `patch` entries while keeping the straight `set` for
  //        full-post-image entries. Crucially, RFC-7386 deletions
  //        (a `null` value in `Query.update`'s patch) are encoded
  //        TODAY as "the post-image omits the key" — `merge(prev, post)`
  //        would carry the dropped key forward; a straight `set` lets
  //        the deletion land.
  // D: tombstone — remove from the map.
  // T / M: ignored (T not yet wired; M is a marker).
  const docs = new Map<string, T>(baseDocs as Map<string, T>);
  for (const entry of entries) {
    if (entry.collection !== ctx.tableName) continue;
    if (entry.doc_id === undefined) continue;
    switch (entry.op) {
      case "I":
      case "U": {
        if (entry.new === undefined) continue;
        docs.set(entry.doc_id, entry.new as T);
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

  return { rows, manifestPointer, fresh };
};

/**
 * Phase-8 — index-walk fast path. Returns `undefined` when the
 * caller's predicate shape doesn't match a single-field index lookup
 * the encoder can satisfy; the outer `runRead` falls back to the
 * table-scan path in that case.
 *
 * Matching shape today:
 *
 *   - The predicate has EXACTLY one top-level key (`Object.keys(p)
 *     .length === 1`).
 *   - That key's value is a JSON-stringifiable primitive — anything
 *     `encodeIndexValue` accepts. A nested-object equality would be
 *     accepted by the encoder but is unlikely to round-trip through
 *     the writer's projection unless the doc was indexed on the
 *     same nested shape; we accept and rely on the post-predicate
 *     re-check to drop spurious rows.
 *
 * Stale-row defence:
 *   - An index entry pointing at a `<docId>.json` whose content
 *     body returns null (404) — peer GC race or a writer that
 *     CAS-lost — is silently dropped.
 *   - A row that is fetched but no longer matches the predicate
 *     (the indexed field was updated since the index entry landed)
 *     is dropped by the in-memory re-check.
 *
 * @internal
 */
const tryIndexWalk = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  head: CurrentJson,
  state: QueryState<T>,
): Promise<T[] | undefined> => {
  const name = state.useIndex;
  const predicate = state.predicate;
  if (name === undefined || predicate === undefined) return undefined;
  // Capture the one-key shape. `Object.keys(predicate).length === 1`
  // is the load-bearing check; multi-field predicates fall through
  // until composite-index reads ship.
  const keys = Object.keys(predicate);
  if (keys.length !== 1) return undefined;
  const field = keys[0]!;
  const value = (predicate as Record<string, unknown>)[field];
  // Strip undefined explicitly so the encoder's `null|undefined →
  // "0"` collapse doesn't accidentally match every null-valued
  // entry (which the writer's projector skipped on insert).
  if (value === undefined) return undefined;
  const prefix = `${ctx.tablePrefix}/index/${name}/${encodeIndexValue(value)}/`;

  // 1. List index entries; extract docId from each key.
  const docIds: string[] = [];
  for await (const entry of ctx.storage.list(prefix)) {
    // Key shape: `<prefix><docId>.json`.
    const tail = entry.key.slice(prefix.length);
    if (!tail.endsWith(".json")) continue;
    docIds.push(tail.slice(0, -".json".length));
  }
  if (docIds.length === 0) {
    // Empty index — return an empty result rather than falling back
    // to a scan. A caller that opted in to `.useIndex` has accepted
    // the best-effort contract; an empty walk is a legitimate "no
    // matches" answer.
    return [];
  }

  // 2. Resolve each docId by folding `(snapshot, log)` for ONLY the
  //    matching rows. Same fold the table-scan path uses, scoped to
  //    one Set<docId>.
  const matched = new Set(docIds);
  const baseDocs: Map<string, JSONArraylessObject> =
    head.snapshot === null
      ? new Map()
      : await loadSnapshotAsMap(ctx.storage, head.snapshot, ctx.tableName);
  const docs = new Map<string, T>();
  for (const id of matched) {
    const seeded = baseDocs.get(id);
    if (seeded !== undefined) docs.set(id, seeded as T);
  }
  const logSeqStart = logSeqStartOf(head);
  const nextSeq = head.next_seq;
  const entries = await walkLogRange(ctx.storage, ctx.tablePrefix, logSeqStart, nextSeq);
  for (const entry of entries) {
    if (entry.collection !== ctx.tableName) continue;
    if (entry.doc_id === undefined || !matched.has(entry.doc_id)) continue;
    if ((entry.op === "I" || entry.op === "U") && entry.new !== undefined) {
      docs.set(entry.doc_id, entry.new as T);
    } else if (entry.op === "D") {
      docs.delete(entry.doc_id);
    }
  }

  // 3. Re-apply the predicate in memory to drop logically-stale rows
  //    (e.g. the index entry's underlying doc has since been updated
  //    to a different field value but the rebuild hasn't run).
  const rows: T[] = [];
  for (const doc of docs.values()) {
    if (matches(predicate, doc)) rows.push(doc);
  }
  return rows;
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
