/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/db.ts`'s `Table<T>` /
   `Query<T>` declarations); mutation verbs surface and route it by name. */

/**
 * Read engine + mutation terminals: `Query<T>` builder, the
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
 * `.where()` AND-merges through `mergePredicates`.
 * `.order()` and `.limit()` are last-call-wins (state replace).
 *
 * Each terminal reads `current.json` FRESH and walks `[0, next_seq)`
 * directly — no cache, no `list()` round-trip. Per the multi-
 * instance rules, every read sees a fresh CAS snapshot.
 *
 * Mutation terminals are SINGLE-ATTEMPT per call site. CAS contention
 * retries (up to 8 attempts) live inside `ServerWriter.commit()`; the
 * verbs do NOT add their own retry loop. On retry-budget exhaustion
 * `commit()` throws `BaerlyError{code:"Conflict"}` and the verb
 * surfaces it unchanged — the caller's option is to wrap in
 * `db.transaction(...)`.
 *
 * @see ../../../docs/spec/sync-protocol.md
 */

import {
  type ConsistencyLevel,
  type CurrentJson,
  type CurrentJsonRead,
  type JSONArrayless,
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
import { encodeIndexValue, type IndexDefinition } from "./indexes.ts";
import { walkLogRange } from "./log-walk.ts";
import { type IndexWalkPlan, planQuery, type QueryPlan } from "./query-planner.ts";
import { type SchemaValidator, validateOrThrow } from "./schema.ts";
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
   * `Storage` live, by design (no MVCC; see `Db.transaction`'s JSDoc
   * in `./db.ts`). Threaded in by `Db.transaction(...)`; `undefined`
   * outside a transaction.
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
  /**
   * Optional StandardSchemaV1-shaped validator for this collection.
   * When set, `runInsert`, `runUpdate`, and `runReplace` validate the
   * post-image before committing or buffering — invalid input throws
   * `BaerlyError{code:"SchemaError"}` carrying a `.issues` array of
   * `{ path, message }` entries. `undefined` means no validation
   * (today's behaviour — zero overhead).
   *
   * Threaded in by {@link Db.tableReadContext} from the per-collection
   * map handed to {@link Db.create}; the boundary calls happen in
   * `query.ts`, not `server-writer.ts`, so schemas plug in higher than
   * `ServerWriter.validateInput`'s structural checks.
   *
   * @internal
   */
  readonly schema?: SchemaValidator;
  /**
   * Per-collection {@link IndexDefinition}s threaded onto every
   * read. Consumed by `planQuery(...)` inside `runRead` to pick an
   * index-walk plan when the predicate's equality fields cover a
   * declared index's `on` tuple left-to-right. Empty array means
   * "no indexes declared" — every read falls through to the
   * snapshot + log fold path.
   *
   * Mirrors the shape callers build when flattening
   * `BaerlyConfig.collections[*].indexes` into a map keyed by name
   * before constructing the `Db`; we keep the `Db` itself library-
   * agnostic by accepting the pre-flattened map (not the full
   * `BaerlyConfig`).
   *
   * @internal
   */
  readonly indexes: ReadonlyArray<IndexDefinition>;
  /**
   * Per-call `$in` fan-out threshold, threaded from {@link Db.create}.
   * `undefined` means "use the planner default"
   * ({@link IN_FANOUT_THRESHOLD}). Consumed by `planQuery(...)` inside
   * `runRead` — see {@link PlanQueryOptions.inFanoutThreshold}.
   *
   * @internal
   */
  readonly inFanoutThreshold?: number;
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
}

/**
 * Build a `Query<T>` from a context + frozen state. Every modifier
 * returns a NEW `Query<T>` carrying merged state — the input state
 * is never mutated. Identity inequality with the input chain is
 * intentional.
 *
 * @example
 * ```ts
 * const q = makeQuery<Ticket>(ctx, { predicate: undefined, order: undefined, limit: undefined, consistency: undefined });
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
  if (state.predicate !== undefined) {
    validatePredicate<T>(state.predicate);
  }
  const frozen: QueryState<T> = Object.freeze({ ...state });
  return {
    where: (p) => {
      // Validate the incoming fragment before merge so error messages
      // pin the offender to `p`, not the merged whole. `makeQuery`
      // re-validates the result on the next hop — the operator-policy
      // boundary is the public contract surface.
      validatePredicate<T>(p);
      return makeQuery<T>(ctx, {
        ...frozen,
        predicate: frozen.predicate === undefined ? p : mergePredicates<T>(frozen.predicate, p),
      });
    },
    order: (s) => makeQuery<T>(ctx, { ...frozen, order: s }),
    limit: (n) => makeQuery<T>(ctx, { ...frozen, limit: n }),
    consistency: (level) => makeQuery<T>(ctx, { ...frozen, consistency: level }),
    first: async () => {
      const { rows } = await runRead<T>(ctx, { ...frozen, limit: 1 });
      return rows[0]; // undefined when rows.length === 0
    },
    all: async () => {
      const res = await runRead<T>(ctx, frozen);
      return res.rows;
    },
    count: async () => {
      const res = await runRead<T>(ctx, frozen);
      return res.rows.length;
    },
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
  if (state.predicate !== undefined) {
    validatePredicate<T>(state.predicate);
  }
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
  if (state.predicate !== undefined) {
    validatePredicate<T>(state.predicate);
  }
  return runRead<T>(ctx, state);
};

// ---------------------------------------------------------------------
// Mutation terminals
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
    options: {
      ...(ctx.metrics !== undefined ? { metrics: ctx.metrics } : {}),
      indexes: ctx.indexes,
    },
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
  const supplied = doc["_id"];
  const _id = typeof supplied === "string" && supplied.length > 0 ? supplied : uuidv7();
  // The locked input type `Partial<T> & JSONArraylessObject` is an
  // intersection of optional-keyed and required-keyed: at runtime the
  // JSONArraylessObject half is authoritative (Partial widens types
  // but doesn't add `undefined` to the runtime shape). Cast through
  // the runtime-authoritative half.
  const body: JSONArraylessObject = { ...(doc as JSONArraylessObject), _id };

  // Schema validation against the post-image. Runs BEFORE the
  // pre-commit collision check and before the writer round-trip so
  // a malformed doc never reaches the wire. Inside a transaction it
  // also runs before `txCtx.mutations.push` — a `SchemaError` thrown
  // here aborts the body, dropping every buffered mutation, before
  // the commit fires.
  if (ctx.schema !== undefined) {
    await validateOrThrow(ctx.schema, body, {
      collection: ctx.tableName,
      verb: "insert",
    });
  }

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
 * `db.transaction(...)` exists to deliver.
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
  if (tx !== undefined) {
    assertTxBindMatches(ctx);
  }
  let modified = 0;
  for (const doc of rows) {
    const merged = merge(doc as JSONArraylessObject, patch as Partial<JSONArraylessObject>);
    if (merged === undefined) {
      // `merge(target, patch)` returns undefined only when patch is
      // null at the root. `Partial<T>` cannot be `null` at the type
      // level; defensive check for runtime caller misuse via cast.
      throw new BaerlyError(
        "SchemaError",
        `Query.update: merge produced undefined for doc ${JSON.stringify(doc["_id"])}`,
      );
    }
    // Validate the merged post-image, not the incoming patch.
    // Patches are partial by design — validating the patch itself
    // would reject valid updates against schemas that require fields
    // the patch doesn't touch. The post-image is what the schema
    // actually models. Atomicity stays per-row: a violation on row
    // N aborts the batch without rolling back rows 0..N-1.
    if (ctx.schema !== undefined) {
      await validateOrThrow(ctx.schema, merged, {
        collection: ctx.tableName,
        verb: "update",
      });
    }
    if (tx !== undefined) {
      tx.mutations.push({ op: "U", docId: String(doc["_id"]), body: merged });
    } else {
      await writerFor(ctx).commit({
        op: "U",
        collection: ctx.tableName,
        docId: String(doc["_id"]),
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
  const existingId = String(found[0]!["_id"]);
  // Force the matched row's `_id` onto the post-image so the doc_id
  // on the emitted entry matches the row we resolved against.
  const body: JSONArraylessObject = { ...(doc as JSONArraylessObject), _id: existingId };
  // Schema validation runs against the post-image — same shape as
  // `runInsert`. Buffers in a transaction only after validation
  // passes; an invalid replace inside a tx aborts the body and
  // drops every previously-buffered mutation.
  if (ctx.schema !== undefined) {
    await validateOrThrow(ctx.schema, body, {
      collection: ctx.tableName,
      verb: "replace",
    });
  }
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
 * `Query.update`. `db.transaction(...)` is where all-or-nothing
 * semantics live.
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
  if (tx !== undefined) {
    assertTxBindMatches(ctx);
  }
  let deleted = 0;
  for (const doc of rows) {
    if (tx !== undefined) {
      tx.mutations.push({ op: "D", docId: String(doc["_id"]) });
    } else {
      await writerFor(ctx).commit({
        op: "D",
        collection: ctx.tableName,
        docId: String(doc["_id"]),
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
 * transaction over a different table.
 *
 * @throws BaerlyError code="Internal" — txCtx ↔ Table name mismatch.
 */
const assertTxBindMatches = (ctx: TableReadContext): void => {
  if (ctx.txCtx === undefined) {
    return;
  }
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
  // `strong` mirrors the multi-instance rules: every read sees
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
  if (head === null) {
    return { rows: [], manifestPointer, fresh };
  }

  // ── Optional index-walk fast path. ──────────────────────────────
  // `planQuery` is a pure function over `(predicate, indexes)`. It
  // picks the longest-prefix-matching index from the collection's
  // declared indexes and emits a `FullScanPlan` when nothing
  // matches. We route on `plan.kind`; the in-memory `matches(...)`
  // re-check on every fetched doc defends against stale index
  // entries AND consumes the planner's residue (operator clauses,
  // unrelated equality on non-indexed fields).
  const plan: QueryPlan = planQuery(
    state.predicate,
    ctx.indexes,
    ctx.inFanoutThreshold !== undefined ? { inFanoutThreshold: ctx.inFanoutThreshold } : undefined,
  );
  if (plan.kind === "index-walk") {
    let rows = await runIndexWalkPlan<T>(ctx, head.json, state, plan);
    if (state.order !== undefined) {
      rows = sortByOrderSpec(rows, state.order);
    }
    if (state.limit !== undefined && state.limit < rows.length) {
      rows = rows.slice(0, state.limit);
    }
    return { rows, manifestPointer, fresh };
  }
  // plan.kind === "full-scan" — fall through to the snapshot+log fold.

  // Load the snapshot, if any. `compact()` guarantees:
  // `snapshot !== null` iff `log_seq_start > 0`. The snapshot is
  // sealed by its filename hash; `loadSnapshotAsMap` recomputes on
  // load and throws `Internal` on mismatch. Entries with
  // `seq < log_seq_start` have been folded into the snapshot (or
  // dropped on truncation) and MUST NOT be GET-required here — the
  // bucket may have already swept them via `runGc()`.
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
  //        so the fold is a straight `set`, not a `merge`. A future
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
    if (entry.collection !== ctx.tableName) {
      continue;
    }
    if (entry.doc_id === undefined) {
      continue;
    }
    switch (entry.op) {
      case "I":
      case "U": {
        if (entry.new === undefined) {
          continue;
        }
        docs.set(entry.doc_id, entry.new as T);
        break;
      }
      case "D": {
        docs.delete(entry.doc_id);
        break;
      }
      case "T":
      case "M": {
        // No-op for this ticket; T/M are forward-compatibility shapes.
        break;
      }
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
 * Range-walk exclusive-lower sentinel. `Storage.list({startAfter})`
 * is strict-greater; to position the cursor PAST every entry whose
 * value-segment equals `ENCODE(lo)`, append a character that
 * lex-sorts strictly greater than every base-32 character (the
 * encoder alphabet is `[0-9a-v]`, topping out at `v` = 0x76) AND
 * strictly greater than the path separator `/` (0x2F).
 *
 * `~` (0x7E) satisfies both. The cursor `${eqPrefix}${ENCODE(lo)}/~`
 * lex-sorts strictly greater than the LARGEST possible key under
 * the `lo` value bucket but strictly less than the smallest key
 * under any bucket with a larger value-segment. The next LIST
 * result is the first entry with value-segment strictly greater
 * than `ENCODE(lo)` — exactly the exclusive-lower semantics we
 * want.
 */
const RANGE_EXCLUSIVE_LOWER_SENTINEL = "~";

/**
 * Bounded parallelism for `$in` multi-walk LISTs. Each batch of this
 * many `$in` values dispatches its `list()` calls concurrently; the
 * loop waits on the batch before starting the next.
 *
 * Picked low (8) to stay well under any cloud-provider per-call concurrency
 * ceiling while still amortising LIST round-trip latency on multi-value
 * `$in` queries. The planner's `IN_FANOUT_THRESHOLD` (50) caps the total
 * fan-out independently — see `packages/server/src/query-planner.ts`.
 */
const IN_FANOUT_PARALLELISM = 8;

/**
 * Execute an {@link IndexWalkPlan} against the bucket. Returns the
 * post-filtered, fully-resolved row set. The full original
 * `state.predicate` is re-applied via `matches(...)` after fetching
 * rows — this defends against stale index entries AND consumes the
 * planner's residue (operator clauses, unrelated equality on
 * non-indexed fields) in one place.
 *
 * Storage shape (equality-only walks):
 *   - Single-field walk (`equalityKeys.length === 1`): list
 *     `<tablePrefix>/index/<name>/<v0-b32>/`; each yielded key has
 *     tail `<docId>.json` (single segment).
 *   - Composite full walk (`equalityKeys.length === def.on.length`):
 *     list `<tablePrefix>/index/<name>/<v0-b32>/<v1-b32>/.../<vN-b32>/`;
 *     each yielded key has tail `<docId>.json` (single segment).
 *   - Composite partial-prefix walk (`equalityKeys.length <
 *     def.on.length`): list `<tablePrefix>/index/<name>/<v0-b32>/
 *     .../<vM-b32>/`; each yielded key has tail
 *     `<v{M+1}-b32>/.../<vN-b32>/<docId>.json` — MULTI-segment.
 *     Split on `/` and take the last segment.
 *
 * Storage shape (T3, range / `$in` walks):
 *   - Range walk (`plan.rangeOn !== undefined`): list
 *     `<tablePrefix>/index/<name>/<eq-segs>/` and break on the
 *     first decoded value-segment past the upper bound. Lower
 *     bound is enforced via `startAfter` (exclusive lower) or an
 *     in-loop skip (inclusive lower) — see
 *     {@link RANGE_EXCLUSIVE_LOWER_SENTINEL}.
 *   - `$in` walk (`plan.inOn !== undefined`): one LIST per value,
 *     with the equality prefix prepended to each, dispatched in
 *     batches of {@link IN_FANOUT_PARALLELISM} `Promise.all`-style.
 *     Doc-ids accumulate into a single Set (union semantics).
 *
 * Stale-row defence:
 *   - An index entry pointing at a docId whose underlying doc has
 *     since been updated to a different value (rebuild hasn't run)
 *     is dropped by the in-memory `matches(...)` re-check.
 *   - An index entry pointing at a docId whose underlying doc has
 *     been deleted (tombstone in the log) is dropped during the
 *     fold (the `D` op removes it from the materialised set).
 *
 * @internal
 */
const runIndexWalkPlan = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  head: CurrentJson,
  state: QueryState<T>,
  plan: IndexWalkPlan,
): Promise<T[]> => {
  const encodedSegments = plan.equalityKeys.map((v) => encodeIndexValue(v));
  const eqPrefix =
    encodedSegments.length === 0
      ? `${ctx.tablePrefix}/index/${plan.indexName}/`
      : `${ctx.tablePrefix}/index/${plan.indexName}/${encodedSegments.join("/")}/`;

  // 1. List index entries; extract docId from the LAST segment of
  //    each key's tail. Multi-segment tails appear under composite
  //    partial-prefix walks; single-segment tails appear under
  //    single-field walks and composite full walks.
  const docIdSet = new Set<string>();

  if (plan.rangeOn !== undefined) {
    // Range-LIST under the equality prefix. The value-segment sits
    // immediately after `eqPrefix`; we lex-compare it against the
    // encoded bounds. Lex comparison is sound because
    // `encodeIndexValue` is value-order-preserving for every
    // supported type — numbers via the sortable IEEE 754 payload,
    // strings via UTF-8 byte order, all framed under the type-tag
    // prefix that keeps types disjoint.
    const r = plan.rangeOn;
    const loEncoded = r.lo === undefined ? undefined : encodeIndexValue(r.lo);
    const hiEncoded = r.hi === undefined ? undefined : encodeIndexValue(r.hi);
    // Exclusive lower → position the cursor past all entries
    // whose value-segment equals `ENCODE(r.lo)` via the sentinel.
    // Inclusive lower → no startAfter; in-loop skip filters values
    // strictly less than `ENCODE(r.lo)` (no-op for the bucket
    // matching `ENCODE(r.lo)` itself).
    const startAfter =
      r.lo !== undefined && !r.loInclusive
        ? `${eqPrefix}${loEncoded}/${RANGE_EXCLUSIVE_LOWER_SENTINEL}`
        : undefined;
    const listOpts = startAfter === undefined ? {} : { startAfter };
    for await (const entry of ctx.storage.list(eqPrefix, listOpts)) {
      const tail = entry.key.slice(eqPrefix.length);
      const firstSlash = tail.indexOf("/");
      if (firstSlash < 0) {
        continue;
      } // defensive: malformed key
      const valueSeg = tail.slice(0, firstSlash);
      // Inclusive-lower in-loop skip (couldn't push to startAfter).
      if (loEncoded !== undefined && valueSeg < loEncoded) {
        continue;
      }
      // Upper-bound break — lex-ascending enumeration, so once we
      // pass the upper bound we're done.
      if (hiEncoded !== undefined) {
        if (r.hiInclusive ? valueSeg > hiEncoded : valueSeg >= hiEncoded) {
          break;
        }
      }
      // Decode the doc-id from the LAST `/`-separated segment of
      // the tail. Single-field walk → tail is `<valueSeg>/<docId>.json`
      // and the LAST segment is `<docId>.json`. Composite walk with
      // tail extension → tail is `<valueSeg>/...moreSegs/<docId>.json`
      // and the LAST segment is still `<docId>.json`.
      const lastSlash = tail.lastIndexOf("/");
      const last =
        lastSlash === firstSlash ? tail.slice(firstSlash + 1) : tail.slice(lastSlash + 1);
      if (!last.endsWith(".json")) {
        continue;
      }
      const docId = last.slice(0, -".json".length);
      if (docId.length === 0) {
        continue;
      }
      docIdSet.add(docId);
    }
  } else if (plan.inOn !== undefined) {
    // `$in` multi-walk: dispatch up to IN_FANOUT_PARALLELISM `list()` calls
    // in parallel per batch. Union of doc-ids across all values; per-value
    // walks are independent so batching is sound. The planner has already
    // vetted the total fan-out (≤ IN_FANOUT_THRESHOLD); the encoder is
    // value-order-preserving across every supported type, so numeric
    // members route the same as strings.
    //
    // Cancellation note: `Promise.all` rejects on the first rejection but
    // does NOT cancel the other in-flight `list()` calls — the `Storage`
    // contract doesn't promise mid-stream cancellation. Storage errors
    // are rare; tightening this is out of scope.
    const values = plan.inOn.values;
    const walkOne = async (value: JSONArrayless): Promise<string[]> => {
      const valPrefix = `${eqPrefix}${encodeIndexValue(value)}/`;
      const ids: string[] = [];
      for await (const entry of ctx.storage.list(valPrefix)) {
        const tail = entry.key.slice(valPrefix.length);
        if (!tail.endsWith(".json")) {
          continue;
        }
        const lastSlash = tail.lastIndexOf("/");
        const docId =
          lastSlash === -1
            ? tail.slice(0, -".json".length)
            : tail.slice(lastSlash + 1, -".json".length);
        if (docId.length === 0) {
          continue;
        }
        ids.push(docId);
      }
      return ids;
    };
    for (let i = 0; i < values.length; i += IN_FANOUT_PARALLELISM) {
      const batch = values.slice(i, i + IN_FANOUT_PARALLELISM);
      const results = await Promise.all(batch.map(walkOne));
      for (const ids of results) {
        for (const id of ids) {
          docIdSet.add(id);
        }
      }
    }
  } else {
    // Equality-only walk (T2 path).
    for await (const entry of ctx.storage.list(eqPrefix)) {
      const tail = entry.key.slice(eqPrefix.length);
      if (!tail.endsWith(".json")) {
        continue;
      }
      const lastSlash = tail.lastIndexOf("/");
      const docId =
        lastSlash === -1
          ? tail.slice(0, -".json".length)
          : tail.slice(lastSlash + 1, -".json".length);
      if (docId.length === 0) {
        continue;
      }
      docIdSet.add(docId);
    }
  }
  const docIds = Array.from(docIdSet);
  if (docIds.length === 0) {
    return [];
  }

  // 2. Resolve each docId by folding `(snapshot, log)` scoped to the
  //    matched set. Same fold the table-scan path uses, scoped to
  //    one Set<docId>.
  const matched = new Set(docIds);
  const baseDocs: Map<string, JSONArraylessObject> =
    head.snapshot === null
      ? new Map()
      : await loadSnapshotAsMap(ctx.storage, head.snapshot, ctx.tableName);
  const docs = new Map<string, T>();
  for (const id of matched) {
    const seeded = baseDocs.get(id);
    if (seeded !== undefined) {
      docs.set(id, seeded as T);
    }
  }
  const logSeqStart = logSeqStartOf(head);
  const nextSeq = head.next_seq;
  const entries = await walkLogRange(ctx.storage, ctx.tablePrefix, logSeqStart, nextSeq);
  for (const entry of entries) {
    if (entry.collection !== ctx.tableName) {
      continue;
    }
    if (entry.doc_id === undefined || !matched.has(entry.doc_id)) {
      continue;
    }
    if ((entry.op === "I" || entry.op === "U") && entry.new !== undefined) {
      docs.set(entry.doc_id, entry.new as T);
    } else if (entry.op === "D") {
      docs.delete(entry.doc_id);
    }
  }

  // 3. Apply the FULL original predicate as the stale-row defence,
  //    then the planner's residue postFilter on top. `matches` is
  //    open-world, so applying the full original predicate (which
  //    the planner partly consumed) is the simpler invariant: if
  //    the doc still passes the original predicate, it stays.
  //    Operator clauses that landed in `plan.postFilter` are part
  //    of `state.predicate` — they pass through here automatically.
  const rows: T[] = [];
  const predicate = state.predicate;
  for (const doc of docs.values()) {
    if (predicate === undefined || matches(predicate, doc)) {
      rows.push(doc);
    }
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
