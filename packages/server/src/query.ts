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
 * `commit()` throws `MPS3Error{code:"Conflict"}` and the verb
 * surfaces it unchanged — the caller's option is to wrap in
 * `db.transaction(...)` (ticket 11).
 *
 * @see ../../../.claude/research/planning/tickets/09-table-and-query-reads.md
 * @see ../../../.claude/research/planning/tickets/10-query-mutations.md
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
  uuidv7,
} from "@baerly/protocol";
import type { TxContext } from "./db";
import { ServerWriter } from "./server-writer";

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
    update: (patch) => runUpdate<T>(ctx, frozen, patch),
    replace: (doc) => runReplace<T>(ctx, frozen, doc),
    delete: () => runDelete<T>(ctx, frozen),
  };
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
  new ServerWriter({ storage: ctx.storage, currentJsonKey: `${ctx.tablePrefix}/current.json` });

/**
 * `Table.insert` / `Query.insert` implementation. Mints a UUIDv7 `_id`
 * when the caller omits it (or supplies an empty string); honours a
 * caller-supplied non-empty `_id`. On collision (the materialised
 * collection already carries that `_id`) throws
 * `MPS3Error{code:"Conflict"}` BEFORE issuing the writer round-trip
 * — matches the locked `Table.insert` contract
 * (`packages/protocol/src/db.ts:123–125`).
 *
 * The emitted `LogEntry` has `op:"I"` and `new === patch === {...doc, _id}`
 * (today's per-doc-replace model — `packages/protocol/src/log.ts:67–72`).
 *
 * @throws MPS3Error code="Conflict" — `_id` collision (pre-commit check) or
 *   CAS retry budget exhausted inside `ServerWriter.commit()`.
 * @throws MPS3Error code="SchemaError" — inherited from
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
  });
  if (existing.length > 0) {
    throw new MPS3Error(
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
 * @throws MPS3Error code="Conflict" — any one row's CAS retry budget
 *   exhausted inside `ServerWriter.commit()`. The partial-progress
 *   `modified` count is NOT returned in that case.
 * @throws MPS3Error code="SchemaError" — `merge(prev, patch)` produced
 *   `undefined` (defensive — `Partial<T>` cannot be `null` at the
 *   root in the type system).
 */
const runUpdate = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
  patch: Partial<T>,
): Promise<{ modified: number }> => {
  const rows = await runRead<T>(ctx, state);
  const tx = ctx.txCtx;
  if (tx !== undefined) assertTxBindMatches(ctx);
  let modified = 0;
  for (const doc of rows) {
    const merged = merge(doc as JSONArraylessObject, patch as Partial<JSONArraylessObject>);
    if (merged === undefined) {
      // `merge(target, patch)` returns undefined only when patch is
      // null at the root. `Partial<T>` cannot be `null` at the type
      // level; defensive check for runtime caller misuse via cast.
      throw new MPS3Error(
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
 * @throws MPS3Error code="Conflict" — zero or more than one row
 *   matched (cardinality is named in the message), OR the writer's
 *   CAS retry budget exhausted.
 */
const runReplace = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
  doc: T,
): Promise<void> => {
  const found = await runRead<T>(ctx, state);
  if (found.length !== 1) {
    throw new MPS3Error("Conflict", `Query.replace: expected exactly 1 match, got ${found.length}`);
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
 * @throws MPS3Error code="Conflict" — any one row's CAS retry budget
 *   exhausted. The partial-progress `deleted` count is NOT returned
 *   in that case.
 */
const runDelete = async <T extends JSONArraylessObject>(
  ctx: TableReadContext,
  state: QueryState<T>,
): Promise<{ deleted: number }> => {
  const rows = await runRead<T>(ctx, state);
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
 * @throws MPS3Error code="Internal" — txCtx ↔ Table name mismatch.
 */
const assertTxBindMatches = (ctx: TableReadContext): void => {
  if (ctx.txCtx === undefined) return;
  if (ctx.txCtx.table !== ctx.tableName) {
    throw new MPS3Error(
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
  const docs = new Map<string, T>();
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
