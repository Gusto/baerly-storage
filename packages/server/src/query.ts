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
 * Mutation terminals are SINGLE-ATTEMPT per call site. Contention on the
 * committing log create is resolved inside `Writer.commit()` (occupant
 * readback, then a bounded forward probe); the verbs do NOT add their
 * own retry loop. Errors from `commit()` surface unchanged — the caller
 * decides whether to re-run.
 *
 * @see ../../../docs/spec/sync-protocol.md
 */

import {
  assertDocumentValues,
  assertInsertIdType,
  type CurrentJson,
  type DocumentData,
  type LogEntry,
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
import {
  type CapacityDecision,
  type CapacityWarning,
  capacityDecision,
  currentFoldCeilings,
  maintenancePending,
  noteCapacityWarning,
  type PlannedWrite,
} from "./capacity.ts";
import { callerFacingCheck, markCallerFacing } from "./caller-facing-error.ts";
import {
  assertDocId,
  assertReadDocId,
  insertAlreadyExists,
  insertReplaysRow,
  recordInsertReplay,
} from "./doc-id.ts";
import { type IndexDefinition } from "./indexes.ts";
import { foldLogEntriesOnto, walkLogRange } from "./log-walk.ts";
import { probeTailFrom } from "./log-tail.ts";
import { dispatchWriteTick } from "./maintenance.ts";
import { getCurrentContext } from "./observability/context.ts";
import { type SchemaValidator, validateOrThrow } from "./schema.ts";
import { type CommitAdmission, type CommitVerdict, Writer } from "./writer.ts";
import { isOwnCollection } from "./collection-alias.ts";

const PATCH_ID_RESOLUTION = "Omit `_id` from the patch, or pass the row's own `_id`.";

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
   * Per-collection {@link IndexDefinition}s maintained by the Writer.
   * Reads take membership from the complete snapshot plus log fold.
   * Empty array means no indexes declared.
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
 * Serialise a {@link CurrentJson} head into an opaque wire cursor.
 * `tail` is the DISCOVERED tail (defaults to `json.tail_hint` when no
 * probe has run). Physical snapshot keys feed the digest but never
 * cross the HTTP boundary.
 *
 * @internal — exported for `query.test.ts`.
 */
const manifestPointerDigest = (seed: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < seed.length; i++) {
    hash ^= BigInt(seed.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(36).padStart(13, "0");
};

export const serializeManifestPointer = (json: CurrentJson, tail = json.tail_hint): string =>
  `m1:${manifestPointerDigest(
    [
      json.snapshot ?? MANIFEST_POINTER_EMPTY_SNAPSHOT,
      json.log_seq_start,
      json.tail_hint,
      json.snapshot_bytes,
      json.snapshot_rows,
      tail,
    ].join("|"),
  )}`;

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
 * `id` is checked by {@link assertReadDocId} before any I/O.
 *
 * @internal — router uses this to preserve `_meta` envelope;
 *   mirrors {@link runAllWithMeta} and {@link Collection.get}.
 */
export const runByIdWithMeta = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  id: string,
): Promise<ReadResult<T>> => {
  assertReadDocId(id);
  return await runRead<T>(ctx, {
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
 * `commit()` rather than caching on the chain; the writer holds no
 * per-commit state, so this costs nothing.
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
 * The collection state a pre-commit read folded: `current.json`, the
 * snapshot rows and every tail entry on top of them. Present whenever the
 * read loaded the snapshot; the write verbs pass it to
 * {@link admitWrites}.
 */
interface FoldedState {
  readonly head: CurrentJson;
  readonly base: ReadonlyMap<string, DocumentData>;
  readonly tail: readonly LogEntry[];
}

/**
 * Throw the refusal `decision` carries: `MaintenancePending` when the
 * pending tail would make room once it folds, after dispatching one forced
 * fold pass (G6, fold-then-refuse) through the request's maintenance
 * dispatch, so on Cloudflare it runs in `ctx.waitUntil` like any write
 * tick; otherwise `CapacityExceeded`. Under `BAERLY_MAINTENANCE_DISABLE`
 * nothing can fold, so the refusal stays `CapacityExceeded`.
 *
 * @param tail The log tail the decision folded through.
 */
const throwRefusal = async (
  ctx: CollectionReadContext,
  decision: Extract<CapacityDecision, { refusal: BaerlyError }>,
  tail: number,
): Promise<never> => {
  if (decision.foldFreesRoom && getCurrentContext()?.maintenance?.disabled !== true) {
    // Nothing committed, so the tick's GC cadence window is empty and the
    // forced fold is its only phase.
    await dispatchWriteTick({
      storage: ctx.storage,
      currentJsonKey: `${ctx.collectionPrefix}/current.json`,
      collection: ctx.collectionName,
      prevSeq: tail,
      observedTail: tail,
      forceFold: true,
    });
    throw maintenancePending(ctx.collectionName);
  }
  throw decision.refusal;
};

/** What {@link admitWrites} hands a verb for its commits, in plan order. */
interface Admission {
  /**
   * Whether the batch's last commit forces its write tick: the writes
   * leave the collection at its growth-refusal point.
   */
  readonly forceMaintenance: boolean;
  /** The commit-time re-check for the next planned write's commit. */
  next(): CommitAdmission;
  /** Record that the next planned write committed as `entry`. */
  committed(entry: LogEntry): void;
  /**
   * Record that the next planned write's commit threw {@link RowSkipped}:
   * it committed nothing, and the batch moves on to the write after it.
   */
  skipped(): void;
  /**
   * Run the batch's forced write tick (G6) when its last planned write was
   * skipped: that write's commit would have carried the tick, so the rows
   * that did commit under pressure would otherwise leave the fold undone.
   * The verb calls it once after its commit loop.
   */
  settle(): Promise<void>;
  /**
   * Stamp the early capacity warning (G7) on the canonical line, from the
   * latest decision: the pre-commit one, or the last commit-time re-check.
   * The verb calls it once its commits have landed, so a write that
   * throws carries no warning.
   */
  warn(): void;
}

/**
 * One write a verb plans, as {@link admitWrites} takes it.
 *
 * A planned `U` or `D` is re-decided at commit time against the newest
 * version of its row (PostgreSQL READ COMMITTED's EvalPlanQual): if any
 * entry for its `_id` committed after the verb's read, the write is decided
 * from that version instead of the one the read returned. A `D` of the row
 * in that window skips the write (the commit throws {@link RowSkipped}),
 * even when a later `I` re-created the `_id`: that is a different row the
 * verb never read. Otherwise, for a `U`, `rebase` re-derives the post-image
 * from the newest version, or returns `undefined` to skip the row; without
 * `rebase` the planned post-image commits as is (last writer wins). For a
 * `D`, `stillMatches` re-evaluates the verb's predicate on the newest
 * version, and the row is skipped when it no longer matches.
 */
interface VerbWrite {
  readonly planned: PlannedWrite;
  readonly rebase?: (latest: DocumentData) => Promise<DocumentData | undefined>;
  readonly stillMatches?: (latest: DocumentData) => boolean;
}

/**
 * Thrown from an admission check when the row a planned `U` / `D` targets
 * was deleted after the verb's read, or no longer qualifies for it. The
 * writer propagates it before the committing create, so nothing commits;
 * the verb that planned the write catches it (`update` / `delete` leave the
 * row out of their count, `replace` throws `NotFound`). Never escapes
 * `query.ts`.
 */
class RowSkipped extends Error {
  constructor(docId: string) {
    super(`row ${JSON.stringify(docId)} changed under the write`);
    this.name = "RowSkipped";
  }
}

/**
 * The newest version of `docId` among `entries` (every entry committed
 * after the verb's read, in seq order): `"gone"` when any of them deletes
 * it, its newest post-image when one rewrote it, `undefined` when none
 * touched it.
 */
const newestVersion = (
  entries: readonly LogEntry[],
  collection: string,
  docId: string,
): DocumentData | "gone" | undefined => {
  let newest: DocumentData | undefined;
  for (const entry of entries) {
    if (!isOwnCollection(entry.collection, collection) || entry.doc_id !== docId) {
      continue;
    }
    if (entry.op === "D" || entry.after === undefined) {
      return "gone";
    }
    newest = entry.after;
  }
  return newest;
};

/** A never-provisioned collection: no snapshot, nothing folded. */
const EMPTY_HEAD = { snapshot_rows: 0, snapshot_bytes: 0, log_seq_start: 0 } as const;

/**
 * Admit `writes` against the serving host's fold ceiling before any commit
 * (see `./capacity.ts`), throwing as {@link throwRefusal} does when they
 * would grow the collection past it.
 *
 * The returned admission re-runs the verb's decisions at commit time.
 * Each commit passes `next()` to `Writer.commit`, which hands back every
 * log entry in `[fromSeq, seq)`: the entries this decision has not seen.
 *
 * - **Row (EvalPlanQual).** A planned `U` / `D` whose row any entry
 *   committed after the read touched (in this window, or in an earlier
 *   row's window of the same batch) is re-decided from the newest version,
 *   or skipped; see {@link VerbWrite}. A rebased post-image is the verdict's `body`,
 *   so the writer indexes and commits it.
 * - **Capacity (main-10 G5-race).** An empty window with no rebase means
 *   nothing intervened, so the decision stands as made and nothing is
 *   recomputed. Otherwise the decision re-runs over the read's tail plus
 *   the window, for the planned writes not yet committed (this one with
 *   its rebased post-image), and a refusal throws before the committing
 *   create, so concurrent growth writes that each passed this check cannot
 *   together pass the ceiling.
 *
 * Each `committed(entry)` moves `fromSeq` past this batch's own commit, so
 * the writer reads only entries this decision has not seen.
 *
 * With no folded state (an unprovisioned collection), the collection is empty,
 * so the pre-commit check is skipped; a re-check starts from an empty
 * collection.
 *
 * @param read The pre-commit read: its folded state, and `tail`, the
 *   first empty log slot it folded through.
 */
const admitWrites = async (
  ctx: CollectionReadContext,
  read: { readonly folded?: FoldedState; readonly tail: number },
  verbWrites: readonly VerbWrite[],
): Promise<Admission> => {
  const { folded } = read;
  const writes = verbWrites.map((w) => w.planned);
  let forceMaintenance = false;
  let warning: CapacityWarning | undefined;
  if (folded !== undefined) {
    const decision = capacityDecision({
      collection: ctx.collectionName,
      head: folded.head,
      base: folded.base,
      tail: folded.tail,
      writes,
      ceilings: currentFoldCeilings(),
    });
    if (decision.refusal !== undefined) {
      return await throwRefusal(ctx, decision, read.tail);
    }
    forceMaintenance = decision.pressure;
    warning = decision.warning;
  }
  const head = folded?.head ?? EMPTY_HEAD;
  const base = folded?.base ?? new Map<string, DocumentData>();
  // Every entry the decision has seen so far, in seq order: the read's
  // tail, then `sinceRead`.
  const seen: LogEntry[] = [...(folded?.tail ?? [])];
  // The entries committed after the read that this decision has seen.
  const sinceRead: LogEntry[] = [];
  let fromSeq = read.tail;
  let pending = 0;
  // The window of the latest `check` call: on commit, `[fromSeq, seq)`.
  let lastWindow: readonly LogEntry[] = [];
  // The latest decision's G6 pressure, and the batch's last own commit.
  let pressure = forceMaintenance;
  let lastCommitted: LogEntry | undefined;
  let lastSkipped = false;
  const check = async (
    window: readonly LogEntry[],
    tail: number,
  ): Promise<CommitVerdict | undefined> => {
    lastWindow = window;
    const { planned, rebase, stillMatches } = verbWrites[pending]!;
    let rebased: DocumentData | undefined;
    if (planned.op !== "I") {
      const newest = newestVersion([...sinceRead, ...window], ctx.collectionName, planned.docId);
      if (newest === "gone") {
        throw new RowSkipped(planned.docId);
      }
      if (newest !== undefined && stillMatches !== undefined && !stillMatches(newest)) {
        throw new RowSkipped(planned.docId);
      }
      if (newest !== undefined && rebase !== undefined) {
        rebased = await rebase(newest);
        if (rebased === undefined) {
          throw new RowSkipped(planned.docId);
        }
      }
    }
    if (window.length === 0 && rebased === undefined) {
      return undefined;
    }
    const tailNow = [...seen, ...sinceRead, ...window];
    const remaining = writes.slice(pending);
    if (rebased !== undefined) {
      remaining[0] = { ...planned, after: rebased };
    }
    const decision = capacityDecision({
      collection: ctx.collectionName,
      head,
      base,
      tail: tailNow,
      writes: remaining.map((write) => withLiveBefore(write, ctx.collectionName, tailNow)),
      ceilings: currentFoldCeilings(),
    });
    if (decision.refusal !== undefined) {
      return await throwRefusal(ctx, decision, tail);
    }
    // Re-derive the forced tick (G6) from the state the commit lands on.
    // It rides the batch's last commit only, as the pre-commit flag does.
    warning = decision.warning;
    pressure = decision.pressure;
    return {
      forceMaintenance: decision.pressure && pending === writes.length - 1,
      ...(rebased !== undefined && { body: rebased }),
    };
  };
  return {
    forceMaintenance,
    next: () => {
      lastWindow = [];
      return { fromSeq, check };
    },
    committed: (entry) => {
      sinceRead.push(...lastWindow, entry);
      fromSeq = entry.seq + 1;
      pending++;
      lastCommitted = entry;
      lastSkipped = false;
    },
    skipped: () => {
      // `fromSeq` stays put, so the next row's window re-reads the
      // skipped row's window; nothing is recorded twice.
      pending++;
      lastSkipped = true;
    },
    settle: async () => {
      if (
        !lastSkipped ||
        lastCommitted === undefined ||
        !pressure ||
        getCurrentContext()?.maintenance?.disabled === true
      ) {
        return;
      }
      await dispatchWriteTick({
        storage: ctx.storage,
        currentJsonKey: `${ctx.collectionPrefix}/current.json`,
        collection: ctx.collectionName,
        prevSeq: lastCommitted.seq,
        observedTail: lastCommitted.seq + 1,
        forceFold: true,
      });
    },
    warn: () => {
      if (warning !== undefined && writes.length > 0) {
        noteCapacityWarning(warning);
      }
    },
  };
};

/**
 * `write` with `before` re-read from the latest entry for its row in
 * `tail`, when there is one: an intervening commit may have changed the
 * row, so growth (G3) is judged against the row as it now stands. A row an
 * intervening `D` removed has no `before`, which counts as growth (fails
 * closed).
 */
const withLiveBefore = (
  write: PlannedWrite,
  collection: string,
  tail: readonly LogEntry[],
): PlannedWrite => {
  if (write.op !== "U") {
    return write;
  }
  for (let i = tail.length - 1; i >= 0; i--) {
    const entry = tail[i]!;
    if (isOwnCollection(entry.collection, collection) && entry.doc_id === write.docId) {
      const { before: _stale, ...rest } = write;
      return entry.op === "D" || entry.after === undefined
        ? rest
        : { ...rest, before: entry.after };
    }
  }
  return write;
};

/**
 * `Collection.insert` implementation. Mints a UUIDv7 `_id`
 * when the caller omits it (or supplies an empty string); honours a
 * caller-supplied non-empty `_id`. The first `I` for an `_id` wins:
 * when a live row already holds the `_id`, the insert throws
 * non-retriable `BaerlyError{code:"AlreadyExists"}` and commits nothing.
 * A row committed before the pre-commit check read is caught there,
 * without a writer round-trip; one committed concurrently, after that
 * read, is caught by the writer's insert guard, which reads the log
 * window the check could not see. So of concurrent inserts of one `_id`,
 * at most one commits (exactly one, absent storage failures) and the
 * others throw `AlreadyExists` — matches the
 * locked `Collection.insert` contract
 * (`packages/protocol/src/collection-api.ts`).
 *
 * The emitted `LogEntry` has `op:"I"` and `after === {...doc, _id}`
 * (today's per-doc-replace model).
 *
 * **SDK-minted replay.** `opts.mintedId` marks `_id` as minted by an SDK
 * client rather than chosen by the caller; only the HTTP insert route
 * sets it (from the body's `mintedId`), and `Collection.insert` never
 * does. With it set, a live row for `_id` equal to `{...doc, _id}`
 * (`insertReplaysRow`: key order ignored) is this insert's own earlier
 * success, resent after a lost response: the call returns `{ _id }` and
 * commits nothing, whether the check read or the writer's insert guard
 * finds the row. A live row with any other body still throws
 * `AlreadyExists`. "Live" covers a `U`: a body equal to a later update's
 * post-image also replays. A caller-chosen `_id` never replays, even onto
 * an identical row, so a run-once guard like
 * `insert({ _id: "migration-x", done: true })` has at most one winner.
 *
 * @throws BaerlyError code="AlreadyExists" — a live row holds `_id`,
 *   committed before or concurrently with this call (and, with
 *   `mintedId`, its body differs). `err._id` is the `_id`. Not retriable.
 * @throws BaerlyError code="InvalidConfig" — `doc` holds a value JSON
 *   cannot store as written (see `assertDocumentValues`), the supplied
 *   `_id` is present and not a string (`null` included), the resolved `_id` fails
 *   {@link assertDocId} (key-segment rule or not NFC), or `opts.mintedId`
 *   is set and is not the resolved `_id`. Checked before I/O.
 * @throws BaerlyError code="WriteConflict" — a rejected storage precondition
 *   `Writer.commit()` does not resolve, or log retention retired part of the
 *   window the insert guard had to read; nothing was committed. Retriable.
 * @throws BaerlyError code="AmbiguousCommit" — a committing create may be
 *   durable, but its outcome could not be resolved. The row may or may not
 *   have been inserted. Not retriable-by-default; see `Writer.commit`.
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
  /** @internal — set only by the HTTP insert route. */
  opts?: { readonly mintedId?: string },
): Promise<{ _id: string }> => {
  // Auto-id semantics: caller-supplied non-empty `_id` wins; otherwise
  // mint a UUIDv7. The locked contract
  // (`packages/protocol/src/collection-api.ts:120–122`) names UUIDv7 as the
  // auto-id source.
  // A present, non-string `_id` is a caller bug, refused before it could be
  // replaced by a minted one.
  const supplied = doc["_id"];
  callerFacingCheck(() => {
    assertInsertIdType(supplied);
    assertDocumentValues(doc, "insert");
  });
  const _id = typeof supplied === "string" && supplied.length > 0 ? supplied : uuidv7();
  // Guard the resolved id at the write origin — the only place a
  // user-controlled `_id` enters as a WRITTEN key segment. Minted
  // UUIDv7 always passes, so guarding unconditionally also documents
  // the invariant. The `_id` analogue of `assertKeySegment` (`db.ts`).
  assertDocId(_id);
  const mintedId = opts?.mintedId;
  if (mintedId !== undefined && mintedId !== _id) {
    throw new BaerlyError(
      "InvalidConfig",
      `insert: mintedId ${JSON.stringify(mintedId)} is not the document _id ${JSON.stringify(_id)}`,
    );
  }
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

  // Pre-commit `_id`-collision check: a live row at the check read's
  // tail `T0` throws `AlreadyExists` with no writer round-trip. The
  // writer's guard trusts this check for every entry below `T0`, so
  // insert uniqueness rests on the authoritative fold, as every read's
  // membership does.
  const existing = await runReadRows<DocumentData>(ctx, {
    wire: { clauses: [{ op: "eq", field: "_id", value: _id }] },
    order: undefined,
    limit: 1,
  });
  const live = existing.rows[0];
  if (live !== undefined) {
    if (mintedId !== undefined && insertReplaysRow(body, live.doc)) {
      recordInsertReplay(ctx.collectionName);
      return { _id };
    }
    throw insertAlreadyExists(ctx.collectionName, _id);
  }
  const admission = await admitWrites(ctx, existing, [
    { planned: { op: "I", docId: _id, after: body } },
  ]);

  // Single-attempt at the verb level; log-create contention is resolved
  // inside `Writer.commit()`, and its errors surface unchanged. The
  // insert guard makes the writer check the log window `[T0, seq)` this
  // read could not see, so of concurrent inserts of one `_id` only the
  // first `I` commits and the rest throw `AlreadyExists`.
  await writerFor(ctx).commit({
    op: "I",
    collection: ctx.collectionName,
    docId: _id,
    body,
    insertGuard: { absentBelowSeq: existing.tail, replayIdentical: mintedId !== undefined },
    admission: admission.next(),
    ...(admission.forceMaintenance && { forceMaintenance: true }),
  });
  admission.warn();

  return { _id };
};

/**
 * The `doc_id` that `update` / `delete` commit a materialised row under,
 * after checking that the row's own `_id` is that same string. Every
 * stored `I` / `U` post-image names its storage key; a row whose `_id` is
 * missing, not a string, or a different id is stored corruption (an older
 * release let a patch strip or re-key `_id`). Committing it anyway would
 * duplicate the row under its `_id`, or tombstone a key that does not
 * hold it, so it fails loud instead. `replace(id, doc)` repairs such a
 * row: it forces `_id` to `id`.
 *
 * @throws BaerlyError code="InvalidResponse" — the row's `_id` is not the
 *   string it is stored under.
 */
const storedRowId = <T extends DocumentData>(
  row: StoredRow<T>,
  verb: "update" | "delete",
): string => {
  const id = row.doc["_id"];
  if (id !== row.docId) {
    throw new BaerlyError(
      "InvalidResponse",
      `Query.${verb}: stored row ${JSON.stringify(row.docId)} carries _id ${
        typeof id === "string" ? JSON.stringify(id) : `of type ${typeof id}`
      }; repair it with replace(id, doc)`,
    );
  }
  return row.docId;
};

/**
 * Reject a merge patch that would change a row's `_id`. A patch whose
 * top-level `_id` is present (not `undefined`, which `merge` treats as
 * absent) must equal the row's id: an equal `_id` keeps a full-document
 * round-trip patch working, while any other value — including `null`,
 * which would strip `_id` — is a caller bug. Unlike `replace`, which takes
 * the id as a separate argument and forces it onto the document, a patch
 * has no separate id to fall back on, so forcing it would hide the bug.
 *
 * @throws BaerlyError code="InvalidConfig" — the patch names a different `_id`.
 */
const assertPatchKeepsId = (patch: unknown, docId: string): void => {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return;
  }
  if (!Object.hasOwn(patch, "_id")) {
    return;
  }
  const patchId = (patch as DocumentData)["_id"];
  if (patchId !== undefined && patchId !== docId) {
    throw markCallerFacing(
      new BaerlyError(
        "InvalidConfig",
        `Query.update: a patch cannot change _id (row ${JSON.stringify(docId)}); omit _id from the patch`,
        { resolution: PATCH_ID_RESOLUTION },
      ),
    );
  }
};

/**
 * `merge(row, patch)` as `update` commits it, validated against the
 * collection's schema.
 *
 * @throws BaerlyError code="InvalidConfig" — the post-image holds a value
 *   JSON cannot store as written (see `assertDocumentValues`).
 * @throws BaerlyError code="SchemaError" — the merge produced `undefined`,
 *   or the schema rejected the post-image.
 */
const mergeAndValidate = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  row: DocumentData,
  patch: Partial<T>,
): Promise<DocumentData> => {
  const merged = merge(row, patch as Partial<DocumentData>);
  if (merged === undefined) {
    // `merge(target, patch)` returns undefined only when patch is
    // null at the root. `Partial<T>` cannot be `null` at the type
    // level; defensive check for runtime caller misuse via cast.
    throw new BaerlyError(
      "SchemaError",
      `Query.update: merge produced undefined for doc ${JSON.stringify(row["_id"])}`,
    );
  }
  // A value JSON would coerce or drop is refused before admission and any
  // write. An `undefined` member is absent, as it is in the HTTP form of
  // the patch, which `JSON.stringify` dropped it from.
  callerFacingCheck(() => assertDocumentValues(merged, "update", { undefinedMembersAbsent: true }));
  // Validate the merged post-image, not the incoming patch.
  // Patches are partial by design — validating the patch itself
  // would reject valid updates against schemas that require fields
  // the patch doesn't touch. The post-image is what the schema
  // actually models.
  if (ctx.schema !== undefined) {
    await validateOrThrow(ctx.schema, merged, {
      collection: ctx.collectionName,
      verb: "update",
    });
  }
  return merged;
};

/**
 * `Query.update` implementation. Materialises the predicate/order/
 * limit-filtered match set, applies RFC 7386 `merge(prev, patch)`
 * per row, and emits one `op:"U"` `LogEntry` per affected `doc_id`
 * — one `Writer.commit()` round-trip apiece.
 *
 * Atomicity is per row, not across the N-row batch: each affected row
 * commits independently — the document is the atomic unit; there is no
 * multi-row batch.
 *
 * **Concurrent writes to a matched row (EvalPlanQual).** When another
 * write to a matched row commits between this read and the row's own
 * commit, the patch is re-applied to that newest version and the
 * predicate re-evaluated on it (`limit` / `order` are not); a row that
 * was deleted there, or no longer matches, is skipped and not counted in
 * `modified`. See {@link VerbWrite}.
 *
 * `replica_identity` defaults to `PATCH_ONLY` for every collection
 * today — emitted `U` entries carry `{ after }` (the full post-image)
 * and neither `before` nor `key_old`. Consumers rebuilding pre-images
 * under `PATCH_ONLY` need to maintain a shadow table — see
 * `packages/protocol/src/log.ts:102–118`.
 *
 * @throws BaerlyError code="WriteConflict" — one row's commit hit a rejected
 *   storage precondition `Writer.commit()` does not resolve. The
 *   partial-progress `modified` count is NOT returned in that case.
 * @throws BaerlyError code="AmbiguousCommit" — one row's committing create
 *   may be durable, but its outcome could not be resolved. Rows before it in
 *   the batch are already applied and that row's own fate is unknown; the
 *   partial-progress `modified` count is NOT returned. Re-read rows by `_id`
 *   before deciding whether to resume; absence does not prove a create failed.
 *   See `Writer.commit`.
 * @throws BaerlyError code="SchemaError" — `merge(prev, patch)` produced
 *   `undefined` (defensive — `Partial<T>` cannot be `null` at the
 *   root in the type system), or the schema rejected a post-image; at a
 *   row's commit (re-applied to a newer version) rows before it are
 *   already applied.
 * @throws BaerlyError code="InvalidConfig" — the patch (checked before
 *   I/O) or a merged post-image holds a value JSON cannot store as written
 *   (see `assertDocumentValues`; an `undefined` member is absent), or the
 *   patch names an `_id` other than the row's (see {@link assertPatchKeepsId}), or the row's
 *   `_id` is not NFC (see {@link assertDocId}). Checked for every matched
 *   row, with schema validation, before any row commits.
 * @throws BaerlyError code="CapacityExceeded" — the batch would grow the
 *   collection past the serving host's fold ceiling (see `./capacity.ts`);
 *   decided before any row commits, and re-checked at each row's commit
 *   when a concurrent write landed since (see {@link admitWrites}), in
 *   which case rows before it are already applied. Also thrown when the
 *   request's storage budget runs out (the request ledger, including the
 *   writer's commit-resolution reserve): rows before the refused one are
 *   applied, it and the rows after it are not, and nothing is ambiguous.
 *   The partial-progress `modified` count is NOT returned.
 * @throws BaerlyError code="InvalidResponse" — a matched stored row's
 *   `_id` is not the string it is stored under.
 */
const runUpdate = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  state: QueryState<T>,
  patch: Partial<T>,
): Promise<{ modified: number }> => {
  // The patch is also checked before any I/O. `merge` treats a `Date` or
  // `Map` patch value as an object to merge field by field, so over an
  // object field it would vanish from the post-image instead of being
  // refused there. `undefined` members are absent, as in the post-image.
  callerFacingCheck(() => assertDocumentValues(patch, "update", { undefinedMembersAbsent: true }));
  const read = await runReadRows<T>(ctx, state);
  const { rows } = read;
  // Merge and validate every row first, so the per-row checks and the
  // capacity check decide the batch whole, before its first row commits.
  // Only the commit-time re-checks can stop the batch part-way: the
  // capacity re-check, or a `SchemaError` re-applying the patch to a newer
  // version of a row.
  const planned: Array<{ docId: string; before: DocumentData; merged: DocumentData }> = [];
  for (const row of rows) {
    const doc = row.doc;
    const docId = storedRowId(row, "update");
    assertPatchKeepsId(patch, docId);
    // The commit re-writes index markers under `docId`, so a row an
    // earlier release stored under a non-NFC id is refused here, before
    // schema validation; it stays readable and deletable.
    assertDocId(docId);
    const merged = await mergeAndValidate(ctx, doc as DocumentData, patch);
    planned.push({ docId, before: doc as DocumentData, merged });
  }
  // Re-derive a row's post-image from a version committed after this
  // read: the predicate must still hold, then the same merge and schema
  // check as above.
  const rebase = async (latest: DocumentData): Promise<DocumentData | undefined> => {
    if (state.wire !== undefined && !matchesWire(state.wire, latest)) {
      return undefined;
    }
    return await mergeAndValidate(ctx, latest, patch);
  };
  const admission = await admitWrites(
    ctx,
    read,
    planned.map((p) => ({
      planned: { op: "U", docId: p.docId, after: p.merged, before: p.before },
      rebase,
    })),
  );
  let modified = 0;
  // Atomicity stays per row: a commit failure on row N leaves rows
  // 0..N-1 applied. A forced tick rides the batch's last commit only, so
  // the batch runs one forced fold, not one per row.
  for (const [i, { docId, merged }] of planned.entries()) {
    let entry: LogEntry;
    try {
      ({ entry } = await writerFor(ctx).commit({
        op: "U",
        collection: ctx.collectionName,
        docId,
        body: merged,
        admission: admission.next(),
        ...(admission.forceMaintenance && i === planned.length - 1 && { forceMaintenance: true }),
      }));
    } catch (error) {
      if (error instanceof RowSkipped) {
        admission.skipped();
        continue;
      }
      throw error;
    }
    admission.committed(entry);
    modified++;
  }
  await admission.settle();
  admission.warn();
  return { modified };
};

/**
 * `Collection.replace` implementation. Existence check via `runRead` over
 * a `byId`-shaped wire so the `singleIdFromPredicate` PK fast path
 * (`Map.get`) fires. Missing row → `NotFound` directly (no conflict-string
 * indirection through the router). Present row → emit a single
 * `op:"U"` `LogEntry` carrying `doc` as the post-image, with `_id`
 * forced to the requested `id` so doc identity is preserved across
 * replaces even if the supplied `doc._id` differs.
 *
 * A replace racing another write to the row stays last-writer-wins: an
 * update committed after this read is overwritten. A delete committed
 * there is not undone: the replace commits nothing and throws `NotFound`
 * (see {@link VerbWrite}).
 *
 * @throws BaerlyError code="NotFound" — no row exists at `id`, including
 *   one a concurrent delete removed after this call's read.
 * @throws BaerlyError code="InvalidConfig" — `id` fails
 *   {@link assertDocId} (key-segment rule or not NFC), or `doc` holds a
 *   value JSON cannot store as written (see `assertDocumentValues`).
 *   Checked before I/O.
 * @throws BaerlyError code="SchemaError" — post-image rejected by
 *   the collection's bound validator.
 * @throws BaerlyError code="WriteConflict" — a rejected storage precondition
 *   `Writer.commit()` does not resolve; nothing was committed.
 * @throws BaerlyError code="AmbiguousCommit" — a committing create may be
 *   durable, but its outcome could not be resolved, so the replace may or may
 *   not have been applied. Re-read the row by `id` before deciding whether to
 *   retry; absence does not prove the create failed. See `Writer.commit`.
 */
export const runReplaceById = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  id: string,
  doc: T,
): Promise<void> => {
  // Guard the caller-supplied id before it becomes a written key
  // segment (index keys, log `doc_id`). Same boundary as `runInsert`.
  assertDocId(id);
  callerFacingCheck(() => assertDocumentValues(doc, "replace"));
  const wire: PredicateWire = {
    clauses: [{ op: "eq", field: "_id", value: id }],
  };
  const state: QueryState<T> = {
    wire,
    order: undefined,
    limit: undefined,
  };
  const read = await runReadRows<T>(ctx, state);
  const current = read.rows[0];
  if (current === undefined) {
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
  const admission = await admitWrites(ctx, read, [
    { planned: { op: "U", docId: id, after: body, before: current.doc as DocumentData } },
  ]);
  try {
    await writerFor(ctx).commit({
      op: "U",
      collection: ctx.collectionName,
      docId: id,
      body,
      admission: admission.next(),
      ...(admission.forceMaintenance && { forceMaintenance: true }),
    });
  } catch (error) {
    if (error instanceof RowSkipped) {
      throw new BaerlyError("NotFound", `No such row: ${id}`);
    }
    throw error;
  }
  admission.warn();
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
 * **Concurrent writes to a matched row (EvalPlanQual).** As in
 * `runUpdate`: when another write to a matched row commits between this
 * read and the row's own commit, the predicate is re-evaluated on that
 * newest version. A row deleted there (including by a racing delete, or
 * deleted and re-inserted), or no longer matching, is skipped and not
 * counted in `deleted`. See {@link VerbWrite}.
 *
 * @throws BaerlyError code="WriteConflict" — one row's commit hit a rejected
 *   storage precondition `Writer.commit()` does not resolve. The
 *   partial-progress `deleted` count is NOT returned
 *   in that case.
 * @throws BaerlyError code="AmbiguousCommit" — one row's committing create
 *   may be durable, but its outcome could not be resolved. Rows before it in
 *   the batch are already tombstoned and that row's own fate is unknown; the
 *   partial-progress `deleted` count is NOT returned. Re-read rows by `_id`
 *   before deciding whether to resume. See `Writer.commit`.
 * @throws BaerlyError code="CapacityExceeded" — as in `runUpdate`: the
 *   batch would grow past the fold ceiling (a delete can when a pending
 *   fold cannot make progress), or the request's storage budget ran out
 *   part-way. Rows before the refused one are tombstoned, it and the rows
 *   after it are not; the partial-progress `deleted` count is NOT returned.
 * @throws BaerlyError code="InvalidResponse" — a matched stored row's
 *   `_id` is not the string it is stored under.
 */
const runDelete = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  state: QueryState<T>,
): Promise<{ deleted: number }> => {
  const read = await runReadRows<T>(ctx, state);
  const docIds = read.rows.map((row) => storedRowId(row, "delete"));
  const { wire } = state;
  const stillMatches =
    wire === undefined ? undefined : (latest: DocumentData) => matchesWire(wire, latest);
  const admission = await admitWrites(
    ctx,
    read,
    docIds.map((docId) => ({ planned: { op: "D", docId }, stillMatches })),
  );
  let deleted = 0;
  // As in `runUpdate`, a forced tick rides the batch's last commit only
  // (or `settle()`, when that row is skipped).
  for (const [i, docId] of docIds.entries()) {
    let entry: LogEntry;
    try {
      ({ entry } = await writerFor(ctx).commit({
        op: "D",
        collection: ctx.collectionName,
        docId,
        admission: admission.next(),
        ...(admission.forceMaintenance && i === docIds.length - 1 && { forceMaintenance: true }),
      }));
    } catch (error) {
      if (error instanceof RowSkipped) {
        admission.skipped();
        continue;
      }
      throw error;
    }
    admission.committed(entry);
    deleted++;
  }
  await admission.settle();
  admission.warn();
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
  const { rows, manifestPointer, fresh } = await runReadRows(ctx, state);
  return { rows: rows.map((row) => row.doc), manifestPointer, fresh };
};

/**
 * A materialised row paired with the `doc_id` it is stored under. The
 * mutation verbs commit under `docId`, and check that the row's own `_id`
 * agrees with it (see {@link storedRowId}).
 */
interface StoredRow<T extends DocumentData> {
  readonly docId: string;
  readonly doc: T;
}

/** {@link runRead}, keeping each row's storage key. */
const runReadRows = async <T extends DocumentData>(
  ctx: CollectionReadContext,
  state: QueryState<T>,
): Promise<{
  readonly rows: StoredRow<T>[];
  readonly manifestPointer: string;
  readonly fresh: boolean;
  /**
   * The log tail this read folded through: the first empty slot its
   * probe found, or `0` when the collection is not provisioned. Before
   * predicate, order and limit are applied, the fold contains every live
   * row through this tail; markers do not restrict membership.
   */
  readonly tail: number;
  /** The folded state, for the write verbs' capacity check. */
  readonly folded?: FoldedState;
}> => {
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
    return { rows: [], manifestPointer: "m1:0000000000000", fresh, tail: 0 };
  }

  // Markers cannot establish membership: post-commit cleanup can remove
  // a reinserted row's marker, and a LIST can precede a commit that the
  // tail probe includes. Fold authoritative state before filtering.

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
  // forward-probe [max(log_seq_start, tail_hint), tail). Strict range is
  // dense (a hole is corruption → `walkLogRange` THROWS); the probe
  // stops at the first 404 and its entries fold through the SAME path as
  // the strict walk. The probe floor is `max(log_seq_start, tail_hint)`:
  // under single-write commit `tail_hint` is only a lower bound, so a
  // compactor that advanced `log_seq_start` past a stale `tail_hint`
  // must NOT have its folded entries re-read by the probe.
  const probeFrom = Math.max(logSeqStart, hint);
  const entries = await walkLogRange(ctx.storage, ctx.collectionPrefix, logSeqStart, hint);
  const probe = await probeTailFrom(ctx.storage, ctx.collectionPrefix, probeFrom);
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
  let rows: StoredRow<T>[];
  if (fastId !== undefined) {
    const hit = docs.get(fastId);
    rows = hit === undefined ? [] : [{ docId: fastId, doc: hit }];
  } else {
    rows = Array.from(docs, ([docId, doc]) => ({ docId, doc }));
    if (state.wire !== undefined) {
      const w = state.wire;
      rows = rows.filter((row) => matchesWire(w, row.doc));
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

  return {
    rows,
    manifestPointer: serializeManifestPointer(head.json, tail),
    fresh,
    tail,
    folded: { head: head.json, base: baseDocs, tail: [...entries, ...probe.entries] },
  };
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
const sortByOrderSpec = <T extends DocumentData>(
  rows: StoredRow<T>[],
  spec: OrderSpec<T>,
): StoredRow<T>[] => {
  const entries = Object.entries(spec) as Array<[keyof T, "asc" | "desc"]>;
  return rows.toSorted((a, b) => {
    for (const [field, dir] of entries) {
      const av: T[keyof T] | undefined = a.doc[field];
      const bv: T[keyof T] | undefined = b.doc[field];
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
