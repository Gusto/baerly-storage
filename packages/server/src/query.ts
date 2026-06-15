/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/collection-api.ts`'s `Collection<T>` /
   `Query<T>` declarations); mutation verbs surface and route it by name. */

/**
 * Read engine + mutation terminals: `Query<T>` builder, the
 * three read terminals (`first`, `all`, `count`) that fold the log
 * under a fresh `current.json` snapshot, and the four mutation
 * terminals (`insert`, `update`, `replace`, `delete`). Each mutation
 * verb compiles to exactly one `Writer.commit()` call.
 *
 * Every modifier (`.where` / `.order` / `.limit`) returns a NEW
 * `Query<T>` carrying merged frozen state — the input state is never
 * mutated. Identity inequality between the original and the returned
 * builder is intentional: callers cannot share a chain.
 *
 * `.where()` AND-merges through `mergePredicateWires` (clause-level
 * AND on the normalised wire form).
 * `.order()` and `.limit()` are last-call-wins (state replace).
 *
 * Each terminal reads `current.json` FRESH, loads the snapshot it names,
 * and walks `[log_seq_start, tail_hint)` directly — no cache, no
 * `list()` round-trip for the log. Per the multi-instance rules, every
 * read sees a fresh CAS snapshot.
 *
 * Mutation terminals are SINGLE-ATTEMPT per call site. CAS contention
 * retries (up to 8 attempts) live inside `Writer.commit()`; the
 * verbs do NOT add their own retry loop. On retry-budget exhaustion
 * `commit()` throws `BaerlyError{code:"Conflict"}` and the verb
 * surfaces it unchanged — the caller decides whether to re-run.
 *
 * @see ../../../docs/spec/sync-protocol.md
 */

import {
  type CurrentJson,
  type DocumentValue,
  type DocumentData,
  logSeqStartOf,
  MANIFEST_POINTER_EMPTY_SNAPSHOT,
  matchesWire,
  merge,
  mergePredicateWires,
  normalizePredicateArg,
  validateWire,
  BaerlyError,
  type OrderSpec,
  type PredicateWire,
  type Query,
  readCurrentJson,
  type Storage,
  uuidv7,
} from "@baerly/protocol";
import { loadSnapshotAsMap } from "./snapshot.ts";
import { assertDocId } from "./doc-id.ts";
import { encodeIndexValue, type IndexDefinition } from "./indexes.ts";
import { foldLogEntriesOnto, walkLogRange } from "./log-walk.ts";
import { probeTailFrom } from "./log-tail.ts";
import { type IndexWalkPlan, planQuery, type QueryPlan } from "./query-planner.ts";
import { type SchemaValidator, validateOrThrow } from "./schema.ts";
import { Writer } from "./writer.ts";

/**
 * What a `Query<T>` needs to issue a read against the bucket. The
 * `Db` builds this once and hands it to `Collection` / `Query`; the chain
 * carries it forward unchanged.
 *
 * The `collectionPrefix` shape matches what `Writer` writes under —
 * e.g. `"app/<app>/tenant/<tenant>/manifests/<name>"`. Drift between
 * the reader and writer prefix is the most likely bug class; both
 * compose the same string from `app`/`tenant`/`name`.
 *
 * @internal
 */
export interface CollectionReadContext {
  readonly storage: Storage;
  /** Physical key prefix — already includes `app/<app>/tenant/<tenant>/manifests/<name>`. */
  readonly collectionPrefix: string;
  readonly collectionName: string;
  /**
   * Optional StandardSchemaV1-shaped validator for this collection.
   * When set, `runInsert`, `runUpdate`, and `runReplaceById` validate the
   * post-image before committing — invalid input throws
   * `BaerlyError{code:"SchemaError"}` carrying a `.issues` array of
   * `{ path, message }` entries. `undefined` means no validation
   * (today's behaviour — zero overhead).
   *
   * Threaded in by {@link Db.collectionReadContext} from the per-collection
   * map handed to {@link Db.create}; the boundary calls happen in
   * `query.ts`, not `writer.ts`, so schemas plug in at the
   * read/write API surface rather than at the writer layer.
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
export interface ReadResult<T extends DocumentData> {
  readonly rows: T[];
  readonly manifestPointer: string;
  readonly fresh: boolean;
}

/**
 * Serialise a {@link CurrentJson} head into the wire cursor
 * `"<snapshot>@<tail>"`. `tail` is the DISCOVERED tail (defaults to
 * `json.tail_hint` when no probe has run). `null` snapshots stringify
 * as {@link MANIFEST_POINTER_EMPTY_SNAPSHOT}.
 *
 * @internal — exported for `query.test.ts`.
 */
export const serializeManifestPointer = (json: CurrentJson, tail = json.tail_hint): string =>
  `${json.snapshot ?? MANIFEST_POINTER_EMPTY_SNAPSHOT}@${tail}`;

/**
 * Frozen state carried along a `Query<T>` chain. Every modifier
 * produces a fresh `QueryState<T>` via spread + `Object.freeze`; the
 * wire / order / limit fields are never mutated in place.
 *
 * The chain carries the normalised wire form ({@link PredicateWire})
 * — the public seam (`.where(p)` accepting `PredicateArg<T>`) routes
 * incoming object-form / callback-form predicates through
 * `normalizePredicateArg` before they reach this state, so every
 * downstream consumer (planner, executor, post-filter) reads the
 * same shape.
 *
 * @internal
 */
export interface QueryState<T extends DocumentData> {
  readonly wire: PredicateWire | undefined;
  readonly order: OrderSpec<T> | undefined;
  readonly limit: number | undefined;
}

/**
 * Returns the id iff `wire` carries exactly one clause and that
 * clause is `{op:"eq", field:"_id", value:<string>}` — the shape
 * `runRead` short-circuits to a single `Map.get`. Any other shape
 * (multi-clause, non-`eq` op, non-`_id` field, non-string value)
 * returns `undefined` and falls through to the scan path.
 *
 * Kernel-internal `_id`-shaped wires (built by `byId`,
 * `runByIdWithMeta`, `runInsert`) bypass the wire validator by
 * design (`_id` at the root is a wire-only rejection); this
 * recogniser matches the same shape so the fast-path stays
 * symmetric.
 *
 * @internal
 */
export const singleIdFromPredicate = (wire: PredicateWire | undefined): string | undefined => {
  if (wire === undefined) {
    return undefined;
  }
  if (wire.clauses.length !== 1) {
    return undefined;
  }
  const clause = wire.clauses[0]!;
  if (clause.op !== "eq" || clause.field !== "_id") {
    return undefined;
  }
  return typeof clause.value === "string" ? clause.value : undefined;
};

/**
 * Build a `Query<T>` from a context + frozen state. Every modifier
 * returns a NEW `Query<T>` carrying merged state — the input state
 * is never mutated. Identity inequality with the input chain is
 * intentional.
 *
 * Validation happens at the public seams — `Query.where(p)`
 * normalises + validates the incoming fragment before merging into
 * `state.wire`. By the time `makeQuery` is reached from elsewhere
 * (`Collection.where`, `runAllWithMeta`, kernel-internal `_id`-shaped
 * wires from `byId` / `runByIdWithMeta` / `runInsert`), the wire is
 * already trusted.
 *
 * @example
 * ```ts
 * const q = makeQuery<Ticket>(ctx, { wire: undefined, order: undefined, limit: undefined });
 * const open = await q.where({ status: "open" }).order({ created_at: "desc" }).limit(10).all();
 * ```
 *
 * @internal
 */
export const makeQuery = <T extends DocumentData>(
  ctx: CollectionReadContext,
  state: QueryState<T>,
): Query<T> => {
  // Every modifier below produces a fresh spread; identity inequality
  // with `state` is intentional and load-bearing. A shallow `Object.freeze`
  // would only protect the top-level object (the chain never mutates it
  // anyway) and not nested wire / order objects — pure ceremony.
  return {
    where: (p) => {
      // Normalise + validate the incoming fragment before merge so
      // error messages pin the offender to `p`, not the merged whole.
      // The validator is the wire-arrival contract surface; running
      // it once per fragment is sufficient because `mergePredicateWires`
      // preserves the per-clause shape that `validateWire` already
      // approved.
      const incoming = normalizePredicateArg<T>(p);
      validateWire(incoming);
      return makeQuery<T>(ctx, {
        ...state,
        wire: state.wire === undefined ? incoming : mergePredicateWires(state.wire, incoming),
      });
    },
    order: (s) => makeQuery<T>(ctx, { ...state, order: s }),
    limit: (n) => makeQuery<T>(ctx, { ...state, limit: n }),
    first: async () => {
      const { rows } = await runRead<T>(ctx, { ...state, limit: 1 });
      return rows[0]; // undefined when rows.length === 0
    },
    all: async () => {
      const res = await runRead<T>(ctx, state);
      return res.rows;
    },
    count: async () => {
      const res = await runRead<T>(ctx, state);
      return res.rows.length;
    },
    update: (patch) => runUpdate<T>(ctx, state, patch),
    delete: () => runDelete<T>(ctx, state),
  };
};

/**
 * Server-internal read entry surfacing the manifest-pointer cursor
 * and freshness flag alongside the materialised rows. The HTTP
 * router calls this directly so the read-response handler can pack
 * `_meta` onto the envelope; the public `Query<T>` terminals
 * destructure the rows out and discard the cursor to keep the
 * locked interface signature. Single-row routes (`GET /v1/c/:collection/:id`)
 * call this with `limit:1` and pick `rows[0]`.
 *
 * `state.wire` is assumed already validated — the public seam
 * (`Query.where(p)` → `normalizePredicateArg` → `validateWire`) is
 * the wire-arrival contract surface. Router callers parsing
 * `?where=` run `validateWire` themselves inside `parseWhereParam`,
 * keeping a single validation pass per wire.
 *
 * @internal
 */
export const runAllWithMeta = <T extends DocumentData>(
  ctx: CollectionReadContext,
  state: QueryState<T>,
): Promise<ReadResult<T>> => {
  return runRead<T>(ctx, state);
};

/**
 * By-id read entry surfacing the same `ReadResult<T>` shape as
 * {@link runAllWithMeta} so the HTTP router can preserve the
 * `_meta` wire envelope while routing through the PK-lookup
 * fast-path. Mirrors {@link runAllWithMeta}'s signature; the
 * wire is built internally as a single-clause `{op:"eq",
 * field:"_id", value:id}` shape (same form as the `byId` helper in
 * `./collection.ts` and the `runInsert` duplicate-collision check)
 * which routes through `runRead`'s `singleIdFromPredicate`
 * short-circuit automatically.
 *
 * Bypasses {@link validateWire} — the wire is kernel-constructed,
 * never wire-submitted, so it would always pass the structural
 * rules. Skipping the validator also keeps this helper usable
 * from kernel-internal sites (`Collection<T>.get` etc.) without
 * tripping the wire-only rule that bans top-level `_id`.
 *
 * @internal — router uses this to preserve `_meta` envelope;
 *   mirrors {@link runAllWithMeta} and {@link Collection.get}.
 */
export const runByIdWithMeta = <T extends DocumentData>(
  ctx: CollectionReadContext,
  id: string,
): Promise<ReadResult<T>> => {
  return runRead<T>(ctx, {
    wire: { clauses: [{ op: "eq", field: "_id", value: id }] },
    order: undefined,
    limit: 1,
  });
};

// ---------------------------------------------------------------------
// Mutation terminals
// ---------------------------------------------------------------------

/**
 * Build a fresh `Writer` bound to this collection's `current.json`.
 * Construction is zero-I/O (writer.ts:160) so we mint one per
 * `commit()` rather than caching on the chain — same writer object
 * shared across N commits would inherit retry-budget state we want
 * fresh per call.
 */
const writerFor = (ctx: CollectionReadContext): Writer =>
  new Writer({
    storage: ctx.storage,
    currentJsonKey: `${ctx.collectionPrefix}/current.json`,
    options: {
      indexes: ctx.indexes,
    },
  });

/**
 * `Collection.insert` / `Query.insert` implementation. Mints a UUIDv7 `_id`
 * when the caller omits it (or supplies an empty string); honours a
 * caller-supplied non-empty `_id`. On collision (the materialised
 * collection already carries that `_id`) throws
 * `BaerlyError{code:"Conflict"}` BEFORE issuing the writer round-trip
 * — matches the locked `Collection.insert` contract
 * (`packages/protocol/src/collection-api.ts:123–125`).
 *
 * The emitted `LogEntry` has `op:"I"` and `after === {...doc, _id}`
 * (today's per-doc-replace model).
 *
 * @throws BaerlyError code="Conflict" — `_id` collision (pre-commit check) or
 *   CAS retry budget exhausted inside `Writer.commit()`.
 * @throws BaerlyError code="SchemaError" — from the per-collection
 *   `SchemaValidator` threaded via {@link Db.collectionReadContext}.
 *
 * @internal — exported for `Collection.insert` in `./collection.ts` to delegate
 *             without duplicating the auto-id / collision-check /
 *             commit pipeline.
 */
export const runInsert = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  doc: Partial<T> & DocumentData,
): Promise<{ _id: string }> => {
  // Auto-id semantics: caller-supplied non-empty `_id` wins; otherwise
  // mint a UUIDv7. The locked contract
  // (`packages/protocol/src/collection-api.ts:120–122`) names UUIDv7 as the
  // auto-id source.
  const supplied = doc["_id"];
  const _id = typeof supplied === "string" && supplied.length > 0 ? supplied : uuidv7();
  // Guard the resolved id at the write origin — the only place a
  // user-controlled `_id` enters as a WRITTEN key segment. Minted
  // UUIDv7 always passes, so guarding unconditionally also documents
  // the invariant. The `_id` analogue of `assertKeySegment` (`db.ts`).
  assertDocId(_id);
  // The locked input type `Partial<T> & DocumentData` is an
  // intersection of optional-keyed and required-keyed: at runtime the
  // DocumentData half is authoritative (Partial widens types
  // but doesn't add `undefined` to the runtime shape). Cast through
  // the runtime-authoritative half.
  const body: DocumentData = { ...(doc as DocumentData), _id };

  // Schema validation against the post-image. Runs BEFORE the
  // pre-commit collision check and before the writer round-trip so
  // a malformed doc never reaches the wire.
  if (ctx.schema !== undefined) {
    await validateOrThrow(ctx.schema, body, {
      collection: ctx.collectionName,
      verb: "insert",
    });
  }

  // Pre-commit `_id`-collision check. Costs one log walk; matches the
  // locked `Collection.insert` throws contract
  // (`packages/protocol/src/collection-api.ts:123–125`). Without it a caller-
  // supplied duplicate `_id` would land a second `I` entry that the
  // read fold collapses silently — a contract violation. The CAS
  // retry budget in `Writer` does not surface this case
  // (no `current.json` conflict; both writes succeed at different seqs).
  // The collision check defends against a doc ALREADY committed to
  // the bucket.
  const existing = await runRead<DocumentData>(ctx, {
    wire: { clauses: [{ op: "eq", field: "_id", value: _id }] },
    order: undefined,
    limit: 1,
  });
  if (existing.rows.length > 0) {
    throw new BaerlyError(
      "Conflict",
      `Query.insert: _id ${JSON.stringify(_id)} already exists in collection ${JSON.stringify(ctx.collectionName)}`,
    );
  }

  // Single-attempt at the verb level; CAS retries are internal to
  // `Writer.commit()`. If `commit` throws `Conflict`, the
  // budget is exhausted and we surface unchanged.
  await writerFor(ctx).commit({
    op: "I",
    collection: ctx.collectionName,
    docId: _id,
    body,
  });

  return { _id };
};

/**
 * `Query.update` implementation. Materialises the predicate/order/
 * limit-filtered match set, applies RFC 7386 `merge(prev, patch)`
 * per row, and emits one `op:"U"` `LogEntry` per affected `doc_id`
 * — one `Writer.commit()` round-trip apiece.
 *
 * Atomicity is per row, not across the N-row batch. The locked
 * contract (`packages/protocol/src/collection-api.ts:178–184`) is explicit on
 * this: each affected row commits independently — the document is the
 * atomic unit; there is no multi-row batch.
 *
 * `replica_identity` defaults to `PATCH_ONLY` for every collection
 * today — emitted `U` entries carry `{ after }` (the full post-image)
 * and neither `before` nor `key_old`. Consumers rebuilding pre-images
 * under `PATCH_ONLY` need to maintain a shadow table — see
 * `packages/protocol/src/log.ts:102–118`.
 *
 * @throws BaerlyError code="Conflict" — any one row's CAS retry budget
 *   exhausted inside `Writer.commit()`. The partial-progress
 *   `modified` count is NOT returned in that case.
 * @throws BaerlyError code="SchemaError" — `merge(prev, patch)` produced
 *   `undefined` (defensive — `Partial<T>` cannot be `null` at the
 *   root in the type system).
 */
const runUpdate = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  state: QueryState<T>,
  patch: Partial<T>,
): Promise<{ modified: number }> => {
  const { rows } = await runRead<T>(ctx, state);
  let modified = 0;
  for (const doc of rows) {
    const merged = merge(doc as DocumentData, patch as Partial<DocumentData>);
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
    // N aborts the loop without rolling back rows 0..N-1.
    if (ctx.schema !== undefined) {
      await validateOrThrow(ctx.schema, merged, {
        collection: ctx.collectionName,
        verb: "update",
      });
    }
    await writerFor(ctx).commit({
      op: "U",
      collection: ctx.collectionName,
      docId: String(doc["_id"]),
      body: merged,
    });
    modified++;
  }
  return { modified };
};

/**
 * `Collection.replace` implementation. Existence check via `runRead` over
 * a `byId`-shaped wire so the `singleIdFromPredicate` PK fast path
 * (`Map.get`) fires. Missing row → `NotFound` directly (no Conflict-string
 * indirection through the router). Present row → emit a single
 * `op:"U"` `LogEntry` carrying `doc` as the post-image, with `_id`
 * forced to the requested `id` so doc identity is preserved across
 * replaces even if the supplied `doc._id` differs.
 *
 * @throws BaerlyError code="NotFound" — no row exists at `id`.
 * @throws BaerlyError code="SchemaError" — post-image rejected by
 *   the collection's bound validator.
 * @throws BaerlyError code="Conflict" — writer CAS retry budget
 *   exhausted.
 */
export const runReplaceById = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  id: string,
  doc: T,
): Promise<void> => {
  // Guard the caller-supplied id before it becomes a written key
  // segment (index keys, log `doc_id`). Same boundary as `runInsert`.
  assertDocId(id);
  const wire: PredicateWire = {
    clauses: [{ op: "eq", field: "_id", value: id }],
  };
  const state: QueryState<T> = {
    wire,
    order: undefined,
    limit: undefined,
  };
  const { rows } = await runRead<T>(ctx, state);
  if (rows.length === 0) {
    throw new BaerlyError("NotFound", `No such row: ${id}`);
  }
  const body: DocumentData = { ...(doc as DocumentData), _id: id };
  // Schema validation runs against the post-image — same shape as
  // `runInsert`. An invalid replace throws before the commit fires.
  if (ctx.schema !== undefined) {
    await validateOrThrow(ctx.schema, body, {
      collection: ctx.collectionName,
      verb: "replace",
    });
  }
  await writerFor(ctx).commit({
    op: "U",
    collection: ctx.collectionName,
    docId: id,
    body,
  });
};

/**
 * `Query.delete` implementation. Tombstones every matched row with a
 * single `op:"D"` `LogEntry` per `doc_id`. `replica_identity` defaults
 * to `PATCH_ONLY`, so emitted `D` entries carry no body fields
 * (no `after`, no `before`/`key_old`).
 * Consumers rebuilding pre-images under `PATCH_ONLY` need to
 * maintain a shadow table — see `packages/protocol/src/log.ts:102–118`.
 *
 * Atomicity is per row, not across the N-row batch — same shape as
 * `Query.update`. The document is the atomic unit; there is no
 * multi-row batch.
 *
 * @throws BaerlyError code="Conflict" — any one row's CAS retry budget
 *   exhausted. The partial-progress `deleted` count is NOT returned
 *   in that case.
 */
const runDelete = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  state: QueryState<T>,
): Promise<{ deleted: number }> => {
  const { rows } = await runRead<T>(ctx, state);
  let deleted = 0;
  for (const doc of rows) {
    await writerFor(ctx).commit({
      op: "D",
      collection: ctx.collectionName,
      docId: String(doc["_id"]),
    });
    deleted++;
  }
  return { deleted };
};

/**
 * Load `current.json` fresh, walk `[log_seq_start, tail_hint)` in parallel, fold
 * per-`doc_id`, then apply predicate / order / limit in memory.
 *
 * Error mapping:
 *   - `current.json` missing → empty result (collection not provisioned).
 *   - `current.json` malformed → `InvalidResponse` (from `readCurrentJson`).
 *   - log entry missing in `[log_seq_start, tail_hint)` → `Internal`.
 *   - log entry malformed → `InvalidResponse`.
 */
const runRead = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  state: QueryState<T>,
): Promise<ReadResult<T>> => {
  // ── Step 1. Read current.json. ────────────────────────────────────
  // Every read GETs `current.json` fresh — mirrors the multi-instance
  // rules: every read sees a fresh CAS snapshot, matching the writer's
  // per-commit GET.
  const currentJsonKey = `${ctx.collectionPrefix}/current.json`;
  const head = await readCurrentJson(ctx.storage, currentJsonKey);

  // Every read is strong by construction — `fresh` reflects that.
  const fresh = true;

  // Not-found is "collection not yet provisioned" — return empty rather
  // than throw. Mirrors `Storage.get` returning null on miss. A
  // not-found head still emits a well-defined cursor so the wire shape
  // never carries `""`.
  if (head === null) {
    return { rows: [], manifestPointer: `${MANIFEST_POINTER_EMPTY_SNAPSHOT}@0`, fresh };
  }

  // ── Optional index-walk fast path. ──────────────────────────────
  // `planQuery` is a pure function over `(wire, indexes)`. It picks
  // the longest-prefix-matching index from the collection's declared
  // indexes and emits a `FullScanPlan` when nothing matches. We
  // route on `plan.kind`; the in-memory `matchesWire(...)` re-check
  // on every fetched doc defends against stale index entries AND
  // consumes the planner's residue (range clauses, unrelated
  // equality on non-indexed fields).
  const plan: QueryPlan = planQuery(state.wire, ctx.indexes);
  if (plan.kind === "index-walk") {
    const walk = await runIndexWalkPlan<T>(ctx, head.json, state, plan);
    let rows = walk.rows;
    if (state.order !== undefined) {
      rows = sortByOrderSpec(rows, state.order);
    }
    if (state.limit !== undefined && state.limit < rows.length) {
      rows = rows.slice(0, state.limit);
    }
    return { rows, manifestPointer: serializeManifestPointer(head.json, walk.tail), fresh };
  }
  // plan.kind === "full-scan" — fall through to the snapshot+log fold.

  // Load the snapshot, if any. `compact()` guarantees:
  // `snapshot !== null` iff `log_seq_start > 0`. The snapshot is
  // sealed by its filename hash; `loadSnapshotAsMap` recomputes on
  // load and throws `Internal` on mismatch. Entries with
  // `seq < log_seq_start` have been folded into the snapshot (or
  // dropped on truncation) and MUST NOT be GET-required here — the
  // bucket may have already swept them via `runGc()`.
  const hint = head.json.tail_hint;
  const logSeqStart = logSeqStartOf(head.json);
  const baseDocs: Map<string, DocumentData> =
    head.json.snapshot === null
      ? new Map()
      : await loadSnapshotAsMap(ctx.storage, head.json.snapshot, ctx.collectionName);

  // ── Step 2. Strict walk [log_seq_start, tail_hint) + tolerant ──────
  // forward-probe [tail_hint, tail). Strict range is dense (a hole is
  // corruption → `walkLogRange` THROWS); the probe stops at the first
  // 404 and its entries fold through the SAME path as the strict walk.
  const entries = await walkLogRange(ctx.storage, ctx.collectionPrefix, logSeqStart, hint);
  const probe = await probeTailFrom(ctx.storage, ctx.collectionPrefix, hint);
  const tail = probe.tail;

  // ── Step 3. Fold per doc_id, seeded from the snapshot. ────────────
  // I / U: post-image overwrite. `entry.after` is the full post-image;
  //        a straight `set` is correct (a `merge(prev, post)` would
  //        carry forward keys the writer dropped).
  // D: tombstone — remove from the map.
  const docs = new Map<string, T>(baseDocs as Map<string, T>);
  foldLogEntriesOnto(docs, entries, { collection: ctx.collectionName });
  foldLogEntriesOnto(docs, probe.entries, { collection: ctx.collectionName });

  // ── Step 4. Apply predicate. ──────────────────────────────────────
  // PK fast-path: a single `eq` clause on `_id` short-circuits the
  // O(n) scan with a `Map.get` on the same snapshot — observable
  // contract unchanged.
  const fastId = singleIdFromPredicate(state.wire);
  let rows: T[];
  if (fastId !== undefined) {
    const hit = docs.get(fastId);
    rows = hit === undefined ? [] : [hit];
  } else {
    rows = Array.from(docs.values());
    if (state.wire !== undefined) {
      const w = state.wire;
      rows = rows.filter((d) => matchesWire(w, d));
    }
  }

  // ── Step 5. Apply order. ──────────────────────────────────────────
  if (state.order !== undefined) {
    rows = sortByOrderSpec(rows, state.order);
  }

  // ── Step 6. Apply limit. ──────────────────────────────────────────
  if (state.limit !== undefined && state.limit < rows.length) {
    rows = rows.slice(0, state.limit);
  }

  return { rows, manifestPointer: serializeManifestPointer(head.json, tail), fresh };
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
 * `state.wire` is re-applied via `matchesWire(...)` after fetching
 * rows — this defends against stale index entries AND consumes the
 * planner's residue (range clauses, unrelated equality on
 * non-indexed fields) in one place.
 *
 * Storage shape (equality-only walks):
 *   - Single-field walk (`equalityKeys.length === 1`): list
 *     `<collectionPrefix>/index/<name>/<v0-b32>/`; each yielded key has
 *     tail `<docId>.json` (single segment).
 *   - Composite full walk (`equalityKeys.length === def.on.length`):
 *     list `<collectionPrefix>/index/<name>/<v0-b32>/<v1-b32>/.../<vN-b32>/`;
 *     each yielded key has tail `<docId>.json` (single segment).
 *   - Composite partial-prefix walk (`equalityKeys.length <
 *     def.on.length`): list `<collectionPrefix>/index/<name>/<v0-b32>/
 *     .../<vM-b32>/`; each yielded key has tail
 *     `<v{M+1}-b32>/.../<vN-b32>/<docId>.json` — MULTI-segment.
 *     Split on `/` and take the last segment.
 *
 * Storage shape (T3, range / `$in` walks):
 *   - Range walk (`plan.rangeOn !== undefined`): list
 *     `<collectionPrefix>/index/<name>/<eq-segs>/` and break on the
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
 *     is dropped by the in-memory `matchesWire(...)` re-check.
 *   - An index entry pointing at a docId whose underlying doc has
 *     been deleted (tombstone in the log) is dropped during the
 *     fold (the `D` op removes it from the materialised set).
 *
 * @internal
 */
const runIndexWalkPlan = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  head: CurrentJson,
  state: QueryState<T>,
  plan: IndexWalkPlan,
): Promise<{ rows: T[]; tail: number }> => {
  const encodedSegments = plan.equalityKeys.map((v) => encodeIndexValue(v));
  const eqPrefix =
    encodedSegments.length === 0
      ? `${ctx.collectionPrefix}/index/${plan.indexName}/`
      : `${ctx.collectionPrefix}/index/${plan.indexName}/${encodedSegments.join("/")}/`;

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
    const walkOne = async (value: DocumentValue): Promise<string[]> => {
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
  // Discover the true tail once (probe runs even with no matches so
  // the manifest pointer still reflects it). Strict range stays
  // `[log_seq_start, tail_hint)`; the probe folds `[tail_hint, tail)`.
  const logSeqStart = logSeqStartOf(head);
  const hint = head.tail_hint;
  const probe = await probeTailFrom(ctx.storage, ctx.collectionPrefix, hint);
  const tail = probe.tail;

  const docIds = Array.from(docIdSet);
  if (docIds.length === 0) {
    return { rows: [], tail };
  }

  // 2. Resolve each docId by folding `(snapshot, log)` scoped to the
  //    matched set. Same fold the table-scan path uses, scoped to
  //    one Set<docId>.
  const matched = new Set(docIds);
  const baseDocs: Map<string, DocumentData> =
    head.snapshot === null
      ? new Map()
      : await loadSnapshotAsMap(ctx.storage, head.snapshot, ctx.collectionName);
  const docs = new Map<string, T>();
  for (const id of matched) {
    const seeded = baseDocs.get(id);
    if (seeded !== undefined) {
      docs.set(id, seeded as T);
    }
  }
  const entries = await walkLogRange(ctx.storage, ctx.collectionPrefix, logSeqStart, hint);
  foldLogEntriesOnto(docs, entries, { collection: ctx.collectionName, docIdFilter: matched });
  foldLogEntriesOnto(docs, probe.entries, { collection: ctx.collectionName, docIdFilter: matched });

  // 3. Apply the FULL original wire as the stale-row defence, then
  //    the planner's residue postFilter on top. `matchesWire` is
  //    open-world, so applying the full original wire (which the
  //    planner partly consumed) is the simpler invariant: if the
  //    doc still passes the original wire, it stays. Range / `in`
  //    clauses that landed in `plan.postFilter` are part of
  //    `state.wire` — they pass through here automatically.
  const rows: T[] = [];
  const wire = state.wire;
  for (const doc of docs.values()) {
    if (wire === undefined || matchesWire(wire, doc)) {
      rows.push(doc);
    }
  }
  return { rows, tail };
};

/**
 * Stable multi-key sort built from an `OrderSpec`. Keys are taken in
 * the spec's insertion order, which matches the caller's source-order
 * expectation. `Array.prototype.sort` is stable on Node 24+ and Workerd.
 *
 * Top-level fields only (locked at `OrderSpec<T>`).
 * Values are `DocumentValue` — string / number / boolean / object —
 * but only the primitive types are sensibly orderable; comparing two
 * objects falls through to "considered equal," which preserves the
 * stable-sort order of the input.
 */
const sortByOrderSpec = <T extends DocumentData>(rows: T[], spec: OrderSpec<T>): T[] => {
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
