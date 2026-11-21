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
 * Reads are pure: they never PUT or DELETE, run maintenance or repair
 * anything, and a refusal writes nothing.
 */
import { BaerlyError, type DocumentData, type LogEntry, type Storage } from "@baerly/protocol";
import { foldLogEntriesOnto, walkLogRange } from "../log-walk.ts";
import { probeReadTail } from "../log-tail.ts";
import {
  currentReadEnvelope,
  ReadBudget,
  type ReadEnvelope,
  remainingStorageCalls,
} from "../read-admission.ts";
import { assertSnapshotDocId, compareDocIds } from "../snapshot-doc-id.ts";
import { TREE_READ_PARALLEL_GETS, TREE_RETRIED_CALL_CHARGE } from "./constants.ts";
import { readTreeHead, readTreeRoot, type TreeHead } from "./head.ts";
import { collectionOfPrefix, treeNodeKey } from "./key.ts";
import { DEFAULT_TREE_CONFIG, type TreeConfig, type TreeLayout } from "./layout.ts";
import {
  type DecodedTreeNode,
  decodeNode,
  type TreeChildEntry,
  type TreeDocument,
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
 * @throws BaerlyError code="InvalidResponse" — a surviving post-image's
 *   `_id` is outside the document-ID domain.
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

/** An open read: the head, its validated root and its tail. */
export class TreeView {
  readonly #storage: Storage;
  readonly #config: TreeConfig;
  readonly #collection: string;
  readonly #envelope: ReadEnvelope;
  readonly #budget: ReadBudget;
  /** The tree head, or `null` when the collection has no `current.json`. */
  readonly head: TreeHead | null;
  /** The validated root, or `null` for an empty tree. */
  readonly root: DecodedTreeNode | null;
  readonly tail: TreeTail;

  private constructor(
    target: TreeReadTarget,
    collection: string,
    envelope: ReadEnvelope,
    budget: ReadBudget,
    head: TreeHead | null,
    root: DecodedTreeNode | null,
    tail: TreeTail,
  ) {
    this.#storage = target.storage;
    this.#config = target.config ?? DEFAULT_TREE_CONFIG;
    this.#collection = collection;
    this.#envelope = envelope;
    this.#budget = budget;
    this.head = head;
    this.root = root;
    this.tail = tail;
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
   * @throws BaerlyError code="InvalidResponse" — a malformed head, root
   *   or log entry.
   * @throws BaerlyError code="CapacityExceeded" — the tail does not fit
   *   the read envelope or the request ledger.
   */
  static async open(target: TreeReadTarget): Promise<TreeView> {
    const config = target.config ?? DEFAULT_TREE_CONFIG;
    const collection = collectionOfPrefix(target.prefix);
    const envelope = currentReadEnvelope();
    const budget = new ReadBudget(collection, envelope);
    const head = await readTreeHead(target.storage, target.prefix);
    if (head === null) {
      return new TreeView(target, collection, envelope, budget, null, null, {
        tail: 0,
        entries: 0,
        overlay: new Map(),
      });
    }
    const root = await readTreeRoot(target.storage, head, config);
    // A tree head's `snapshot` is null, so the call count is the strict
    // range plus the probe's closing slot.
    budget.admitHead({ ...head.json, snapshot_rows: 0, snapshot_bytes: 0 });
    const readTail = config.steps.readTail ?? readTreeTail;
    const tail = await readTail({ storage: target.storage, head, collection, budget });
    return new TreeView(target, collection, envelope, budget, head, root, tail);
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
   *   strict decode.
   */
  async get(id: string): Promise<DocumentData | undefined> {
    assertSnapshotDocId(id);
    const written = this.tail.overlay.get(id);
    if (written !== undefined) {
      return written ?? undefined;
    }
    const [doc] = await this.#base({ gte: id, lte: id });
    return doc;
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
   *   strict decode.
   */
  async range(range: TreeRange): Promise<DocumentData[]> {
    const rows = await this.#rows(range);
    this.#budget.admitOutput(rows.length);
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
  async #rows(range: TreeRange): Promise<DocumentData[]> {
    assertRange(range);
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
    const left = remainingStorageCalls(this.#budget.requestPool);
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
    if (this.root !== null) {
      await this.#walk(this.root, range, out);
    }
    return out;
  }

  async #walk(decoded: DecodedTreeNode, range: TreeRange, out: DocumentData[]): Promise<void> {
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
      const children = await Promise.all(batch.map((entry) => this.#child(node.level, entry)));
      for (const child of children) {
        await this.#walk(child, range, out);
      }
    }
  }

  /** Fetch the child `entry` names and decode it against `entry`. */
  async #child(parentLevel: number, entry: TreeChildEntry): Promise<DecodedTreeNode> {
    const prefix = this.head!.prefix;
    const key = treeNodeKey(prefix, entry.attempt, entry.sha256);
    const got = await this.#storage.get(key);
    return decodeNode(
      key,
      got?.body ?? null,
      { prefix, root: false, level: parentLevel - 1, entry },
      this.#config,
    );
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
