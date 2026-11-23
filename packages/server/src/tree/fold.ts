/**
 * The write-tick fold of the prototype tree: capture the head and root,
 * read a contiguous log prefix from the floor, plan the new tree change
 * by change under the request's storage-call budget, and publish it.
 *
 * Storage calls, in order: the head GET, the root GET (none for an empty
 * tree), the log reads, the planner's node GETs between them, then
 * {@link publishTree}'s node creates, head CAS and fate re-read. The fold
 * writes only through `publishTree` and deletes nothing: a `cas-lost`
 * attempt's nodes may still be reachable from a later root, so only the
 * GC tick, judging from the current root, may reclaim them.
 *
 * **The log prefix.** The fold reads `[floor, tail)` the way the
 * compactor does: the range below `max(tail_hint, knownTail)` must be
 * dense (`walkLogRange`; a missing entry there is `Internal`), and past
 * it a forward probe (`probeTailChunk`) stops at the first missing slot,
 * which is the tail. The fold end `F` never passes an unread seq or the
 * discovered tail. Log GETs are charged to the planner before they are
 * issued (`FoldPlanner.spend`), at the same worst-case rate as its node
 * GETs, in small batches between the changes they deliver. The probe
 * reads one slot per batch, so it never charges a slot past the tail.
 *
 * **Changes.** Every entry in the window is given to the planner in seq
 * order, so `F = floor + accepted`. An entry the read path's fold skips
 * (another collection, no `doc_id`, an `I`/`U` without `after`) is
 * accepted as a skip (`FoldPlanner.skip`). A surviving `I`/`U` must be a
 * valid stored document whose `_id` is its `doc_id`; a `D` whose `doc_id`
 * is outside the document-ID domain changes nothing. Entries supersede
 * one another by their raw `doc_id`, as the read path's fold keys its
 * rows, so the number `5` and the string `"5"` are different rows. Every
 * log body must be a JSON object, past the tail hint as below it.
 *
 * **Invalid survivors.** An `I`/`U` that is not valid is not published,
 * but a later entry for the same `_id` may supersede it. The fold pins
 * the planner's checkpoint before it, skips it and reads on; once every
 * such `_id` has a valid later entry the pin is released. If the window
 * or the budget runs out first, the planner rolls back to the pinned
 * checkpoint, so the fold publishes only the valid prefix before the
 * invalid entry and reports `InvalidResponse` for it. The message names
 * the seq and the `doc_id`, and the remedy for its kind.
 *
 * **Budgets.** Every host charges the fold against its request ledger
 * through the planner: a change whose GETs or publication would not fit
 * ends the fold before its seq. The default budget is what the ledger
 * has left after the head GET: before any storage call has charged it,
 * the ledger cannot tell which pool the storage draws on and reports no
 * limit. A host with a depth-0 limit (Cloudflare Free) also publishes
 * only a root leaf within its document-byte and row ceilings, as the
 * compactor's ceilings do. A change that would add a row past the row
 * ceiling ends the fold before its seq. On the byte axis the fold takes
 * the longest prefix whose end state fits: an entry that takes the
 * totals past it pins the checkpoint before it, and a later delete or
 * shrink that brings them back within it releases the pin. A captured
 * tree already past either ceiling folds nothing. Each refuses as a
 * `deferred` stop the caller reports.
 *
 * **Stuck entry.** When not even the first entry fits this tick's
 * budget, the fold publishes nothing, keeps the floor and emits a
 * counted structured warning naming the seq. The check uses the budget
 * this tick has left, not a fresh tick's, so a fold that starts late in
 * an invocation can warn about an entry a fresh tick would fold.
 *
 * Not wired into the `Writer` or any route.
 */
import {
  BaerlyError,
  currentRequestLedger,
  encodeJsonBytes,
  type LogEntry,
  logObjectKey,
  MAX_PARALLEL_LOG_READS,
  type Storage,
} from "@baerly/protocol";
import { isOwnCollection } from "../collection-alias.ts";
import { assertStoredDocId } from "../doc-id.ts";
import { probeTailChunk } from "../log-tail.ts";
import { walkLogRangeWithBytes } from "../log-walk.ts";
import { ctxMetrics, getCurrentContext } from "../observability/context.ts";
import { assertSnapshotDocId } from "../snapshot-doc-id.ts";
import { singleLeafApplies } from "./build.ts";
import { importChunkKey } from "./chunk.ts";
import { TREE_CHUNK_SALT_BYTES, TREE_RETRIED_CALL_CHARGE } from "./constants.ts";
import { importTreeChunkKey, readTreeHead, readTreeRoot, type TreeHead } from "./head.ts";
import { collectionOfPrefix } from "./key.ts";
import { DEFAULT_TREE_CONFIG, type TreeConfig } from "./layout.ts";
import { type CanonicalDocument, canonicalDocument, type DecodedTreeNode } from "./node-codec.ts";
import { FoldPlanner, type TreeFoldPlan, type TreeMutation } from "./plan.ts";
import { publishTree, type TreePublishOutcome } from "./publish.ts";

/**
 * A depth-0 write limit: the fold publishes only a root leaf holding at
 * most `maxBytes` document bytes and `maxRows` rows.
 */
export interface TreeDepthZeroLimit {
  readonly maxBytes: number;
  readonly maxRows: number;
}

/** Input to {@link prepareTreeFold} and {@link foldTree}. */
export interface TreeFoldInput {
  /** Storage behind the adapter retry (`retryStorageCall`). */
  readonly storage: Storage;
  /** The collection prefix `P`. */
  readonly prefix: string;
  /**
   * Storage calls this tick may charge, every attempt counted, the head
   * GET included. Default: what the request ledger has left once the
   * head GET has charged it, or no limit without one.
   */
  readonly budget?: number;
  /** The host's depth-0 limit; absent where the tree may grow past one leaf. */
  readonly depthZero?: TreeDepthZeroLimit;
  /**
   * A tail lower bound the caller already observed (a writer's committed
   * `seq + 1`): the range below it is read as dense, as the compactor's
   * `knownTail` does.
   */
  readonly knownTail?: number;
  /** The tree configuration; tests pass a small layout or a mutant here. */
  readonly config?: TreeConfig;
  /** Mints the chunk salt of a head that has none yet. Default: 16 random bytes. */
  readonly mintChunkSalt?: () => string;
  readonly signal?: AbortSignal;
}

/** Why a fold ended before the discovered tail. */
export type TreeFoldStop =
  /** The budget ran out before the entry at `seq` (or before reading it). */
  | { readonly reason: "budget"; readonly seq: number }
  /**
   * A depth-0 ceiling: the captured tree is past it (`gate: "pre-fold"`),
   * or the entry at `seq` would take the totals past it and no later
   * entry in the window brought them back (`gate: "rebuild"`). `rows` and
   * `bytes` are the totals that broke it.
   */
  | {
      readonly reason: "deferred";
      readonly seq: number;
      readonly gate: "pre-fold" | "rebuild";
      readonly dimension: "bytes" | "rows";
      readonly rows: number;
      readonly bytes: number;
    }
  /** The entry at `seq` is an invalid survivor; `error` is the `InvalidResponse` to report. */
  | { readonly reason: "invalid-entry"; readonly seq: number; readonly error: BaerlyError }
  /** Not even the first entry, at `seq`, fits this tick's budget. */
  | { readonly reason: "stuck-entry"; readonly seq: number };

/** What a fold tick did. */
export type TreeFoldOutcome =
  /** The collection has no head, or the log has nothing past the floor. */
  | { readonly kind: "nothing-to-fold"; readonly floor: number }
  /** Nothing was published: `stop` held the fold end at the floor. */
  | { readonly kind: "refused"; readonly floor: number; readonly stop: TreeFoldStop }
  /** A publication attempt over `[floor, foldEnd)`; `stop` says why it ended early, if it did. */
  | {
      readonly kind: "published" | "cas-lost";
      readonly floor: number;
      readonly foldEnd: number;
      readonly publication: TreePublishOutcome;
      readonly stop?: TreeFoldStop;
    };

/** A fold that has captured the head and planned, and has not published. */
export interface TreePreparedFold {
  readonly kind: "prepared";
  readonly floor: number;
  readonly foldEnd: number;
  readonly plan: TreeFoldPlan;
  readonly stop?: TreeFoldStop;
  /** Publish the plan against the captured head. One attempt; nothing is retried. */
  publish(): Promise<TreeFoldOutcome & { readonly kind: "published" | "cas-lost" }>;
}

/** Calls charged for the head GET and each log or root GET. */
const GET_CHARGE = TREE_RETRIED_CALL_CHARGE;

/** A budget that never binds, as a safe integer. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

const mintSalt = (): string =>
  crypto.getRandomValues(new Uint8Array(TREE_CHUNK_SALT_BYTES)).toHex();

/** One log entry of the window, as read. */
interface WindowEntry {
  readonly seq: number;
  readonly entry: LogEntry;
  readonly bytes: number;
}

/**
 * The planner change of one entry. `docId` is the raw `doc_id` the
 * entry sets or deletes in the read path's fold, which keys rows by
 * that value.
 *
 * - `change`: a mutation of the row `mutation.id`.
 * - `skip`: the read path's fold skips the entry; it touches no row.
 * - `drop`: a `D` whose `doc_id` is not a string. It supersedes earlier
 *   entries for that `doc_id`, but no stored row can carry it.
 * - `invalid`: an `I`/`U` that is not a valid survivor.
 */
type EntryChange =
  | { readonly kind: "change"; readonly mutation: TreeMutation }
  | { readonly kind: "skip" }
  | { readonly kind: "drop"; readonly docId: unknown }
  | { readonly kind: "invalid"; readonly docId: unknown; readonly error: BaerlyError };

const passes = (check: () => void): boolean => {
  try {
    check();
    return true;
  } catch {
    return false;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The planner change of `entry`, validated as a survivor. The kinds of
 * invalid `I`/`U` and their remedies follow the writer's own rules:
 * a delete is admitted under the key-segment rule alone, an insert,
 * update or replace also needs a well-formed `_id`, and `replace`
 * forces the post-image's `_id`.
 */
const changeOf = ({ seq, entry }: WindowEntry, collection: string): EntryChange => {
  const docId: unknown = entry.doc_id;
  if (!isOwnCollection(entry.collection, collection) || docId === undefined) {
    return { kind: "skip" };
  }
  if (entry.op === "D") {
    // A `D` outside the document-ID domain matches no row; the planner
    // drops a string one, and no row can carry any other.
    return typeof docId === "string"
      ? { kind: "change", mutation: { id: docId, doc: null } }
      : { kind: "drop", docId };
  }
  if ((entry.op !== "I" && entry.op !== "U") || entry.after === undefined) {
    return { kind: "skip" };
  }
  const invalid = (state: string, remedy: string): EntryChange => ({
    kind: "invalid",
    docId,
    error: new BaerlyError(
      "InvalidResponse",
      `tree fold of collection ${JSON.stringify(collection)}: the log entry at seq ${seq} for doc_id ${JSON.stringify(docId)} ${state}, so the fold stops before it. ${remedy}`,
    ),
  });
  if (typeof docId !== "string" || !passes(() => assertStoredDocId(docId))) {
    return invalid(
      "has a doc_id that breaks the key-segment rule",
      "No app write can supersede it; an operator must supersede the entry from the operator CLI.",
    );
  }
  if (!passes(() => assertSnapshotDocId(docId))) {
    return invalid(
      "has a doc_id with an unpaired UTF-16 surrogate",
      "Delete that row; only a delete can supersede the entry.",
    );
  }
  const after: unknown = entry.after;
  if (isPlainObject(after) && after["_id"] !== docId) {
    return invalid(
      "has a post-image whose _id is absent or not its doc_id",
      "Replace the row with replace(id, doc), which sets _id to id.",
    );
  }
  let doc: CanonicalDocument;
  try {
    doc = canonicalDocument(after, `log seq ${seq}`);
  } catch (error) {
    return invalid(
      `has a post-image that is not a valid stored document (${(error as Error).message})`,
      "Replace or delete that row.",
    );
  }
  return { kind: "change", mutation: { id: docId, doc } };
};

/**
 * Rows and document bytes of the tree a depth-0 fold publishes, tracked
 * change by change from the captured root leaf.
 */
class DepthZeroTotals {
  readonly #docs: Map<string, number>;
  rows: number;
  bytes: number;

  constructor(root: DecodedTreeNode | null) {
    this.#docs = new Map();
    if (root !== null && root.node.kind === "leaf") {
      for (const doc of root.node.docs) {
        this.#docs.set(doc._id, encodeJsonBytes(doc).byteLength);
      }
    }
    this.rows = root?.node.root?.rows ?? 0;
    this.bytes = root?.node.root?.bytes ?? 0;
  }

  /** The totals after `mutation`, without applying it. */
  after(mutation: TreeMutation): { rows: number; bytes: number } {
    const old = this.#docs.get(mutation.id);
    return {
      rows: this.rows - (old === undefined ? 0 : 1) + (mutation.doc === null ? 0 : 1),
      bytes: this.bytes - (old ?? 0) + (mutation.doc?.bytes ?? 0),
    };
  }

  apply(mutation: TreeMutation): void {
    const totals = this.after(mutation);
    if (mutation.doc === null) {
      this.#docs.delete(mutation.id);
    } else {
      this.#docs.set(mutation.id, mutation.doc.bytes);
    }
    this.rows = totals.rows;
    this.bytes = totals.bytes;
  }
}

/**
 * The ceiling a depth-0 tree with these totals breaks, or `undefined`
 * when it may publish: the host's ceilings and the layout's depth-0 rule,
 * under which the tree is one root leaf.
 */
const depthZeroBreak = (
  rows: number,
  bytes: number,
  limit: TreeDepthZeroLimit,
  config: TreeConfig,
): "bytes" | "rows" | undefined => {
  const singleLeaf = config.steps.singleLeaf ?? singleLeafApplies;
  const { layout } = config;
  if (rows > limit.maxRows || (rows > 0 && rows > layout.singleLeafMaxRows)) {
    return "rows";
  }
  if (bytes > limit.maxBytes || (rows > 0 && !singleLeaf(rows, bytes, layout))) {
    return "bytes";
  }
  return undefined;
};

/**
 * `entry` as a log entry: a log body must be a JSON object, as
 * `walkLogRange` requires below the tail hint.
 *
 * @throws BaerlyError code="InvalidResponse" — it is not.
 */
const asLogEntry = (entry: unknown, prefix: string, seq: number): LogEntry => {
  if (!isPlainObject(entry)) {
    throw new BaerlyError(
      "InvalidResponse",
      `tree fold: log entry at ${logObjectKey(prefix, seq)} is not a JSON object`,
    );
  }
  return entry as unknown as LogEntry;
};

/** Log GETs the next batch may charge: the planner's headroom, pinned reserve included. */
const batchRoom = (planner: FoldPlanner, budget: number): number =>
  Math.floor((budget - planner.charge) / GET_CHARGE);

/** Emit the stuck-entry warning: counted, with the state and the remedy. */
const warnStuckEntry = (collection: string, seq: number): void => {
  ctxMetrics().counter("db.compact.stuck_entry_total", 1, { collection });
  const detail = `tree fold of collection ${JSON.stringify(collection)}: the log entry at seq ${seq} needs more storage calls than one invocation allows, so the fold keeps its floor and growth writes wait. Fold the collection with the operator CLI fold, which runs without a per-invocation storage-call limit.`;
  const sink = getCurrentContext()?.maintenance?.warn;
  if (sink !== undefined) {
    try {
      sink("fold_stuck_entry", { collection, seq, detail });
      return;
    } catch {
      // Fall through to the console line.
    }
  }
  console.warn(detail);
};

/**
 * Capture the head and root, read the log prefix and plan the fold,
 * without publishing. See the module comment.
 *
 * @returns a prepared fold to publish, or the outcome when there is
 *   nothing to publish.
 * @throws BaerlyError code="InvalidResponse" — the head or root is not a
 *   valid tree, or a log entry is not JSON.
 * @throws BaerlyError code="Internal" — a log entry is missing below the
 *   tail hint (or `knownTail`), or the planner's invariants fail.
 * @throws BaerlyError — a storage call fails, with its code.
 */
export const prepareTreeFold = async (
  input: TreeFoldInput,
): Promise<TreePreparedFold | (TreeFoldOutcome & { kind: "nothing-to-fold" | "refused" })> => {
  const { storage, prefix, signal } = input;
  const config = input.config ?? DEFAULT_TREE_CONFIG;
  const collection = collectionOfPrefix(prefix);
  const opts = signal === undefined ? undefined : { signal };

  const head: TreeHead | null = await readTreeHead(storage, prefix, opts);
  if (head === null) {
    return { kind: "nothing-to-fold", floor: 0 };
  }
  // Read after the head GET: until a storage call has charged it, the
  // ledger reports no limit. What it has left is then net of the head
  // GET, so only an explicit budget is charged for it below.
  const ledgerRoom =
    input.budget === undefined ? currentRequestLedger()?.storageRemaining() : undefined;
  const budget = Math.max(0, Math.min(input.budget ?? ledgerRoom ?? UNBOUNDED, UNBOUNDED));
  const floor = head.json.log_seq_start;
  const refused = (stop: TreeFoldStop) => ({ kind: "refused" as const, floor, stop });
  const headCharge = input.budget === undefined ? 0 : GET_CHARGE;
  if (head.root !== null && headCharge + GET_CHARGE > budget) {
    return refused({ reason: "budget", seq: floor });
  }
  const root = await readTreeRoot(storage, head, config, opts);

  if (input.depthZero !== undefined) {
    const totals = new DepthZeroTotals(root);
    const broken =
      root !== null && root.node.kind !== "leaf"
        ? "rows"
        : depthZeroBreak(totals.rows, totals.bytes, input.depthZero, config);
    if (broken !== undefined) {
      return refused({
        reason: "deferred",
        seq: floor,
        gate: "pre-fold",
        dimension: broken,
        rows: totals.rows,
        bytes: totals.bytes,
      });
    }
  }

  const minted = head.json.proto_tree === undefined ? (input.mintChunkSalt ?? mintSalt)() : null;
  const chunkSalt = minted ?? head.json.proto_tree!.chunk_salt;
  const chunkKey =
    minted === null
      ? (await importTreeChunkKey(head))!
      : await importChunkKey(Uint8Array.fromHex(minted));
  const planner = new FoldPlanner({
    prefix,
    root,
    chunkKey,
    get: async (key) => {
      const got = await storage.get(key, opts);
      return got?.body ?? null;
    },
    config,
    budget,
    spent: headCharge + (root === null ? 0 : GET_CHARGE),
  });
  const totals = input.depthZero === undefined ? null : new DepthZeroTotals(root);

  const denseEnd = Math.max(floor, head.json.tail_hint, input.knownTail ?? 0);
  const entryBytes: number[] = [];
  /** Raw `doc_id`s whose latest entry so far is an invalid survivor. */
  const pending = new Set<unknown>();
  /** Whether the totals after the last accepted entry break the depth-0 byte ceiling. */
  let overBytes = false;
  /** While a checkpoint is pinned, the stop a fall back to it reports; its `seq` is the pinned end. */
  let pinned: TreeFoldStop | null = null;
  let stop: TreeFoldStop | undefined;
  let next = floor;
  let atTail = false;

  /** Pin the checkpoint before `held.seq`, unless an earlier one is pinned. */
  const hold = (held: TreeFoldStop): void => {
    if (pinned === null) {
      planner.pin();
      pinned = held;
    }
  };
  /** Release the pin once the current checkpoint may publish. */
  const release = (): void => {
    if (pinned !== null && pending.size === 0 && !overBytes) {
      planner.unpin();
      pinned = null;
    }
  };
  /** Accept an entry that changes no row; returns whether the fold reads on. */
  const skip = (item: WindowEntry): boolean => {
    if (!planner.skip()) {
      stop = { reason: "budget", seq: item.seq };
      return false;
    }
    entryBytes.push(item.bytes);
    return true;
  };

  /** Add one entry's change; returns whether the fold reads on. */
  const addEntry = async (item: WindowEntry): Promise<boolean> => {
    const change = changeOf(item, collection);
    if (change.kind === "invalid") {
      hold({ reason: "invalid-entry", seq: item.seq, error: change.error });
      pending.add(change.docId);
      return skip(item);
    }
    if (change.kind !== "change") {
      if (!skip(item)) {
        return false;
      }
      if (change.kind === "drop") {
        pending.delete(change.docId);
        release();
      }
      return true;
    }
    const { mutation } = change;
    if (totals !== null) {
      const after = totals.after(mutation);
      const broken = depthZeroBreak(after.rows, after.bytes, input.depthZero!, config);
      const deferred = { reason: "deferred", seq: item.seq, gate: "rebuild", ...after } as const;
      if (broken === "rows") {
        stop = { ...deferred, dimension: broken };
        return false;
      }
      if (broken === "bytes") {
        hold({ ...deferred, dimension: broken });
      }
    }
    if (!(await planner.add(mutation))) {
      stop =
        planner.accepted === 0
          ? { reason: "stuck-entry", seq: item.seq }
          : { reason: "budget", seq: item.seq };
      return false;
    }
    if (totals !== null) {
      totals.apply(mutation);
      overBytes = depthZeroBreak(totals.rows, totals.bytes, input.depthZero!, config) === "bytes";
    }
    entryBytes.push(item.bytes);
    pending.delete(mutation.id);
    release();
    return true;
  };

  reading: while (!atTail) {
    const first = next === floor;
    const room = batchRoom(planner, budget);
    const size =
      next < denseEnd ? Math.min(first ? 1 : MAX_PARALLEL_LOG_READS, denseEnd - next, room) : 1;
    if (room < 1 || !planner.spend(size * GET_CHARGE)) {
      stop = { reason: "budget", seq: next };
      break;
    }
    let batch: WindowEntry[];
    if (next < denseEnd) {
      const read = await walkLogRangeWithBytes(storage, prefix, next, next + size, opts);
      batch = read.map(({ entry, bytes }, i) => ({ seq: next + i, entry, bytes }));
    } else {
      let bytes = 0;
      const probe = await probeTailChunk(storage, prefix, next, {
        cap: 1,
        ...(signal !== undefined && { signal }),
        onBody: (n) => {
          bytes = n;
        },
      });
      atTail = probe.kind === "exact";
      batch = probe.entries.map((entry) => ({
        seq: next,
        entry: asLogEntry(entry, prefix, next),
        bytes,
      }));
    }
    for (const item of batch) {
      if (!(await addEntry(item))) {
        break reading;
      }
      next = item.seq + 1;
    }
  }

  if (pinned !== null) {
    // The window or the budget ran out before every invalid survivor was
    // superseded and the totals were back within the byte ceiling: fall
    // back to the prefix before the first entry that pinned.
    planner.rollback();
    stop = pinned;
  }
  const foldEnd = floor + planner.accepted;
  const plan = planner.plan;
  if (foldEnd === floor || plan === null) {
    if (stop === undefined) {
      return { kind: "nothing-to-fold", floor };
    }
    if (stop.reason === "stuck-entry") {
      warnStuckEntry(collection, stop.seq);
    }
    return refused(stop);
  }
  if (input.depthZero !== undefined && (plan.tree?.root.level ?? 0) !== 0) {
    throw new BaerlyError(
      "Internal",
      `tree fold of collection ${JSON.stringify(collection)}: a depth-0 fold planned a root above level 0`,
    );
  }
  const folded = entryBytes.slice(0, foldEnd - floor);
  const meanEntryBytes = Math.round(folded.reduce((sum, n) => sum + n, 0) / folded.length);
  return {
    kind: "prepared",
    floor,
    foldEnd,
    plan,
    ...(stop !== undefined && { stop }),
    publish: async () => {
      const publication = await publishTree({
        storage,
        prefix,
        head,
        root,
        plan,
        floor: foldEnd,
        chunkSalt,
        meanEntryBytes,
        config,
        ...(signal !== undefined && { signal }),
      });
      return {
        kind: publication.kind,
        floor,
        foldEnd,
        publication,
        ...(stop !== undefined && { stop }),
      };
    },
  };
};

/**
 * One write-tick fold: {@link prepareTreeFold}, then publish what it
 * planned. A `cas-lost` outcome is a value; the fold deletes nothing and
 * a later tick re-runs from the head it then captures.
 *
 * @throws BaerlyError — as {@link prepareTreeFold} and `publishTree`.
 */
export const foldTree = async (input: TreeFoldInput): Promise<TreeFoldOutcome> => {
  const prepared = await prepareTreeFold(input);
  return prepared.kind === "prepared" ? prepared.publish() : prepared;
};
