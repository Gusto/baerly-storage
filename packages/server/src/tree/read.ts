/**
 * Reader of the prototype tree: point, range, count and complete-scan
 * reads of one collection.
 *
 * A read sees the immutable base the head names plus the unfolded log
 * tail `[log_seq_start, tail)`, applied last-write-wins per `_id` over
 * the base: a `D` in the tail hides a row a base leaf still holds, and a
 * later `I` or `U` brings it back. Every read runs in this order:
 *
 * 1. the head GET, validated as a tree head (`./head.ts`);
 * 2. the root GET (none for an empty tree), strictly decoded as a root
 *    against the head's floor and totals;
 * 3. the snapshot read path's head check on the log alone
 *    (`read-admission.ts`), without its snapshot bounds;
 * 4. the tail: the strict walk `[log_seq_start, tail_hint)` and the
 *    forward probe past it, charged by the read envelope's staged tail
 *    charging exactly as on the snapshot read path;
 * 5. for a range, count or complete scan, the materialization and scan
 *    admission checks;
 * 6. the base GETs, each node strictly decoded against the parent entry
 *    that routed to it before any of its rows or entries are used.
 *
 * Routing uses only `lo` and `hi`: a read descends into the entries
 * whose `[lo, hi]` intersects what it asks for. So a point miss fetches
 * at most the one leaf whose range contains the `_id`, a range fetches
 * only the nodes it intersects, and a miss outside every range or an
 * empty tree fetches no leaf. A point read whose `_id` the tail decides
 * fetches no base node at all.
 *
 * Static operation bounds count the head and base GETs; the tail costs
 * what it costs on the snapshot read path:
 *
 * - point: `2 + depth` ({@link treePointReadBound});
 * - complete scan: `2 + Σ N_ℓ` over levels `0..depth−1`, where
 *   `N_0 = ⌊bytes / (leafMinBytes + 1)⌋ + 1` and
 *   `N_ℓ = ⌊N_{ℓ−1} / branchFanoutMin⌋ + 1`, from the root's `bytes` and
 *   `level` alone ({@link treeScanReadBound}). Layout validation makes
 *   these upper bounds on every level of a canonical tree.
 *
 * Scan admission: a range, count or complete scan (every `.where()` is a
 * complete scan) charges the base GETs it may still issue at
 * {@link TREE_RETRIED_CALL_CHARGE} calls each, because the request
 * ledger charges every attempt as it is issued. When that is more than
 * the request has left after the head, root and tail, the read refuses
 * with `CapacityExceeded` before its first base GET. The check reads only
 * authenticated root metadata, so two buckets with the same root and the
 * same ledger left decide alike, and an admitted scan cannot run out of
 * ledger partway through its base. Being an upper bound, it may refuse a
 * scan whose leaves are fuller than the minimum.
 *
 * The bound holds for canonical trees, which every writer of this format
 * builds. The decoder checks each node against its parent entry but not a
 * leaf's minimum fill, which needs the leaf's neighbours, so a
 * non-canonical tree of underfilled leaves can be admitted and then run
 * out of ledger partway through its base. That read still fails with
 * `CapacityExceeded`, from the request ledger rather than up front, and
 * returns no rows. A point read has no scan admission check: its bound is
 * at most `2 + TREE_MAX_LEVEL` GETs, which every host's ledger covers at
 * every attempt.
 *
 * Missing node. GC deletes a node only once no current root reaches it,
 * so a node a read routed to from the head it captured can be gone by
 * the time its GET lands, when a fold moved the root and GC ran in
 * between. A node GET, the root's included, that returns not-found is
 * issued once more, which tells a transient miss from a real one. If it
 * is still missing, the read re-reads the head. The re-GET and the head
 * re-read are each admitted first, at every attempt, against the
 * request ledger; without room the read refuses with `MaintenancePending`
 * rather than meet the ledger's `CapacityExceeded`. Then:
 *
 * - the head names the same root: the node is corrupt, `InvalidResponse`
 *   from the decoder's `present` check;
 * - the root moved and the view has not restarted: the view restarts
 *   once from the new head, re-reading its root and tail, then runs the
 *   read again. The restart is admitted only when the request ledger has
 *   room for its GETs, every attempt charged: the root GET first, then,
 *   from the new root, the head check's log calls and the base GETs the
 *   read may issue (`depth` for a point read, the scan bound for a range,
 *   count or scan);
 * - the root moved again after the restart, or the ledger has no room
 *   for it: `MaintenancePending` with `retryAfter`, so the caller retries
 *   from a fresh head instead of the read restarting without bound.
 *
 * A restart replaces the view's head, root and tail, and a view restarts
 * at most once over its life. Every GET of a batch settles before the
 * read acts on a missing node, so no call of the abandoned attempt
 * outlives it.
 *
 * Reads are pure: they never PUT or DELETE, run maintenance or repair
 * anything, and a refusal writes nothing.
 */
import {
  BaerlyError,
  type DocumentData,
  type LogEntry,
  MAINTENANCE_PENDING_RETRY_AFTER_SECONDS,
  type Storage,
} from "@baerly/protocol";
import { foldLogEntriesOnto, walkLogRange } from "../log-walk.ts";
import { probeReadTail } from "../log-tail.ts";
import { assertPostImageIdentity } from "../post-image-identity.ts";
import {
  currentReadEnvelope,
  ReadBudget,
  type ReadEnvelope,
  remainingStorageCalls,
} from "../read-admission.ts";
import { assertSnapshotDocId, compareDocIds } from "../snapshot-doc-id.ts";
import { TREE_READ_PARALLEL_GETS, TREE_RETRIED_CALL_CHARGE } from "./constants.ts";
import { assertRootMatchesHead, readTreeHead, type TreeHead } from "./head.ts";
import { collectionOfPrefix, treeNodeKey } from "./key.ts";
import {
  DEFAULT_TREE_CONFIG,
  type MissingNodeAction,
  type MissingNodeSeen,
  type TreeConfig,
  type TreeLayout,
} from "./layout.ts";
import {
  type DecodedTreeNode,
  decodeNode,
  type TreeChildEntry,
  type TreeDocument,
  type TreeNodeExpectation,
} from "./node-codec.ts";

// ---------------------------------------------------------------------
// Static bounds
// ---------------------------------------------------------------------

/** Head and base GETs of a point read on a tree of depth `depth`. */
export const treePointReadBound = (depth: number): number => 2 + depth;

/**
 * Base GETs a complete scan of a non-empty tree may issue below its
 * root: `Σ N_ℓ` for levels `0..depth−1`, with
 * `N_0 = ⌊bytes / (leafMinBytes + 1)⌋ + 1` and
 * `N_ℓ = ⌊N_{ℓ−1} / branchFanoutMin⌋ + 1`. Zero at depth 0, whose root
 * is the only leaf.
 */
export const treeScanBaseCalls = (bytes: number, depth: number, layout: TreeLayout): number => {
  let total = 0;
  let nodes = Math.floor(bytes / (layout.leafMinBytes + 1)) + 1;
  for (let level = 0; level < depth; level++) {
    total += nodes;
    nodes = Math.floor(nodes / layout.branchFanoutMin) + 1;
  }
  return total;
};

/** Head and base GETs of a complete scan of a non-empty tree: `2 + treeScanBaseCalls`. */
export const treeScanReadBound = (bytes: number, depth: number, layout: TreeLayout): number =>
  2 + treeScanBaseCalls(bytes, depth, layout);

// ---------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------

/**
 * Bounds of a range read in `utf8-scalar-v1` order: at most one lower
 * bound (`gt` or `gte`) and one upper bound (`lt` or `lte`). An absent
 * side is unbounded, so `{}` is the whole collection. A bound need not be
 * a valid `_id`, only a well-formed string.
 */
export interface TreeRange {
  readonly gt?: string;
  readonly gte?: string;
  readonly lt?: string;
  readonly lte?: string;
}

const aboveLower = (id: string, range: TreeRange): boolean =>
  (range.gt === undefined || compareDocIds(id, range.gt) > 0) &&
  (range.gte === undefined || compareDocIds(id, range.gte) >= 0);

const belowUpper = (id: string, range: TreeRange): boolean =>
  (range.lt === undefined || compareDocIds(id, range.lt) < 0) &&
  (range.lte === undefined || compareDocIds(id, range.lte) <= 0);

const inRange = (id: string, range: TreeRange): boolean =>
  aboveLower(id, range) && belowUpper(id, range);

/** The entries whose `[lo, hi]` intersects `range`, in order. */
export const entriesIntersecting = (
  children: readonly TreeChildEntry[],
  range: TreeRange,
): readonly TreeChildEntry[] =>
  children.filter((entry) => aboveLower(entry.hi, range) && belowUpper(entry.lo, range));

/**
 * @throws BaerlyError code="InvalidConfig" — two lower or two upper
 *   bounds, or a bound that is not a well-formed string.
 */
const assertRange = (range: TreeRange): void => {
  if (range.gt !== undefined && range.gte !== undefined) {
    throw new BaerlyError("InvalidConfig", "tree range read: pass at most one of gt and gte");
  }
  if (range.lt !== undefined && range.lte !== undefined) {
    throw new BaerlyError("InvalidConfig", "tree range read: pass at most one of lt and lte");
  }
  for (const name of ["gt", "gte", "lt", "lte"] as const) {
    const bound: unknown = range[name];
    if (bound !== undefined && (typeof bound !== "string" || !bound.isWellFormed())) {
      throw new BaerlyError(
        "InvalidConfig",
        `tree range read: ${name} must be a string with no unpaired surrogate`,
      );
    }
  }
};

// ---------------------------------------------------------------------
// Tail
// ---------------------------------------------------------------------

/** What the tail step reads from. */
export interface TreeTailRead {
  readonly storage: Storage;
  readonly head: TreeHead;
  /** The collection name, the last segment of the head's prefix. */
  readonly collection: string;
  /** The read's admission state, which charges each tail body. */
  readonly budget: ReadBudget;
}

/** The unfolded log tail of one read. */
export interface TreeTail {
  /** The first empty log slot the probe found. */
  readonly tail: number;
  /** Log entries the tail read loaded, strict range and probe together. */
  readonly entries: number;
  /**
   * The last write per `_id` in `[log_seq_start, tail)`: its post-image,
   * or `null` for a delete. An `_id` the tail does not touch is absent.
   */
  readonly overlay: ReadonlyMap<string, DocumentData | null>;
}

/**
 * Seeds the fold below; never a row. Compared by identity, so no
 * post-image can equal it.
 */
const UNTOUCHED: DocumentData = Object.freeze({ _id: "" });

/** Whether `id` is inside the document-ID domain (`assertSnapshotDocId`). */
const isDocId = (id: string): boolean => {
  try {
    assertSnapshotDocId(id);
    return true;
  } catch {
    return false;
  }
};

/**
 * The last write per `_id` of `entries`, by the read path's own fold
 * (`foldLogEntriesOnto`), so the tail skips exactly what it skips:
 * another collection's entries, an entry with no `doc_id`, an `I`/`U`
 * with no `after`. Every `_id` is seeded with {@link UNTOUCHED} first, so
 * after the fold an `_id` still holding it has no applied entry, one
 * the fold removed was last deleted, and any other holds its post-image.
 *
 * Each surviving `_id` must be in the document-ID domain, as a tree fold
 * requires of the post-images it stores: a surviving post-image outside
 * it is stored data this kernel never writes, and a delete of one changes
 * nothing, since no base row can carry that `_id`, so it is dropped.
 *
 * @throws BaerlyError code="InvalidResponse" — a surviving post-image is
 *   not a document with its own matching `_id`, or that `_id` is outside
 *   the document-ID domain.
 */
const overlayOf = (
  entries: readonly LogEntry[],
  collection: string,
): Map<string, DocumentData | null> => {
  const folded = new Map<string, DocumentData>();
  for (const entry of entries) {
    if (typeof entry.doc_id === "string") {
      folded.set(entry.doc_id, UNTOUCHED);
    }
  }
  const ids = [...folded.keys()];
  foldLogEntriesOnto(folded, entries, { collection });
  const overlay = new Map<string, DocumentData | null>();
  for (const id of ids) {
    const doc = folded.get(id);
    if (doc === UNTOUCHED) {
      continue;
    }
    if (!isDocId(id)) {
      if (doc === undefined) {
        continue;
      }
      const seq = entries.findLast((entry) => entry.after === doc)?.seq;
      throw new BaerlyError(
        "InvalidResponse",
        `log seq ${seq}: the post-image's _id ${JSON.stringify(id)} is outside the document-ID ` +
          `domain; this kernel never writes one, so the read was refused.`,
      );
    }
    if (doc !== undefined) {
      assertPostImageIdentity(id, doc, "InvalidResponse");
    }
    overlay.set(id, doc ?? null);
  }
  return overlay;
};

/**
 * Read the unfolded tail of `read.head`: walk `[log_seq_start,
 * tail_hint)`, which must be dense, then probe from
 * `max(log_seq_start, tail_hint)` to the first empty slot, charging each
 * body to the read's budget before it is decoded.
 *
 * @throws BaerlyError code="CapacityExceeded" — the tail is over the
 *   read envelope or the request ledger.
 * @throws BaerlyError code="Internal" — a hole in the strict range.
 * @throws BaerlyError code="InvalidResponse" — a malformed log entry.
 */
export const readTreeTail = async (read: TreeTailRead): Promise<TreeTail> => {
  const { storage, head, collection, budget } = read;
  const floor = head.json.log_seq_start;
  const hint = head.json.tail_hint;
  const strict = await walkLogRange(storage, head.prefix, floor, hint, {
    onBody: budget.chargeTailBody,
  });
  const probe = await probeReadTail(storage, head.prefix, Math.max(floor, hint), {
    pool: budget.requestPool,
    onBody: budget.chargeTailBody,
    refusal: budget.probeRefusal,
  });
  const entries = [...strict, ...probe.entries];
  return { tail: probe.tail, entries: entries.length, overlay: overlayOf(entries, collection) };
};

// ---------------------------------------------------------------------
// View
// ---------------------------------------------------------------------

/** Where a read runs. */
export interface TreeReadTarget {
  readonly storage: Storage;
  /** The collection prefix `P` (the `current.json` key without `/current.json`). */
  readonly prefix: string;
  /** The tree configuration; tests pass a small layout or a mutant here. */
  readonly config?: TreeConfig;
}

/**
 * A decoded base document as a row. The decoder built it for this read
 * alone, so the caller may own it; only the type is readonly.
 */
const asRow = (doc: TreeDocument): DocumentData => doc as unknown as DocumentData;

const OUTGROWN =
  "Do not retry unchanged: delete or shrink rows, or export the collection with baerly admin dump.";

const READ_AGAIN =
  "Retry after the delay in retryAfter (Retry-After header, seconds): maintenance replaced the " +
  "data this read was reading, and a new read starts from the current data.";

/**
 * What a read does about a node still missing after its re-GET: report
 * corruption when the root has not moved, restart once when it has, and
 * refuse when it moves again after that restart.
 */
const missingNodeAction = (seen: MissingNodeSeen): MissingNodeAction => {
  if (!seen.rootMoved) {
    return "corrupt";
  }
  return seen.restarted ? "refuse" : "restart";
};

/**
 * The retriable refusal of a read that found a node missing, as it does
 * when maintenance replaces the tree under it. `bound` says why it did
 * not go on: no room to re-GET the node or re-read the head, the root
 * moved again after the restart, or no room for the restart. `state`
 * says the same in words.
 */
const readAgainRefusal = (
  collection: string,
  bound: "missingNodeStorageCalls" | "rootMovedAgain" | "restartStorageCalls",
  state: string,
): BaerlyError =>
  new BaerlyError(
    "MaintenancePending",
    `this read of collection ${JSON.stringify(collection)} was refused and returned no rows: ` +
      `${state}. Retry after ${MAINTENANCE_PENDING_RETRY_AFTER_SECONDS}s.`,
    {
      resolution: READ_AGAIN,
      retryAfter: MAINTENANCE_PENDING_RETRY_AFTER_SECONDS,
      cause: { bound },
    },
  );

/**
 * A node GET that found nothing, twice. Thrown inside a read attempt and
 * always caught by the view, which re-reads the head to decide; never
 * escapes this module.
 */
class MissingNode {
  readonly key: string;
  readonly expected: TreeNodeExpectation;
  /** The head whose root routed to the node. */
  readonly head: TreeHead;

  constructor(key: string, expected: TreeNodeExpectation, head: TreeHead) {
    this.key = key;
    this.expected = expected;
    this.head = head;
  }
}

/** Which base GETs a read may issue, for admitting its restart. */
type ReadShape = "open" | "point" | "scan";

/** One captured state of a view: the head, its validated root and its tail. */
interface ViewState {
  readonly head: TreeHead | null;
  readonly root: DecodedTreeNode | null;
  readonly tail: TreeTail;
  readonly budget: ReadBudget;
}

const NO_TAIL: TreeTail = Object.freeze({ tail: 0, entries: 0, overlay: new Map() });

/** An open read: the head, its validated root and its tail. */
export class TreeView {
  readonly #storage: Storage;
  readonly #prefix: string;
  readonly #config: TreeConfig;
  readonly #collection: string;
  readonly #envelope: ReadEnvelope;
  #state: ViewState;
  #restarted = false;

  private constructor(target: TreeReadTarget, budget: ReadBudget, envelope: ReadEnvelope) {
    this.#storage = target.storage;
    this.#prefix = target.prefix;
    this.#config = target.config ?? DEFAULT_TREE_CONFIG;
    this.#collection = collectionOfPrefix(target.prefix);
    this.#envelope = envelope;
    this.#state = { head: null, root: null, tail: NO_TAIL, budget };
  }

  /** The tree head, or `null` when the collection has no `current.json`. */
  get head(): TreeHead | null {
    return this.#state.head;
  }

  /** The validated root, or `null` for an empty tree. */
  get root(): DecodedTreeNode | null {
    return this.#state.root;
  }

  get tail(): TreeTail {
    return this.#state.tail;
  }

  /**
   * Open a read: GET and validate the head, GET and strictly decode its
   * root, run the snapshot read path's head check on the log alone, then
   * read the tail.
   *
   * The head check (`ReadBudget.admitHead`) refuses from the head when
   * the strict log range `[log_seq_start, tail_hint)` alone is over the
   * tail or materialization bound, or when that range and the probe's
   * closing empty slot are more storage calls than the request has left.
   * It runs after the root GET, so the root is already charged and is
   * not counted again. Its snapshot bounds do not apply: a tree read loads
   * no monolithic snapshot, and only a range, count or scan materializes
   * the base, which {@link range} admits.
   *
   * A root missing after its re-GET is handled as the module header's
   * "Missing node" says.
   *
   * @throws BaerlyError code="InvalidResponse" — a malformed head, root
   *   or log entry, or a root missing while the head still names it.
   * @throws BaerlyError code="CapacityExceeded" — the tail does not fit
   *   the read envelope or the request ledger.
   * @throws BaerlyError code="MaintenancePending" — maintenance replaced
   *   the tree under the read and it could not read again; retriable.
   */
  static async open(target: TreeReadTarget): Promise<TreeView> {
    const collection = collectionOfPrefix(target.prefix);
    const envelope = currentReadEnvelope();
    const view = new TreeView(target, new ReadBudget(collection, envelope), envelope);
    const head = await readTreeHead(target.storage, target.prefix);
    await view.#read("open", () => Promise.resolve(), head);
    return view;
  }

  /** The tree's depth (the root's level), or `null` for an empty tree. */
  get depth(): number | null {
    return this.root?.node.level ?? null;
  }

  /**
   * The row with `_id` `id`, or `undefined`. A tail write to `id`
   * decides without a base GET; otherwise the read descends the one path
   * whose ranges contain `id`, if any.
   *
   * @throws BaerlyError code="InvalidConfig" — `id` is not a valid `_id`.
   * @throws BaerlyError code="InvalidResponse" — a fetched node fails
   *   strict decode, or is missing while the head still names its root.
   * @throws BaerlyError code="MaintenancePending" — maintenance replaced
   *   the tree under the read and it could not read again; retriable.
   */
  async get(id: string): Promise<DocumentData | undefined> {
    assertSnapshotDocId(id);
    return this.#read("point", async () => {
      const written = this.tail.overlay.get(id);
      if (written !== undefined) {
        return written ?? undefined;
      }
      if (this.#restarted && this.root !== null) {
        this.#admitRestart(this.#state.budget, this.root.node.level * TREE_RETRIED_CALL_CHARGE);
      }
      const [doc] = await this.#base({ gte: id, lte: id });
      return doc;
    });
  }

  /**
   * The rows whose `_id` lies in `range`, in `utf8-scalar-v1` order,
   * after scan admission. An answer over the read envelope's output bound
   * is refused whole.
   *
   * @throws BaerlyError code="InvalidConfig" — a malformed range.
   * @throws BaerlyError code="CapacityExceeded" — the base rows and tail
   *   entries are over the materialization bound, or the scan bound is
   *   over what the request has left, and nothing below the root was
   *   fetched; or the answer is over the output bound.
   * @throws BaerlyError code="InvalidResponse" — a fetched node fails
   *   strict decode, or is missing while the head still names its root.
   * @throws BaerlyError code="MaintenancePending" — maintenance replaced
   *   the tree under the read and it could not read again; retriable.
   */
  async range(range: TreeRange): Promise<DocumentData[]> {
    const rows = await this.#rows(range);
    this.#state.budget.admitOutput(rows.length);
    return rows;
  }

  /** Every row, in `utf8-scalar-v1` order: {@link range} with no bounds. */
  scan(): Promise<DocumentData[]> {
    return this.range({});
  }

  /**
   * How many rows lie in `range` (the whole collection by default), after
   * scan admission. The answer is one number, so it has no output bound.
   */
  async count(range: TreeRange = {}): Promise<number> {
    const rows = await this.#rows(range);
    return rows.length;
  }

  /** The rows of {@link range}, before the output bound. */
  #rows(range: TreeRange): Promise<DocumentData[]> {
    assertRange(range);
    return this.#read("scan", async () => {
      this.#admitScan();
      const overlay = this.tail.overlay;
      const rows: (readonly [string, DocumentData])[] = [];
      for (const doc of await this.#base(range)) {
        const id = doc["_id"] as string;
        if (!overlay.has(id)) {
          rows.push([id, doc]);
        }
      }
      const based = rows.length;
      for (const [id, doc] of overlay) {
        if (doc !== null && inRange(id, range)) {
          rows.push([id, doc]);
        }
      }
      if (rows.length > based) {
        rows.sort(([a], [b]) => compareDocIds(a, b));
      }
      return rows.map(([, doc]) => doc);
    });
  }

  /**
   * Run `attempt` against the view's state, loading `load` first when
   * given. A missing node re-reads the head ({@link #afterMissing}); a
   * restart loads the new head, admitted for `shape`, and runs `attempt`
   * again.
   */
  async #read<T>(shape: ReadShape, attempt: () => Promise<T>, load?: TreeHead | null): Promise<T> {
    let pending = load;
    let restart = false;
    for (;;) {
      try {
        if (pending !== undefined) {
          await this.#load(pending, restart ? shape : undefined);
          pending = undefined;
        }
        return await attempt();
      } catch (error) {
        if (this.#restarted && error instanceof BaerlyError && error.code === "CapacityExceeded") {
          const cause = error.cause as { refused?: boolean; bound?: string } | undefined;
          if (
            cause?.refused === true ||
            cause?.bound === "headStorageCalls" ||
            cause?.bound === "probeStorageCalls"
          ) {
            throw readAgainRefusal(
              this.#collection,
              "restartStorageCalls",
              "maintenance replaced the tree it was reading, and this request ran out of " +
                "storage calls while reading it again",
            );
          }
        }
        if (!(error instanceof MissingNode)) {
          throw error;
        }
        pending = await this.#afterMissing(error);
        restart = true;
      }
    }
  }

  /**
   * Decide on a node still missing after its re-GET: re-read the head,
   * then report corruption, refuse, or return the head to restart from.
   *
   * @throws BaerlyError code="InvalidResponse" — the root has not moved.
   * @throws BaerlyError code="MaintenancePending" — the root moved again
   *   after the view restarted.
   */
  async #afterMissing(missing: MissingNode): Promise<TreeHead | null> {
    this.#admitMissingNodeCall("re-read the head");
    const head = await readTreeHead(this.#storage, this.#prefix);
    const decide = this.#config.steps.missingNodeAction ?? missingNodeAction;
    const action = decide({
      rootMoved: (head?.root ?? null) !== missing.head.root,
      restarted: this.#restarted,
    });
    if (action === "corrupt") {
      // The decoder's `present` check refuses a missing body.
      await decodeNode(missing.key, null, missing.expected, this.#config);
      throw new BaerlyError("Internal", `tree node ${missing.key}: decoded a missing body`);
    }
    if (action === "refuse") {
      throw readAgainRefusal(
        this.#collection,
        "rootMovedAgain",
        "maintenance replaced the tree it was reading, and it moved again after the read restarted",
      );
    }
    this.#restarted = true;
    return head;
  }

  /**
   * Capture `head`: GET and strictly decode its root, run the head check
   * and read the tail. On a restart, `restart` is the shape of the read
   * being restarted, and the restart is admitted against the ledger
   * before the root GET and again, with the new root, before the tail.
   */
  async #load(head: TreeHead | null, restart?: ReadShape): Promise<void> {
    const budget = new ReadBudget(this.#collection, this.#envelope);
    if (head === null) {
      this.#state = { head: null, root: null, tail: NO_TAIL, budget };
      return;
    }
    // The head check's calls: the strict range and the probe's closing slot.
    const logCalls =
      (1 + Math.max(0, head.json.tail_hint - head.json.log_seq_start)) * TREE_RETRIED_CALL_CHARGE;
    if (restart !== undefined) {
      this.#admitRestart(budget, (head.root === null ? 0 : TREE_RETRIED_CALL_CHARGE) + logCalls);
    }
    const root = await this.#fetchRoot(head);
    if (restart !== undefined && root !== null) {
      this.#admitRestart(
        budget,
        logCalls + this.#baseCalls(root, restart) * TREE_RETRIED_CALL_CHARGE,
      );
    }
    // A tree head's `snapshot` is null, so the call count is the strict
    // range plus the probe's closing slot.
    budget.admitHead({ ...head.json, snapshot_rows: 0, snapshot_bytes: 0 });
    const readTail = this.#config.steps.readTail ?? readTreeTail;
    const tail = await readTail({
      storage: this.#storage,
      head,
      collection: this.#collection,
      budget,
    });
    this.#state = { head, root, tail, budget };
  }

  /** Base GETs below `root` a read of `shape` may issue. */
  #baseCalls(root: DecodedTreeNode, shape: ReadShape): number {
    const depth = root.node.level;
    if (shape === "open") {
      return 0;
    }
    if (shape === "point") {
      return depth;
    }
    return treeScanBaseCalls(root.node.root!.bytes, depth, this.#config.layout);
  }

  /**
   * Admit one GET a missing node calls for, the node's re-GET or the
   * head re-read, at every attempt, so a healthy bucket racing GC never
   * meets the request ledger's `CapacityExceeded` here.
   *
   * @throws BaerlyError code="MaintenancePending" — the GET's charge is
   *   more than the request has left.
   */
  #admitMissingNodeCall(what: string): void {
    const charged = TREE_RETRIED_CALL_CHARGE;
    const left = remainingStorageCalls(this.#envelope.requestPool ?? "internal");
    const admits = this.#config.steps.admitsMissingNodeCall ?? ((c: number, l: number) => c <= l);
    if (!admits(charged, left)) {
      throw readAgainRefusal(
        this.#collection,
        "missingNodeStorageCalls",
        `a node it was reading is missing, as when maintenance replaces the tree, and this ` +
          `request has ${left} storage calls left, under the ${charged} it needs to ${what}`,
      );
    }
  }

  /**
   * Admit a restart whose remaining GETs need `charged` storage calls.
   *
   * @throws BaerlyError code="MaintenancePending" — more than the request
   *   has left.
   */
  #admitRestart(budget: ReadBudget, charged: number): void {
    const left = remainingStorageCalls(budget.requestPool);
    const admits = this.#config.steps.admitsRestart ?? ((c: number, l: number) => c <= l);
    if (!admits(charged, left)) {
      throw readAgainRefusal(
        this.#collection,
        "restartStorageCalls",
        `maintenance replaced the tree it was reading, and reading it again needs up to ` +
          `${charged} storage calls, over the ${left} this request has left`,
      );
    }
  }

  /**
   * Admit a range, count or scan before its first base GET: its base rows
   * (the head's `snapshot_rows`) plus the tail entries it loaded against
   * the materialization bound, then the scan bound against the ledger.
   *
   * @throws BaerlyError code="CapacityExceeded" — over the
   *   materialization bound, or the base GETs a complete scan may issue,
   *   at every attempt, are more than the request has left.
   */
  #admitScan(): void {
    if (this.head !== null) {
      // A budget bounded by materialization alone, so the snapshot bounds
      // the head check skips stay skipped here too.
      new ReadBudget(this.#collection, {
        maxMaterializedRows: this.#envelope.maxMaterializedRows,
      }).admitSnapshot({ ...this.head.json, snapshot_bytes: 0 }, this.tail.entries);
    }
    const root = this.root;
    const charged =
      root === null
        ? 0
        : treeScanBaseCalls(root.node.root!.bytes, root.node.level, this.#config.layout) *
          TREE_RETRIED_CALL_CHARGE;
    if (this.#restarted) {
      this.#admitRestart(this.#state.budget, charged);
    }
    const left = remainingStorageCalls(this.#state.budget.requestPool);
    const admits = this.#config.steps.admitsScan ?? ((c: number, l: number) => c <= l);
    if (!admits(charged, left)) {
      throw new BaerlyError(
        "CapacityExceeded",
        `this read of collection ${JSON.stringify(this.#collection)} must issue up to ${charged} ` +
          `storage calls to scan the tree, over the ${left} this request has left, more than one ` +
          `request can do on this host, so it was refused and returned no rows. ${OUTGROWN}`,
        { resolution: OUTGROWN, cause: { bound: "scanStorageCalls" } },
      );
    }
  }

  /** The base documents in `range`, in order, fetching only the nodes routing selects. */
  async #base(range: TreeRange): Promise<DocumentData[]> {
    const out: DocumentData[] = [];
    const { head, root } = this.#state;
    if (head !== null && root !== null) {
      await this.#walk(head, root, range, out);
    }
    return out;
  }

  async #walk(
    head: TreeHead,
    decoded: DecodedTreeNode,
    range: TreeRange,
    out: DocumentData[],
  ): Promise<void> {
    const node = decoded.node;
    if (node.kind === "leaf") {
      for (const doc of node.docs) {
        if (inRange(doc._id, range)) {
          out.push(asRow(doc));
        }
      }
      return;
    }
    const select = this.#config.steps.selectChildren ?? entriesIntersecting;
    const selected = select(node.children, range);
    for (let start = 0; start < selected.length; start += TREE_READ_PARALLEL_GETS) {
      const batch = selected.slice(start, start + TREE_READ_PARALLEL_GETS);
      // Settle every GET of the batch before acting on a failure, so none
      // outlives this attempt.
      const settled = await Promise.allSettled(
        batch.map((entry) => this.#child(head, node.level, entry)),
      );
      const failed = settled.find((result) => result.status === "rejected");
      if (failed !== undefined) {
        throw failed.reason;
      }
      for (const child of settled) {
        await this.#walk(
          head,
          (child as PromiseFulfilledResult<DecodedTreeNode>).value,
          range,
          out,
        );
      }
    }
  }

  /** GET the root `head` names and decode it as that head's root, or `null` for an empty tree. */
  async #fetchRoot(head: TreeHead): Promise<DecodedTreeNode | null> {
    if (head.root === null) {
      return null;
    }
    const expected: TreeNodeExpectation = {
      prefix: head.prefix,
      root: true,
      floor: head.json.log_seq_start,
    };
    const body = await this.#fetch(head, head.root, expected);
    const decoded = await decodeNode(head.root, body, expected, this.#config);
    assertRootMatchesHead(head, decoded);
    return decoded;
  }

  /** Fetch the child `entry` names and decode it against `entry`. */
  async #child(
    head: TreeHead,
    parentLevel: number,
    entry: TreeChildEntry,
  ): Promise<DecodedTreeNode> {
    const key = treeNodeKey(head.prefix, entry.attempt, entry.sha256);
    const expected: TreeNodeExpectation = {
      prefix: head.prefix,
      root: false,
      level: parentLevel - 1,
      entry,
    };
    return decodeNode(key, await this.#fetch(head, key, expected), expected, this.#config);
  }

  /**
   * GET the node at `key`, routed from `head`, and GET it once more when
   * the first finds nothing.
   *
   * @throws MissingNode — both GETs found nothing.
   */
  async #fetch(head: TreeHead, key: string, expected: TreeNodeExpectation): Promise<Uint8Array> {
    const got = await this.#storage.get(key);
    if (got !== null) {
      return got.body;
    }
    const reget = this.#config.steps.regetsMissingNode ?? (() => true);
    let again = null;
    if (reget()) {
      this.#admitMissingNodeCall("GET the node again");
      again = await this.#storage.get(key);
    }
    if (again === null) {
      throw new MissingNode(key, expected, head);
    }
    return again.body;
  }
}

/** Open a read of the collection at `target.prefix`; see {@link TreeView.open}. */
export const openTreeView = (target: TreeReadTarget): Promise<TreeView> => TreeView.open(target);

/** Point read: the row with `_id` `id`, or `undefined`. See {@link TreeView.get}. */
export const readTreePoint = async (
  target: TreeReadTarget,
  id: string,
): Promise<DocumentData | undefined> => {
  assertSnapshotDocId(id);
  const view = await openTreeView(target);
  return view.get(id);
};

/** Range read: the rows in `range`, in order. See {@link TreeView.range}. */
export const readTreeRange = async (
  target: TreeReadTarget,
  range: TreeRange,
): Promise<DocumentData[]> => {
  assertRange(range);
  const view = await openTreeView(target);
  return view.range(range);
};

/** Complete scan: every row, in order. See {@link TreeView.scan}. */
export const readTreeScan = async (target: TreeReadTarget): Promise<DocumentData[]> => {
  const view = await openTreeView(target);
  return view.scan();
};

/** Count of the rows in `range`, the whole collection by default. See {@link TreeView.count}. */
export const countTree = async (target: TreeReadTarget, range: TreeRange = {}): Promise<number> => {
  assertRange(range);
  const view = await openTreeView(target);
  return view.count(range);
};
