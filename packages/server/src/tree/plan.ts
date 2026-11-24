/**
 * Fold planner of the prototype tree: captured tree + mutations →
 * the canonical tree of the new row set, rewriting only the changed
 * paths and their resync neighbours and reusing every other node.
 *
 * The result is the canonical tree of the new row set
 * (`tests/unit/tree-fold-plan*.test.ts` and
 * `tests/unit/tree-fold-planner.test.ts` check this). It relies on the
 * chunkers resetting at every cut, so re-chunking can start at a node
 * boundary of a canonical level and stop at one:
 *
 * - **Restart.** A change re-chunks from the start of the node that
 *   holds its first changed entry, or that would hold it: the first node
 *   whose `hi` is not below it, else the last node of the level. The end
 *   of a level is not a cut, so a change past the last node re-chunks
 *   that node. At the leaf level a cut before an isolated document read
 *   that document's size, so a change at or just before an isolated leaf
 *   also re-chunks the leaf before it.
 * - **Resync.** Re-chunking stops at the start of a node once its
 *   chunker is empty there and no pending change falls in or before that
 *   node. Everything after is chunked as before, so those nodes are kept
 *   until the next change's restart point.
 * - **Whole-level rules.** The depth-0 rule and the root rule depend on
 *   a whole level. Crossing the depth-0 limits downward reads every
 *   leaf; crossing them upward chunks every document. A level whose new
 *   node count is at most `branchFanoutMax` is regrouped into the root,
 *   which reads every node one level up; a root's child level that grows
 *   past it is chunked whole.
 * - **Level counts.** A level's new node count is its count before the
 *   change (the captured root's `level_nodes`, to begin with), less the
 *   nodes replaced there, plus the new ones. The counts are trusted while
 *   a level stays content-chunked. A level that is regrouped is listed
 *   node by node, and a count that disagrees with the list is
 *   `InvalidResponse`.
 *
 * Every node the planner reads comes through `get` and is strictly
 * decoded against the entry that routed to it, and every reused entry
 * is copied from such a node or from the captured root, so a reused ref
 * is always live under the captured root. The root is always fresh: it
 * carries the new fold end.
 *
 * {@link planFold} plans a whole fold at once. {@link FoldPlanner} adds
 * a fold's changes one at a time in seq order onto the tree of the
 * changes it has accepted, re-planning only the region each change
 * touches, and charges every node GET as it is issued and the
 * publication's calls as a reserve, so the fold can stop at the last
 * change that fits its request ledger.
 */
import { BaerlyError, encodeJsonBytes } from "@baerly/protocol";
import { assertSnapshotDocId, compareDocIds } from "../snapshot-doc-id.ts";
import {
  assembleLevels,
  BranchChunker,
  buildTree,
  type ChunkSteps,
  childSummary,
  chunkSteps,
  freshNodeCount,
  LeafChunker,
  type PlannedBranch,
  plannedBranch,
  type PlannedChild,
  type PlannedLeaf,
  plannedLeaf,
  type PlannedNode,
  type PlannedTree,
} from "./build.ts";
import type { ChunkKey } from "./chunk.ts";
import {
  TREE_FOLD_PARALLEL_GETS,
  TREE_GC_RECORD_MAX_KEYS,
  TREE_HEAD_CAS_CHARGE,
  TREE_RETRIED_CALL_CHARGE,
} from "./constants.ts";
import { treeNodeKey } from "./key.ts";
import { bytesEqual, DEFAULT_TREE_CONFIG, type TreeConfig, type TreeLayout } from "./layout.ts";
import {
  type CanonicalDocument,
  type DecodedTreeNode,
  decodeNode,
  type TreeChildEntry,
  type TreeDocument,
  type TreeNodeExpectation,
  type TreeNodeSummary,
} from "./node-codec.ts";

// ---------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------

/**
 * One surviving change of a fold: the row's new canonical document, or
 * `null` to delete it. Deleting an absent row changes nothing.
 */
export interface TreeMutation {
  readonly id: string;
  readonly doc: CanonicalDocument | null;
}

/** Input to {@link planFold}. */
export interface PlanFoldInput {
  /** The collection prefix `P`. */
  readonly prefix: string;
  /**
   * The captured root, strictly decoded as a root (routed from the head,
   * with the head's floor), or `null` for an empty collection.
   */
  readonly root: DecodedTreeNode | null;
  /** The collection's chunk key, from `importChunkKey` over the salt in its head. */
  readonly chunkKey: ChunkKey;
  /** The fold's surviving mutations, at most one per `_id`, in any order. */
  readonly mutations: readonly TreeMutation[];
  /** Read one node body by key; `null` when the object is absent. */
  readonly get: (key: string) => Promise<Uint8Array | null>;
  /** The tree configuration; tests pass a small layout or a mutant here. */
  readonly config?: TreeConfig;
}

/** The planned fold. */
export interface TreeFoldPlan {
  /**
   * The new tree with its level counts, or `null` when no row survives.
   * Its root is always fresh.
   */
  readonly tree: PlannedTree | null;
  /** Every node read below the captured root, strictly decoded, in read order. */
  readonly read: readonly DecodedTreeNode[];
  /**
   * The key of the captured root the plan was built on, or `null` for an
   * empty collection. The plan is valid only over that root.
   */
  readonly base: string | null;
  /**
   * The chunk key every cut of the plan was computed under. The plan is
   * valid only under the salt behind it (`chunkKeyIsOf`).
   */
  readonly chunkKey: ChunkKey;
}

/** A plan before it is tied to its base root and chunk key. */
type PlannedFold = Pick<TreeFoldPlan, "tree" | "read">;

// ---------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------

/** Sort mutations by `_id` in `utf8-scalar-v1` order. */
export const sortMutationsById = <M extends { readonly id: string }>(
  mutations: readonly M[],
): M[] => mutations.toSorted((a, b) => compareDocIds(a.id, b.id));

/**
 * Whether the old leaf with these totals holds one isolated document. A
 * leaf before an isolated document may have been cut only because of
 * that document's size, so a change there re-chunks the earlier leaf
 * too. A leaf holding one document of at least
 * `leafIsolationDocumentBytes` is always isolated: no other leaf holds
 * such a document.
 */
export const leafIsIsolated = (
  leaf: { readonly rows: number; readonly bytes: number },
  layout: TreeLayout,
): boolean => leaf.rows === 1 && leaf.bytes >= layout.leafIsolationDocumentBytes;

/** Stop re-chunking only where the chunker has just cut. */
export const resyncWhenEmpty = (chunkerEmpty: boolean): boolean => chunkerEmpty;

interface PlanSteps extends ChunkSteps {
  readonly sortMutations: <M extends { readonly id: string }>(mutations: readonly M[]) => M[];
  readonly leafRestartsBefore: (
    leaf: { readonly rows: number; readonly bytes: number },
    layout: TreeLayout,
  ) => boolean;
  readonly resyncStops: (chunkerEmpty: boolean) => boolean;
}

/**
 * `hash` remembering every value it returns. The chunk hash is a pure
 * function of the level, the `_id` and the salt, and a fold re-chunks
 * the rows around every change, so without this each change would
 * re-hash every row of the leaves it re-chunks: per-change work
 * proportional to rows per leaf. A planner hashes each `_id` at each
 * level at most once.
 */
const memoizedHash = (hash: ChunkSteps["hash"]): ChunkSteps["hash"] => {
  const levels = new Map<number, Map<string, number>>();
  return async (level, id) => {
    let byId = levels.get(level);
    if (byId === undefined) {
      byId = new Map();
      levels.set(level, byId);
    }
    let value = byId.get(id);
    if (value === undefined) {
      value = await hash(level, id);
      byId.set(id, value);
    }
    return value;
  };
};

const planSteps = (config: TreeConfig, key: ChunkKey): PlanSteps => {
  const steps = chunkSteps(config, key);
  return {
    ...steps,
    hash: memoizedHash(steps.hash),
    sortMutations: config.steps.sortMutations ?? sortMutationsById,
    leafRestartsBefore: config.steps.leafRestartsBefore ?? leafIsIsolated,
    resyncStops: config.steps.resyncStops ?? resyncWhenEmpty,
  };
};

const internal = (detail: string): never => {
  throw new BaerlyError("Internal", `tree fold plan: ${detail}`);
};

// ---------------------------------------------------------------------
// The tree a pass walks, read lazily
// ---------------------------------------------------------------------

/**
 * A node of the tree a pass walks: the captured tree, or the tree of the
 * changes a {@link FoldPlanner} has accepted, whose nodes are fresh or
 * reused from the captured tree. A reused node's body is read on first
 * use.
 */
interface ViewNode {
  readonly level: number;
  /** The child its parent holds; the root holds itself as a fresh child. */
  readonly child: PlannedChild;
  readonly summary: TreeNodeSummary;
  readonly parent: ViewNode | null;
  /** Position among the parent's children. */
  readonly index: number;
  /** A reused node's body, once read. */
  decoded: DecodedTreeNode | null;
  /** The children, once a branch is opened. */
  children: ViewNode[] | null;
}

/** An old run of one level replaced by new nodes. */
interface Splice {
  /** First and last node replaced, in level order. */
  readonly first: ViewNode;
  readonly last: ViewNode;
  /** How many nodes the run holds. */
  readonly count: number;
  /** How many of them are fresh nodes. */
  readonly freshReplaced: number;
  /** The nodes that replace the run, in order. */
  readonly out: readonly PlannedChild[];
}

/**
 * The child a parent holds for a node a pass just built: the node
 * itself as a fresh child, or a reused node it equals.
 */
type Adopt = (node: PlannedNode) => PlannedChild;

const freshChild: Adopt = (node) => ({ kind: "fresh", node });

const freshIn = (children: readonly PlannedChild[]): number =>
  children.reduce((total, child) => total + (child.kind === "fresh" ? 1 : 0), 0);

const canonicalOf = (doc: TreeDocument): CanonicalDocument => ({
  doc,
  id: doc._id,
  bytes: encodeJsonBytes(doc).byteLength,
});

/** The canonical documents of each read leaf, encoded once. */
type DocsCache = WeakMap<DecodedTreeNode, readonly CanonicalDocument[]>;

const leafDocs = (decoded: DecodedTreeNode, cache: DocsCache): readonly CanonicalDocument[] => {
  if (decoded.node.kind !== "leaf") {
    return internal(`node ${JSON.stringify(decoded.key)} is not a leaf`);
  }
  let docs = cache.get(decoded);
  if (docs === undefined) {
    docs = decoded.node.docs.map(canonicalOf);
    cache.set(decoded, docs);
  }
  return docs;
};

/** Level order of two nodes of one level: their ranges are disjoint. */
const compareNodes = (a: ViewNode, b: ViewNode): number =>
  compareDocIds(a.summary.lo, b.summary.lo);

/** Read and strictly decode one node of the captured tree. */
type NodeLoader = (key: string, expected: TreeNodeExpectation) => Promise<DecodedTreeNode>;

/** Called for every reused node a pass reads, with the entry that named it. */
type OnRead = (level: number, entry: TreeChildEntry, decoded: DecodedTreeNode) => void;

class TreeView {
  readonly root: ViewNode;
  /** Every reused node this view read, in read order. */
  readonly read: DecodedTreeNode[] = [];
  readonly #prefix: string;
  readonly #loadNode: NodeLoader;
  readonly #docs: DocsCache;
  readonly #onRead: OnRead | undefined;

  constructor(
    prefix: string,
    root: PlannedNode,
    loadNode: NodeLoader,
    docs: DocsCache,
    onRead?: OnRead,
  ) {
    this.#prefix = prefix;
    this.#loadNode = loadNode;
    this.#docs = docs;
    this.#onRead = onRead;
    this.root = this.#node(root.level, { kind: "fresh", node: root }, null, 0);
  }

  #node(level: number, child: PlannedChild, parent: ViewNode | null, index: number): ViewNode {
    return {
      level,
      child,
      summary: childSummary(child),
      parent,
      index,
      decoded: null,
      children: null,
    };
  }

  /** Read `node` if it is reused, and list a branch's children. */
  async #open(node: ViewNode): Promise<void> {
    const { child } = node;
    if (child.kind === "reused" && node.decoded === null) {
      const { entry } = child;
      const decoded = await this.#loadNode(treeNodeKey(this.#prefix, entry.attempt, entry.sha256), {
        prefix: this.#prefix,
        root: false,
        level: node.level,
        entry,
      });
      this.read.push(decoded);
      this.#onRead?.(node.level, entry, decoded);
      node.decoded = decoded;
    }
    if (node.level === 0 || node.children !== null) {
      return;
    }
    let children: readonly PlannedChild[];
    if (child.kind === "fresh") {
      children =
        child.node.kind === "branch"
          ? child.node.children
          : internal(`node at level ${node.level} is a leaf`);
    } else {
      const body = node.decoded!.node;
      children =
        body.kind === "branch"
          ? body.children.map((entry) => ({ kind: "reused", entry }))
          : internal(`node at level ${node.level} is a leaf`);
    }
    node.children = children.map((c, index) => this.#node(node.level - 1, c, node, index));
  }

  async #children(node: ViewNode): Promise<ViewNode[]> {
    await this.#open(node);
    return node.children!;
  }

  /** The node after `node` on its level, or `null` at the level's end. */
  async next(node: ViewNode): Promise<ViewNode | null> {
    const parent = node.parent;
    if (parent === null) {
      return null;
    }
    if (node.index + 1 < parent.children!.length) {
      return parent.children![node.index + 1]!;
    }
    const uncle = await this.next(parent);
    if (uncle === null) {
      return null;
    }
    const children = await this.#children(uncle);
    return children[0]!;
  }

  /** The node before `node` on its level, or `null` at the level's start. */
  async prev(node: ViewNode): Promise<ViewNode | null> {
    const parent = node.parent;
    if (parent === null) {
      return null;
    }
    if (node.index > 0) {
      return parent.children![node.index - 1]!;
    }
    const uncle = await this.prev(parent);
    if (uncle === null) {
      return null;
    }
    const children = await this.#children(uncle);
    return children.at(-1)!;
  }

  /** The first node of `level`. */
  async first(level: number): Promise<ViewNode> {
    let node = this.root;
    while (node.level > level) {
      const children = await this.#children(node);
      node = children[0]!;
    }
    return node;
  }

  /** The first leaf whose `hi` is not below `id`, else the last leaf. */
  async seekLeaf(id: string): Promise<ViewNode> {
    let node = this.root;
    while (node.level > 0) {
      const children = await this.#children(node);
      node = children.find((child) => compareDocIds(id, child.summary.hi) <= 0) ?? children.at(-1)!;
    }
    return node;
  }

  /** The documents of the leaf `node`. */
  async docs(node: ViewNode): Promise<readonly CanonicalDocument[]> {
    const { child } = node;
    if (child.kind === "fresh") {
      return child.node.kind === "leaf"
        ? child.node.docs
        : internal(`node at level ${node.level} is not a leaf`);
    }
    await this.#open(node);
    return leafDocs(node.decoded!, this.#docs);
  }

  /**
   * Every node of the new `level`, in order: the nodes with each
   * splice's run replaced by its new nodes. Reads every node one level
   * up.
   */
  async levelItems(level: number, splices: readonly Splice[]): Promise<PlannedChild[]> {
    const items: PlannedChild[] = [];
    let si = 0;
    let node: ViewNode | null = await this.first(level);
    while (node !== null) {
      const splice = splices[si];
      if (splice !== undefined && node === splice.first) {
        items.push(...splice.out);
        si += 1;
        node = await this.next(splice.last);
        continue;
      }
      items.push(node.child);
      node = await this.next(node);
    }
    return items;
  }

  /** The node `child` at `level` as a fresh planned node, so it can become a root. */
  async materialize(child: PlannedChild, level: number): Promise<PlannedNode> {
    if (child.kind === "fresh") {
      return child.node;
    }
    const node = this.#node(level, child, null, 0);
    if (level === 0) {
      return plannedLeaf(await this.docs(node));
    }
    const children = await this.#children(node);
    return plannedBranch(
      level,
      children.map((c) => c.child),
    );
  }
}

// ---------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------

/** Whether `id` is inside the document-ID domain. */
const isDocId = (id: string): boolean => {
  try {
    assertSnapshotDocId(id);
    return true;
  } catch {
    return false;
  }
};

/**
 * Sort the mutations and check each is well formed. A delete whose `_id`
 * is outside the document-ID domain is dropped: no stored row can have
 * that `_id`, so it changes nothing.
 */
const orderedMutations = (
  mutations: readonly TreeMutation[],
  steps: PlanSteps,
): readonly TreeMutation[] => {
  const sorted = steps.sortMutations(
    mutations.filter(({ id, doc }) => doc !== null || isDocId(id)),
  );
  for (let i = 0; i < sorted.length; i++) {
    const { id, doc } = sorted[i]!;
    if (i > 0 && compareDocIds(sorted[i - 1]!.id, id) >= 0) {
      internal(`mutations for ${JSON.stringify(id)} are duplicated or out of order`);
    }
    if (doc !== null && doc.id !== id) {
      internal(`mutation for ${JSON.stringify(id)} carries document ${JSON.stringify(doc.id)}`);
    }
  }
  return sorted;
};

/** Row and byte changes of a merge. */
interface Totals {
  rows: number;
  bytes: number;
}

/**
 * `docs` (sorted) with `mutations` (sorted) applied, adding the change
 * in totals to `delta`.
 */
const merged = (
  docs: readonly CanonicalDocument[],
  mutations: readonly TreeMutation[],
  delta: Totals = { rows: 0, bytes: 0 },
): CanonicalDocument[] => {
  const out: CanonicalDocument[] = [];
  let d = 0;
  let m = 0;
  while (d < docs.length || m < mutations.length) {
    const old = docs[d];
    const mutation = mutations[m];
    let order: number;
    if (old === undefined) {
      order = 1;
    } else if (mutation === undefined) {
      order = -1;
    } else {
      order = compareDocIds(old.id, mutation.id);
    }
    if (order < 0) {
      out.push(old!);
      d += 1;
      continue;
    }
    if (order === 0) {
      delta.rows -= 1;
      delta.bytes -= old!.bytes;
      d += 1;
    }
    if (mutation!.doc !== null) {
      delta.rows += 1;
      delta.bytes += mutation!.doc.bytes;
      out.push(mutation!.doc);
    }
    m += 1;
  }
  return out;
};

/** Whether two canonical documents are the same row: same reference, or same canonical bytes. */
const sameDocument = (a: CanonicalDocument, b: CanonicalDocument): boolean =>
  a.doc === b.doc ||
  (a.id === b.id &&
    a.bytes === b.bytes &&
    bytesEqual(encodeJsonBytes(a.doc), encodeJsonBytes(b.doc)));

// ---------------------------------------------------------------------
// Level passes
// ---------------------------------------------------------------------

/** Where re-chunking for a change at `id` starts on the leaf level. */
const leafRestart = async (view: TreeView, id: string, steps: PlanSteps): Promise<ViewNode> => {
  const leaf = await view.seekLeaf(id);
  if (
    compareDocIds(id, leaf.summary.hi) <= 0 &&
    steps.leafRestartsBefore(leaf.summary, steps.layout)
  ) {
    return (await view.prev(leaf)) ?? leaf;
  }
  return leaf;
};

/** Re-chunk the leaf level around every mutation. */
const leafPass = async (
  view: TreeView,
  mutations: readonly TreeMutation[],
  steps: PlanSteps,
  delta: Totals,
  adopt: Adopt,
): Promise<Splice[]> => {
  const splices: Splice[] = [];
  let mi = 0;
  let restart = mutations.length > 0 ? await leafRestart(view, mutations[0]!.id, steps) : null;
  while (restart !== null) {
    const first = restart;
    const fresh: PlannedLeaf[] = [];
    const chunker = new LeafChunker(steps, fresh);
    let leaf = first;
    let count = 0;
    let freshReplaced = 0;
    restart = null;
    for (;;) {
      const docs = await view.docs(leaf);
      count += 1;
      freshReplaced += leaf.child.kind === "fresh" ? 1 : 0;
      const next = await view.next(leaf);
      // This leaf takes every pending mutation up to its `hi`; the last
      // leaf takes the rest, since the level's end is not a cut.
      let end = mutations.length;
      if (next !== null) {
        end = mi;
        while (end < mutations.length && compareDocIds(mutations[end]!.id, leaf.summary.hi) <= 0) {
          end += 1;
        }
      }
      for (const doc of merged(docs, mutations.slice(mi, end), delta)) {
        await chunker.push(doc);
      }
      mi = end;
      if (next === null) {
        chunker.flush();
        break;
      }
      const pending =
        mi < mutations.length ? await leafRestart(view, mutations[mi]!.id, steps) : null;
      if (pending === null || compareNodes(pending, next) > 0) {
        if (steps.resyncStops(chunker.empty)) {
          chunker.flush();
          restart = pending;
          break;
        }
      }
      leaf = next;
    }
    splices.push({ first, last: leaf, count, freshReplaced, out: fresh.map(adopt) });
  }
  return splices;
};

/**
 * Re-chunk branch `level`, which is content-chunked, around every
 * splice of the level below.
 */
const branchPass = async (
  view: TreeView,
  level: number,
  below: readonly Splice[],
  steps: PlanSteps,
  adopt: Adopt,
): Promise<Splice[]> => {
  const splices: Splice[] = [];
  let si = 0;
  while (si < below.length) {
    const first = below[si]!.first.parent!;
    const fresh: PlannedBranch[] = [];
    const chunker = new BranchChunker(level, steps, fresh);
    let parent = first;
    let count = 1;
    let freshReplaced = first.child.kind === "fresh" ? 1 : 0;
    const enter = (node: ViewNode): void => {
      parent = node;
      count += 1;
      freshReplaced += node.child.kind === "fresh" ? 1 : 0;
    };
    let cur: ViewNode | null = first.children![0]!;
    for (;;) {
      if (cur === null) {
        chunker.flush();
        break;
      }
      if (cur.parent !== parent) {
        // At the start of the next node of this level.
        const pending = below[si];
        if (pending === undefined || compareNodes(pending.first.parent!, cur.parent!) > 0) {
          if (steps.resyncStops(chunker.empty)) {
            chunker.flush();
            break;
          }
        }
        enter(cur.parent!);
      }
      const splice = below[si];
      if (splice !== undefined && cur === splice.first) {
        for (const child of splice.out) {
          await chunker.push(child);
        }
        si += 1;
        while (parent !== splice.last.parent) {
          enter((await view.next(parent))!);
        }
        cur = await view.next(splice.last);
        continue;
      }
      await chunker.push(cur.child);
      cur = await view.next(cur);
    }
    splices.push({ first, last: parent, count, freshReplaced, out: fresh.map(adopt) });
  }
  return splices;
};

/** What the level passes plan: the new tree and the fresh nodes at each level below its root. */
interface LevelPlan {
  readonly tree: PlannedTree;
  readonly fresh: readonly number[];
  /** How many low levels kept a carried count; the levels above were listed or built. */
  readonly carried: number;
}

/**
 * Carry the leaf splices `below` up the levels of `view` whose node
 * counts are `counts` (fresh nodes `fresh`), applying the root rule.
 * `mismatch` reports a regrouped level whose nodes disagree with the
 * counts.
 */
const planLevels = async (
  view: TreeView,
  leafSplices: readonly Splice[],
  counts: readonly number[],
  fresh: readonly number[],
  steps: PlanSteps,
  adopt: Adopt,
  mismatch: (level: number, holds: number, gives: number) => never,
): Promise<LevelPlan> => {
  const depth = view.root.level;
  const newCounts: number[] = [];
  const newFresh: number[] = [];
  let below = leafSplices;
  for (let level = 0; ; level++) {
    // The new node count of `level`: the count before, less the nodes
    // replaced there, plus the new ones. The root level holds one node.
    const count = below.reduce(
      (total, splice) => total + splice.out.length - splice.count,
      level < depth ? counts[level]! : 1,
    );
    // Below the root's children the level held more than
    // branchFanoutMax nodes and was chunked; it stays chunked while the
    // new level does too.
    if (level + 1 < depth && count > steps.layout.branchFanoutMax) {
      newCounts.push(count);
      newFresh.push(
        below.reduce(
          (total, splice) => total + freshIn(splice.out) - splice.freshReplaced,
          fresh[level]!,
        ),
      );
      below = await branchPass(view, level + 1, below, steps, adopt);
      continue;
    }
    // Otherwise the new level is regrouped from all its nodes.
    const items = await view.levelItems(level, below);
    if (items.length !== count) {
      mismatch(level, items.length, count);
    }
    const chunked: number[] = [];
    const { top, levelNodes } = await assembleLevels(items, level, steps, (node) => {
      const child = adopt(node);
      if (child.kind === "fresh") {
        chunked[node.level] = (chunked[node.level] ?? 0) + 1;
      }
      return child;
    });
    const root = await view.materialize(top, level + levelNodes.length);
    return {
      tree: { root, levelNodes: [...newCounts, ...levelNodes] },
      fresh: [
        ...newFresh,
        ...levelNodes.map((_, i) => (i === 0 ? freshIn(items) : (chunked[level + i] ?? 0))),
      ],
      carried: newCounts.length,
    };
  }
};

/** Every document of the tree, read leaf by leaf. */
const allDocs = async (view: TreeView): Promise<CanonicalDocument[]> => {
  const docs: CanonicalDocument[] = [];
  for (
    let leaf: ViewNode | null = await view.first(0);
    leaf !== null;
    leaf = await view.next(leaf)
  ) {
    docs.push(...(await view.docs(leaf)));
  }
  return docs;
};

/** The captured root branch as a planned node that reuses every child. */
const capturedBranch = (captured: DecodedTreeNode): PlannedNode =>
  captured.node.kind === "branch"
    ? plannedBranch(
        captured.node.level,
        captured.node.children.map((entry) => ({ kind: "reused", entry })),
      )
    : internal(`captured node ${JSON.stringify(captured.key)} is not a branch`);

/**
 * The error for a regrouped `level` that holds `holds` nodes where the
 * counts give `gives`. When the counts descend from the `level_nodes` of
 * the captured root `captured`, the stored tree is inconsistent:
 * `InvalidResponse`. When `captured` is `null` the counts are the
 * planner's own (it listed or built that level), so only a planner bug
 * reaches here: `Internal`.
 */
export const levelCountsMismatch = (
  captured: DecodedTreeNode | null,
  level: number,
  holds: number,
  gives: number,
): BaerlyError => {
  if (captured === null) {
    return new BaerlyError(
      "Internal",
      `tree fold plan: level ${level} holds ${holds} nodes where the planner's own counts give ${gives}`,
    );
  }
  const stored =
    captured.node.kind === "branch" && captured.node.root !== null
      ? captured.node.root.levelNodes
      : [];
  return new BaerlyError(
    "InvalidResponse",
    `tree fold plan: captured root ${JSON.stringify(captured.key)} records level_nodes ${JSON.stringify(stored)}, but level ${level} holds ${holds} nodes where those counts give ${gives}`,
  );
};

// ---------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------

/** Plan `mutations` against the captured root, reading nodes through `loadNode`. */
const planTree = async (
  prefix: string,
  captured: DecodedTreeNode | null,
  mutations: readonly TreeMutation[],
  steps: PlanSteps,
  key: ChunkKey,
  config: TreeConfig,
  loadNode: NodeLoader,
): Promise<PlannedFold> => {
  if (captured === null) {
    return { tree: await buildTree(merged([], mutations), key, config), read: [] };
  }
  const totals = captured.node.root;
  if (totals === null) {
    return internal(`captured node ${JSON.stringify(captured.key)} is not a root`);
  }
  if (captured.node.kind === "leaf") {
    const docs = merged(captured.node.docs.map(canonicalOf), mutations);
    return { tree: await buildTree(docs, key, config), read: [] };
  }
  const oldCounts = (totals as { readonly levelNodes: readonly number[] }).levelNodes;

  const view = new TreeView(prefix, capturedBranch(captured), loadNode, new WeakMap());
  const delta: Totals = { rows: 0, bytes: 0 };
  const below = await leafPass(view, mutations, steps, delta, freshChild);

  const rows = totals.rows + delta.rows;
  if (rows === 0) {
    return { tree: null, read: view.read };
  }
  if (steps.singleLeaf(rows, totals.bytes + delta.bytes, steps.layout)) {
    // Crossing the depth-0 limits downward rebuilds the whole leaf level.
    const docs = merged(await allDocs(view), mutations);
    return { tree: await buildTree(docs, key, config), read: view.read };
  }
  const { tree } = await planLevels(
    view,
    below,
    oldCounts,
    oldCounts.map(() => 0),
    steps,
    freshChild,
    (level, holds, gives) => {
      throw levelCountsMismatch(captured, level, holds, gives);
    },
  );
  return { tree, read: view.read };
};

/** {@link planTree}, tied to the captured root's key and the chunk key it planned under. */
const planWith = async (
  prefix: string,
  captured: DecodedTreeNode | null,
  mutations: readonly TreeMutation[],
  steps: PlanSteps,
  key: ChunkKey,
  config: TreeConfig,
  loadNode: NodeLoader,
): Promise<TreeFoldPlan> => ({
  ...(await planTree(prefix, captured, mutations, steps, key, config, loadNode)),
  base: captured?.key ?? null,
  chunkKey: key,
});

/** Read a node through `get` and strictly decode it. */
const decodingLoader =
  (get: (key: string) => Promise<Uint8Array | null>, config: TreeConfig): NodeLoader =>
  async (key, expected) =>
    decodeNode(key, await get(key), expected, config);

/**
 * Plan a fold: the canonical tree of the captured tree's rows with
 * `mutations` applied, reusing every captured node the change leaves
 * canonical. Pure apart from `get`, which it calls only for nodes of the
 * captured tree; it writes nothing.
 *
 * Seal the result with `sealTree` under a fresh attempt identity. A
 * fold that charges its request ledger per change uses
 * {@link FoldPlanner} instead.
 *
 * A delete whose `_id` is outside the document-ID domain is dropped.
 *
 * @throws BaerlyError code="InvalidResponse" — a node read through
 *   `get` is missing or fails its strict decode, or the captured root's
 *   `level_nodes` disagree with the nodes of a level the plan regroups.
 * @throws BaerlyError code="Internal" — `root` is not a root node, the
 *   mutations repeat an `_id`, a mutation's document has another `_id`,
 *   or the tree would exceed `TREE_MAX_LEVEL`.
 */
export const planFold = async (input: PlanFoldInput): Promise<TreeFoldPlan> => {
  const config = input.config ?? DEFAULT_TREE_CONFIG;
  const steps = planSteps(config, input.chunkKey);
  return planWith(
    input.prefix,
    input.root,
    orderedMutations(input.mutations, steps),
    steps,
    input.chunkKey,
    config,
    decodingLoader(input.get, config),
  );
};

// ---------------------------------------------------------------------
// Charged, change-by-change planning
// ---------------------------------------------------------------------

/** Calls reserved to publish a tree of `freshNodes` fresh nodes; see {@link publicationReserve}. */
const reserveFor = (freshNodes: number): number =>
  (freshNodes + 1) * (TREE_RETRIED_CALL_CHARGE + TREE_RETRIED_CALL_CHARGE) +
  TREE_HEAD_CAS_CHARGE +
  TREE_RETRIED_CALL_CHARGE;

/**
 * Calls reserved to publish `tree`: for the fold record and for each
 * fresh node, its create PUT and the GET that adopts it when the
 * create's acknowledgement was lost and its retry met a 412; then the
 * head CAS and the head re-read that resolves its fate.
 */
export const publicationReserve = (tree: PlannedTree | null): number =>
  reserveFor(tree === null ? 0 : freshNodeCount(tree.root));

/**
 * Whether a fold record listing `keys` keys, fresh and superseded
 * together, may be published: at most `TREE_GC_RECORD_MAX_KEYS`.
 */
export const recordKeysFit = (keys: number): boolean => keys <= TREE_GC_RECORD_MAX_KEYS;

/** Input to {@link FoldPlanner}. */
export interface FoldPlannerInput extends Omit<PlanFoldInput, "mutations"> {
  /** Calls the request ledger allows this fold tick in total. */
  readonly budget: number;
  /** Calls already charged before planning: the head GET and the root GET. */
  readonly spent: number;
  /**
   * Most node GETs {@link FoldPlanner.prefetch} issues at once. Default
   * `TREE_FOLD_PARALLEL_GETS`; `1` turns prefetching off, so every node
   * is read as a change first needs it.
   */
  readonly parallelGets?: number;
}

/** A prefetched node body, or the error its GET threw. */
type Prefetched =
  | { readonly ok: true; readonly body: Uint8Array | null }
  | { readonly ok: false; readonly error: unknown };

/** A prefetched branch, decoded to route the prefetch, with what it was decoded against. */
interface Peeked {
  readonly expected: TreeNodeExpectation;
  readonly decoded: DecodedTreeNode;
}

/** Whether decoding against `a` and against `b` checks the same things. */
const sameExpectation = (a: TreeNodeExpectation, b: TreeNodeExpectation): boolean =>
  a.prefix === b.prefix &&
  a.root === b.root &&
  a.level === b.level &&
  a.floor === b.floor &&
  a.entry?.lo === b.entry?.lo &&
  a.entry?.hi === b.entry?.hi &&
  a.entry?.rows === b.entry?.rows &&
  a.entry?.bytes === b.entry?.bytes;

/**
 * Thrown inside a change when its next node GET would not fit, and
 * caught by {@link FoldPlanner.add}; it never escapes the planner.
 */
class OverBudget extends Error {
  constructor() {
    super("tree fold plan: the next node GET would overrun the request ledger");
  }
}

/**
 * The tree of the accepted changes.
 *
 * - `single`: the depth-0 rule holds (or no row is left), so the tree is
 *   one leaf of every row. Only the totals are kept per change: the
 *   rows are `base` with the accepted changes `[start, end)` applied,
 *   and the leaf is built when a plan is read.
 * - `tree`: a content-chunked tree whose root is `root`, with the node
 *   count and the fresh node count of every level below it, and how many
 *   of those counts are still carried from the captured root.
 */
type PlannerState =
  | {
      readonly kind: "single";
      readonly base: readonly CanonicalDocument[];
      readonly index: ReadonlyMap<string, CanonicalDocument>;
      readonly start: number;
      readonly end: number;
      readonly rows: number;
      readonly bytes: number;
    }
  | {
      readonly kind: "tree";
      readonly root: PlannedNode;
      readonly counts: readonly number[];
      readonly fresh: readonly number[];
      /**
       * How many low levels have counts that descend from the captured
       * root's `level_nodes`, never listed since. The others are the
       * planner's own.
       */
      readonly storedLevels: number;
      readonly rows: number;
      readonly bytes: number;
    };

/** The plan after an accepted seq, with the reserve its GETs were admitted against. */
interface Checkpoint {
  readonly state: PlannerState;
  readonly reserve: number;
  /** Nodes fetched when it was taken: its plan's `read`. */
  readonly fetched: number;
  /** Its plan, built on first read. */
  plan?: TreeFoldPlan;
}

/** A node of the captured tree the planner has read, keyed by level and `lo`. */
interface ReadNode {
  readonly entry: TreeChildEntry;
  readonly decoded: DecodedTreeNode;
}

/**
 * Plans a fold one change at a time, in seq order, against a request
 * ledger.
 *
 * Each {@link FoldPlanner.add} applies one change to the tree of the
 * changes accepted so far, re-planning only the region it touches: its
 * leaf's resync region and the path above it, plus a level's nodes when
 * the root rule regroups that level, and every row when the change
 * crosses the depth-0 limits. Hashing and encoding per change are
 * therefore bounded by that region, not by how many changes the tick
 * has accepted. A rebuilt node equal to a captured node the planner has
 * read (same level, `lo` and content) reuses that node, so a change
 * that is undone, or a no-op, publishes no copy of an existing node.
 * An absent delete or an identical upsert changes nothing once its leaf
 * is read.
 *
 * **Charging.** Every node GET is charged as it is issued, and every
 * call the caller issues between changes (the fold's log GETs) is
 * charged through {@link FoldPlanner.spend}, all against one budget.
 * Before each node GET the planner checks that the GET and the reserve
 * of the last accepted plan ({@link publicationReserve}) still fit;
 * after the change it checks that the new plan's reserve fits, and that
 * its fold record would list at most `TREE_GC_RECORD_MAX_KEYS` keys.
 * A change that fails any check is rejected: the fold ends before its
 * seq and publishes the last accepted plan, and the GETs issued for it
 * stay charged. Rejection is prefix-only: after it, every later change is
 * refused.
 *
 * **Prefetch.** {@link FoldPlanner.prefetch} reads, concurrently, the
 * nodes the next changes' leaf paths route to in the current tree. Each
 * of its GETs is charged when issued, under the same check as a GET a
 * change issues, and a change that later needs the node takes the body
 * without another GET or charge. Every node a prefetch reads is one the
 * changes would read on demand, so plans, reads and charges are those of
 * reading on demand as long as the planner accepts every prefetched
 * change (`tests/unit/tree-fold-prefetch.test.ts`). When the budget
 * rejects one first, its prefetched GETs may go unused; they stay
 * charged, so the charge still counts every GET issued.
 *
 * **Checkpoints.** The planner keeps a checkpoint, a plan and its
 * reserve, at every accepted seq. A fold whose look-ahead passes an
 * entry it cannot publish yet (an invalid survivor a later entry may
 * supersede) calls {@link FoldPlanner.pin} at that entry. While a
 * checkpoint is pinned, every GET is admitted against the larger of the
 * current reserve and the pinned checkpoint's, so
 * {@link FoldPlanner.rollback} to it always fits the budget.
 */
export class FoldPlanner {
  readonly #input: FoldPlannerInput;
  readonly #config: TreeConfig;
  readonly #steps: PlanSteps;
  readonly #fetched = new Map<string, DecodedTreeNode>();
  /** Prefetched node bodies no change has needed yet. */
  readonly #prefetched = new Map<string, Promise<Prefetched>>();
  /** Prefetched branches already decoded to route the prefetch. */
  readonly #peeked = new Map<string, Peeked>();
  readonly #read: DecodedTreeNode[] = [];
  readonly #docs: DocsCache = new WeakMap();
  readonly #readNodes = new Map<number, Map<string, ReadNode>>();
  /** Every accepted change that a `single` state replays. */
  readonly #log: TreeMutation[] = [];
  /** The rows the current `single` state changed, by `_id`. */
  #overlay = new Map<string, CanonicalDocument | null>();
  readonly #checkpoints: Checkpoint[];
  #gets = 0;
  #spentBetween = 0;
  #pinned: number | null = null;
  #rejected = false;

  /**
   * A `spent` above `budget` is allowed: no change fits, so every
   * {@link FoldPlanner.add} is refused and the fold folds nothing.
   *
   * @throws BaerlyError code="Internal" — `budget` or `spent` is not a
   *   non-negative safe integer, or `input.root` is not a root node.
   */
  constructor(input: FoldPlannerInput) {
    for (const field of ["budget", "spent"] as const) {
      const value = input[field];
      if (!Number.isSafeInteger(value) || value < 0) {
        internal(`${field} ${value} is not a non-negative safe integer`);
      }
    }
    this.#input = input;
    this.#config = input.config ?? DEFAULT_TREE_CONFIG;
    this.#steps = planSteps(this.#config, input.chunkKey);
    this.#checkpoints = [{ state: this.#initialState(input.root), reserve: 0, fetched: 0 }];
  }

  /** The last accepted plan, or `null` while no change has been accepted. */
  get plan(): TreeFoldPlan | null {
    if (this.#checkpoints.length === 1) {
      return null;
    }
    const checkpoint = this.#current;
    checkpoint.plan ??= {
      tree: this.#treeOf(checkpoint.state),
      read: this.#read.slice(0, checkpoint.fetched),
      base: this.#input.root?.key ?? null,
      chunkKey: this.#input.chunkKey,
    };
    return checkpoint.plan;
  }

  /** How many changes have been accepted: the fold ends after that many entries. */
  get accepted(): number {
    return this.#checkpoints.length - 1;
  }

  /**
   * Calls held against the budget: those charged before planning, every
   * node GET issued (rejected changes included), every call charged
   * through {@link FoldPlanner.spend}, and the reserve to publish the
   * last accepted plan, or the pinned checkpoint's reserve while a pin is
   * held and it is the larger. `budget − charge` is what is left for the
   * fold's next calls; after {@link FoldPlanner.rollback} it holds the
   * pinned plan's reserve.
   */
  get charge(): number {
    return this.#spent(0) + this.#heldReserve(this.#current.reserve);
  }

  /** Node GETs issued so far. */
  get gets(): number {
    return this.#gets;
  }

  /**
   * Add the next change in seq order; a change to an `_id` already added
   * replaces that change. Returns whether it was accepted. After the
   * first rejection every later change is rejected too, so the accepted
   * changes stay a seq prefix.
   *
   * @throws BaerlyError — as for {@link planFold}.
   */
  async add(mutation: TreeMutation): Promise<boolean> {
    if (this.#rejected) {
      return false;
    }
    const current = this.#current;
    let change: TreeMutation | undefined;
    let next: PlannerState;
    try {
      [change] = orderedMutations([mutation], this.#steps);
      next = change === undefined ? current.state : await this.#apply(current.state, change);
    } catch (error) {
      // A change that throws is rejected too, so a caller that catches
      // and keeps adding can never extend the accepted prefix past it.
      this.#rejected = true;
      if (error instanceof OverBudget) {
        return false;
      }
      throw error;
    }
    const reserve = this.#reserveOf(next);
    if (!this.#fits(0, reserve) || !this.#recordFits(next)) {
      this.#rejected = true;
      return false;
    }
    if (change !== undefined) {
      this.#log.push(change);
      if (next.kind === "single") {
        if (current.state.kind === "single") {
          this.#overlay.set(change.id, change.doc);
        } else {
          this.#overlay = new Map();
        }
      }
    }
    this.#checkpoints.push({ state: next, reserve, fetched: this.#read.length });
    return true;
  }

  /**
   * Accept the next entry in seq order as one that changes no row: an
   * entry the read path's fold skips, or one a pinned look-ahead holds
   * back. It takes a checkpoint equal to the current one, so the fold
   * still ends after {@link FoldPlanner.accepted} entries. It issues no
   * GET, but the first accepted entry must reserve publication of the
   * unchanged tree. Returns whether that reserve fits: after a rejection
   * or a {@link FoldPlanner.rollback}, it is refused like every later
   * change.
   */
  skip(): boolean {
    if (this.#rejected) {
      return false;
    }
    const { state } = this.#current;
    const reserve = this.#reserveOf(state);
    // Defensive: a skip adds no fresh node and reads nothing, so the last
    // accepted check already covers the record cap.
    if (!this.#fits(0, reserve) || !this.#recordFits(state)) {
      this.#rejected = true;
      return false;
    }
    this.#checkpoints.push({ state, reserve, fetched: this.#read.length });
    return true;
  }

  /**
   * Charge `calls` the fold issues outside the planner before the next
   * change, such as its log GETs, against the same budget. Returns
   * whether they fit with the reserve; when they do not, nothing is
   * charged and every later change is refused, so the fold ends here.
   *
   * @throws BaerlyError code="Internal" — `calls` is not a non-negative
   *   safe integer.
   */
  spend(calls: number): boolean {
    if (!Number.isSafeInteger(calls) || calls < 0) {
      return internal(`spend ${calls} calls`);
    }
    if (this.#rejected || !this.#fits(calls, this.#current.reserve)) {
      this.#rejected = true;
      return false;
    }
    this.#spentBetween += calls;
    return true;
  }

  /**
   * Read ahead, concurrently, the nodes that `mutations`, the next
   * changes in seq order, route to in the tree of the changes accepted
   * so far: for each level, the node each one's leaf path enters, from
   * the root down to the leaf. At most `parallelGets` GETs are in flight
   * at once. Each GET is charged as it is issued, and only while it fits
   * the budget with the current reserve, as a change's own GET is; when
   * one does not fit, prefetching stops there. A failed GET or a body
   * that does not decode is not reported here: the change that needs the
   * node reads it as usual and meets the failure then.
   *
   * Adds no change. After a rejection it reads nothing.
   */
  async prefetch(mutations: readonly TreeMutation[]): Promise<void> {
    const width = this.#input.parallelGets ?? TREE_FOLD_PARALLEL_GETS;
    const { state } = this.#current;
    if (width <= 1 || this.#rejected || state.kind !== "tree" || state.root.kind !== "branch") {
      return;
    }
    // A delete outside the document-ID domain is dropped unread.
    const ids = mutations.filter(({ id, doc }) => doc !== null || isDocId(id)).map(({ id }) => id);
    const { prefix } = this.#input;
    /** Branches of one level, each with the ids routed into it. */
    let frontier: { readonly children: readonly PlannedChild[]; readonly ids: string[] }[] = [
      { children: state.root.children, ids },
    ];
    for (let level = state.root.level - 1; level >= 0 && frontier.length > 0; level--) {
      const routed = new Map<PlannedChild, string[]>();
      for (const { children, ids: inBranch } of frontier) {
        for (const id of inBranch) {
          const child =
            children.find((c) => compareDocIds(id, childSummary(c).hi) <= 0) ?? children.at(-1)!;
          const into = routed.get(child);
          if (into === undefined) {
            routed.set(child, [id]);
          } else {
            into.push(id);
          }
        }
      }
      const reads: string[] = [];
      for (const child of routed.keys()) {
        if (child.kind === "reused") {
          const key = treeNodeKey(prefix, child.entry.attempt, child.entry.sha256);
          if (!this.#fetched.has(key) && !this.#prefetched.has(key)) {
            reads.push(key);
          }
        }
      }
      let fits = true;
      for (let start = 0; start < reads.length && fits; start += width) {
        const batch: Promise<Prefetched>[] = [];
        for (const key of reads.slice(start, start + width)) {
          if (!this.#fits(TREE_RETRIED_CALL_CHARGE, this.#current.reserve)) {
            fits = false;
            break;
          }
          this.#gets += 1;
          const got = (async () => this.#input.get(key))().then(
            (body): Prefetched => ({ ok: true, body }),
            (error: unknown): Prefetched => ({ ok: false, error }),
          );
          this.#prefetched.set(key, got);
          batch.push(got);
        }
        await Promise.all(batch);
      }
      if (!fits || level === 0) {
        break;
      }
      // Open the branches of this level; one that is unread, missing,
      // failed or does not decode ends its paths here.
      frontier = [];
      for (const [child, routedIds] of routed) {
        let children: readonly PlannedChild[] | null = null;
        if (child.kind === "fresh") {
          children = child.node.kind === "branch" ? child.node.children : null;
        } else {
          const decoded = await this.#peek(child.entry, level);
          children =
            decoded?.node.kind === "branch"
              ? decoded.node.children.map((entry): PlannedChild => ({ kind: "reused", entry }))
              : null;
        }
        if (children !== null) {
          frontier.push({ children, ids: routedIds });
        }
      }
    }
  }

  /** The node `entry` names at `level`, if read or prefetched and valid; never charges. */
  async #peek(entry: TreeChildEntry, level: number): Promise<DecodedTreeNode | null> {
    const key = treeNodeKey(this.#input.prefix, entry.attempt, entry.sha256);
    const read = this.#fetched.get(key);
    if (read !== undefined) {
      return read;
    }
    const got = await this.#prefetched.get(key);
    if (got === undefined || !got.ok) {
      return null;
    }
    const expected = { prefix: this.#input.prefix, root: false, level, entry };
    let decoded: DecodedTreeNode;
    try {
      decoded = await decodeNode(key, got.body, expected, this.#config);
    } catch {
      return null;
    }
    this.#peeked.set(key, { expected, decoded });
    return decoded;
  }

  /**
   * Pin the current checkpoint as the one a pending look-ahead falls
   * back to, and return its count of accepted changes. Until
   * {@link FoldPlanner.unpin}, every GET and every accepted change must
   * also fit the pinned checkpoint's reserve. While a checkpoint is
   * already pinned, the earlier pin stays.
   */
  pin(): number {
    this.#pinned ??= this.#checkpoints.length - 1;
    return this.#pinned;
  }

  /** Release the pin: the look-ahead it guarded is resolved. */
  unpin(): void {
    this.#pinned = null;
  }

  /**
   * Fall back to the pinned checkpoint: its plan and reserve become the
   * planner's, the GETs and calls charged since stay charged, and every
   * later change is refused. The charge then fits the budget.
   *
   * @throws BaerlyError code="Internal" — no checkpoint is pinned.
   */
  rollback(): void {
    const pinned = this.#pinned ?? internal("rollback without a pinned checkpoint");
    this.#checkpoints.length = pinned + 1;
    this.#pinned = null;
    this.#rejected = true;
  }

  get #current(): Checkpoint {
    return this.#checkpoints.at(-1)!;
  }

  /** Calls charged so far, without any reserve, plus `calls` more. */
  #spent(calls: number): number {
    return this.#input.spent + this.#spentBetween + this.#gets * TREE_RETRIED_CALL_CHARGE + calls;
  }

  /** `reserve`, or the pinned checkpoint's reserve while a pin is held and it is larger. */
  #heldReserve(reserve: number): number {
    const pinned = this.#pinned === null ? 0 : this.#checkpoints[this.#pinned]!.reserve;
    return Math.max(reserve, pinned);
  }

  /** Whether `calls` more fit the budget with `reserve` held, and the pinned reserve while one is pinned. */
  #fits(calls: number, reserve: number): boolean {
    return this.#spent(calls) + this.#heldReserve(reserve) <= this.#input.budget;
  }

  #reserveOf(state: PlannerState): number {
    return reserveFor(this.#freshOf(state));
  }

  /** Fresh nodes publishing `state` creates, the root included. */
  #freshOf(state: PlannerState): number {
    if (state.kind === "single") {
      return state.rows === 0 ? 0 : 1;
    }
    return state.fresh.reduce((total, n) => total + n, 1);
  }

  /**
   * Whether the fold record of a plan of `state`, over the nodes read so
   * far, fits {@link recordKeysFit}. A record lists every fresh node and
   * every superseded one, and only the captured root and the nodes the
   * plan read can be superseded, so their count bounds it.
   */
  #recordFits(state: PlannerState): boolean {
    const superseded = this.#input.root === null ? 0 : 1 + this.#read.length;
    const fit = this.#config.steps.recordKeysFit ?? recordKeysFit;
    return fit(this.#freshOf(state) + superseded);
  }

  #initialState(root: DecodedTreeNode | null): PlannerState {
    if (root === null) {
      return this.#single([], 0);
    }
    const totals = root.node.root;
    if (totals === null) {
      return internal(`captured node ${JSON.stringify(root.key)} is not a root`);
    }
    if (root.node.kind === "branch") {
      const counts = root.node.root!.levelNodes;
      return {
        kind: "tree",
        root: capturedBranch(root),
        counts,
        fresh: counts.map(() => 0),
        storedLevels: counts.length,
        rows: totals.rows,
        bytes: totals.bytes,
      };
    }
    const docs = root.node.docs.map(canonicalOf);
    if (this.#steps.singleLeaf(totals.rows, totals.bytes, this.#steps.layout)) {
      return this.#single(docs, 0);
    }
    return {
      kind: "tree",
      root: plannedLeaf(docs),
      counts: [],
      fresh: [],
      storedLevels: 0,
      rows: totals.rows,
      bytes: totals.bytes,
    };
  }

  /** A `single` state over `docs` (sorted), replaying changes from log index `start`. */
  #single(docs: readonly CanonicalDocument[], start: number): PlannerState {
    return {
      kind: "single",
      base: docs,
      index: new Map(docs.map((doc) => [doc.id, doc])),
      start,
      end: start,
      rows: docs.length,
      bytes: docs.reduce((total, doc) => total + doc.bytes, 0),
    };
  }

  /** The rows of a `single` state, with `extra` applied after its changes. */
  #singleDocs(
    state: PlannerState & { readonly kind: "single" },
    extra?: TreeMutation,
  ): CanonicalDocument[] {
    const survivors = new Map<string, TreeMutation>();
    for (const change of this.#log.slice(state.start, state.end)) {
      survivors.set(change.id, change);
    }
    if (extra !== undefined) {
      survivors.set(extra.id, extra);
    }
    return merged(state.base, orderedMutations([...survivors.values()], this.#steps));
  }

  #treeOf(state: PlannerState): PlannedTree | null {
    if (state.kind === "tree") {
      return { root: state.root, levelNodes: state.counts };
    }
    return state.rows === 0 ? null : { root: plannedLeaf(this.#singleDocs(state)), levelNodes: [] };
  }

  /** The state after `change`. */
  async #apply(state: PlannerState, change: TreeMutation): Promise<PlannerState> {
    const { layout } = this.#steps;
    if (state.kind === "single") {
      const before = this.#overlay.has(change.id)
        ? this.#overlay.get(change.id)!
        : (state.index.get(change.id) ?? null);
      const rows = state.rows - (before === null ? 0 : 1) + (change.doc === null ? 0 : 1);
      const bytes = state.bytes - (before?.bytes ?? 0) + (change.doc?.bytes ?? 0);
      if (rows === 0 || this.#steps.singleLeaf(rows, bytes, layout)) {
        return { ...state, end: state.end + 1, rows, bytes };
      }
      // Crossing the depth-0 limits upward chunks every row.
      const built = await buildTree(
        this.#singleDocs(state, change),
        this.#input.chunkKey,
        this.#config,
      );
      return this.#adoptBuilt(built!, rows, bytes);
    }

    const view = new TreeView(this.#input.prefix, state.root, this.#load, this.#docs, this.#record);
    const leaf = await view.seekLeaf(change.id);
    const docs = await view.docs(leaf);
    const present = docs.find((doc) => doc.id === change.id);
    if (
      change.doc === null
        ? present === undefined
        : present !== undefined && sameDocument(present, change.doc)
    ) {
      return state;
    }
    const delta: Totals = { rows: 0, bytes: 0 };
    const below = await leafPass(view, [change], this.#steps, delta, this.#adopt);
    const rows = state.rows + delta.rows;
    const bytes = state.bytes + delta.bytes;
    // The change is logged next, so a `single` state starts after it.
    const start = this.#log.length + 1;
    if (rows === 0) {
      return this.#single([], start);
    }
    if (this.#steps.singleLeaf(rows, bytes, layout)) {
      // Crossing the depth-0 limits downward reads every leaf.
      return this.#single(merged(await allDocs(view), [change]), start);
    }
    const { tree, fresh, carried } = await planLevels(
      view,
      below,
      state.counts,
      state.fresh,
      this.#steps,
      this.#adopt,
      (level, holds, gives) => {
        throw levelCountsMismatch(
          level < state.storedLevels ? this.#input.root : null,
          level,
          holds,
          gives,
        );
      },
    );
    return {
      kind: "tree",
      root: tree.root,
      counts: tree.levelNodes,
      fresh,
      storedLevels: Math.min(state.storedLevels, carried),
      rows,
      bytes,
    };
  }

  /** A freshly built tree as a `tree` state, reusing every read captured node it equals. */
  #adoptBuilt(tree: PlannedTree, rows: number, bytes: number): PlannerState {
    const fresh = tree.levelNodes.map(() => 0);
    const walk = (node: PlannedNode): PlannedNode => {
      if (node.kind === "leaf") {
        return node;
      }
      const children = node.children.map((child) => {
        if (child.kind !== "fresh") {
          return child;
        }
        const adopted = this.#adopt(walk(child.node));
        if (adopted.kind === "fresh") {
          fresh[node.level - 1] = fresh[node.level - 1]! + 1;
        }
        return adopted;
      });
      return plannedBranch(node.level, children);
    };
    return {
      kind: "tree",
      root: walk(tree.root),
      counts: tree.levelNodes,
      fresh,
      storedLevels: 0,
      rows,
      bytes,
    };
  }

  /**
   * Read a node once: take its prefetched body, whose GET is already
   * charged, or read it through `get`, charging the GET if it fits.
   */
  readonly #load: NodeLoader = async (key, expected) => {
    const cached = this.#fetched.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const prefetched = this.#prefetched.get(key);
    let body: Uint8Array | null;
    if (prefetched !== undefined) {
      this.#prefetched.delete(key);
      const peeked = this.#peeked.get(key);
      this.#peeked.delete(key);
      const got = await prefetched;
      if (!got.ok) {
        throw got.error;
      }
      body = got.body;
      if (peeked !== undefined && sameExpectation(peeked.expected, expected)) {
        // Decoding is a pure function of the key, the body and these
        // checks, so the routing decode stands for this one.
        return this.#take(key, peeked.decoded);
      }
    } else {
      if (!this.#fits(TREE_RETRIED_CALL_CHARGE, this.#current.reserve)) {
        throw new OverBudget();
      }
      this.#gets += 1;
      body = await this.#input.get(key);
    }
    return this.#take(key, await decodeNode(key, body, expected, this.#config));
  };

  /** Record `decoded` as read, in read order. */
  #take(key: string, decoded: DecodedTreeNode): DecodedTreeNode {
    this.#fetched.set(key, decoded);
    this.#read.push(decoded);
    return decoded;
  }

  readonly #record: OnRead = (level, entry, decoded) => {
    let byLo = this.#readNodes.get(level);
    if (byLo === undefined) {
      byLo = new Map();
      this.#readNodes.set(level, byLo);
    }
    byLo.set(entry.lo, { entry, decoded });
  };

  /** Reuse the read captured node at `node`'s level and `lo` when `node` equals it. */
  readonly #adopt: Adopt = (node) => {
    const old = this.#readNodes.get(node.level)?.get(node.summary.lo);
    if (old !== undefined && this.#equalsRead(node, old)) {
      return { kind: "reused", entry: old.entry };
    }
    return { kind: "fresh", node };
  };

  #equalsRead(node: PlannedNode, old: ReadNode): boolean {
    const { summary } = node;
    const { entry } = old;
    if (summary.hi !== entry.hi || summary.rows !== entry.rows || summary.bytes !== entry.bytes) {
      return false;
    }
    const body = old.decoded.node;
    if (node.kind === "leaf") {
      if (body.kind !== "leaf") {
        return false;
      }
      const docs = leafDocs(old.decoded, this.#docs);
      return (
        node.docs.length === docs.length && node.docs.every((doc, i) => sameDocument(doc, docs[i]!))
      );
    }
    return (
      body.kind === "branch" &&
      node.children.length === body.children.length &&
      node.children.every((child, i) => child.kind === "reused" && child.entry === body.children[i])
    );
  }
}
