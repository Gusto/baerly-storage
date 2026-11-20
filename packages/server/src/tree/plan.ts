/**
 * Fold planner of the prototype tree: captured tree + mutations →
 * the canonical tree of the new row set, rewriting only the changed
 * paths and their resync neighbours and reusing every other node.
 *
 * The result is exactly `buildTree` of the new row set
 * (`tests/unit/tree-fold-plan*.test.ts` check this). It relies on the
 * chunkers resetting at every cut, so re-chunking can start at an old
 * node boundary and stop at one:
 *
 * - **Restart.** A change re-chunks from the start of the old node that
 *   holds its first changed entry, or that would hold it: the first old
 *   node whose `hi` is not below it, else the last node of the level.
 *   The end of a level is not a cut, so a change past the last node
 *   re-chunks that node. At the leaf level a cut before an isolated
 *   document read that document's size, so a change at or just before
 *   an isolated leaf also re-chunks the leaf before it.
 * - **Resync.** Re-chunking stops at the start of an old node once its
 *   chunker is empty there and no pending change falls in or before that
 *   node. Everything after is chunked as before, so the old nodes are
 *   reused until the next change's restart point.
 * - **Whole-level rules.** The depth-0 rule and the root rule depend on
 *   a whole level. Crossing the depth-0 limits downward reads every
 *   leaf. Each level's new node count is the captured root's
 *   `level_nodes` count, less the old nodes replaced there, plus the
 *   fresh ones; a level of at most `branchFanoutMax` nodes is regrouped
 *   into the root, which reads the old nodes one level up.
 *
 * Every node the planner reads comes through `get` and is strictly
 * decoded against the entry that routed to it, and every reused entry
 * is copied from such a node or from the captured root, so a reused ref
 * is always live under the captured root. The root is always fresh: it
 * carries the new fold end.
 *
 * {@link FoldPlanner} adds a fold's changes one at a time in seq order,
 * charging every node GET as it is issued and the publication's calls
 * as a reserve, so the fold can stop at the last change that fits its
 * request ledger.
 */
import { BaerlyError, encodeJsonBytes } from "@baerly/protocol";
import { assertSnapshotDocId, compareDocIds } from "../snapshot-doc-id.ts";
import {
  assembleLevels,
  BranchChunker,
  buildTree,
  type ChunkSteps,
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
import { type ChunkKey, chunkHash } from "./chunk.ts";
import { TREE_HEAD_CAS_CHARGE, TREE_RETRIED_CALL_CHARGE } from "./constants.ts";
import { treeNodeKey } from "./key.ts";
import { DEFAULT_TREE_CONFIG, type TreeConfig, type TreeLayout } from "./layout.ts";
import {
  type CanonicalDocument,
  type DecodedTreeNode,
  decodeNode,
  type TreeChildEntry,
  type TreeDocument,
  type TreeNodeExpectation,
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
}

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

const planSteps = (config: TreeConfig, key: ChunkKey): PlanSteps => ({
  ...chunkSteps(config, key),
  sortMutations: config.steps.sortMutations ?? sortMutationsById,
  leafRestartsBefore: config.steps.leafRestartsBefore ?? leafIsIsolated,
  resyncStops: config.steps.resyncStops ?? resyncWhenEmpty,
});

const internal = (detail: string): never => {
  throw new BaerlyError("Internal", `tree fold plan: ${detail}`);
};

// ---------------------------------------------------------------------
// The captured tree, read lazily
// ---------------------------------------------------------------------

/** A node of the captured tree. Its body is read on first use. */
interface OldNode {
  readonly level: number;
  /** The entry that names this node in its parent; `null` for the root. */
  readonly entry: TreeChildEntry | null;
  readonly parent: OldNode | null;
  /** Position among the parent's children. */
  readonly index: number;
  decoded: DecodedTreeNode | null;
  /** The children, once a branch body is read. */
  children: OldNode[] | null;
}

/** An old run of one level replaced by fresh nodes. */
interface Splice<N extends PlannedNode> {
  /** First and last old node replaced, in level order. */
  readonly first: OldNode;
  readonly last: OldNode;
  /** How many old nodes the run holds. */
  readonly count: number;
  readonly fresh: readonly N[];
}

const canonicalOf = (doc: TreeDocument): CanonicalDocument => ({
  doc,
  id: doc._id,
  bytes: encodeJsonBytes(doc).byteLength,
});

/** Level order of two old nodes of one level: their ranges are disjoint. */
const compareNodes = (a: OldNode, b: OldNode): number => compareDocIds(a.entry!.lo, b.entry!.lo);

/** Read and strictly decode one node of the captured tree. */
type NodeLoader = (key: string, expected: TreeNodeExpectation) => Promise<DecodedTreeNode>;

class CapturedTree {
  readonly root: OldNode;
  readonly read: DecodedTreeNode[] = [];
  readonly #prefix: string;
  readonly #loadNode: NodeLoader;

  constructor(prefix: string, root: DecodedTreeNode, loadNode: NodeLoader) {
    this.#prefix = prefix;
    this.#loadNode = loadNode;
    this.root = {
      level: root.node.level,
      entry: null,
      parent: null,
      index: 0,
      decoded: root,
      children: null,
    };
    this.#adopt(this.root, root);
  }

  #adopt(node: OldNode, decoded: DecodedTreeNode): void {
    node.decoded = decoded;
    if (decoded.node.kind === "branch") {
      node.children = decoded.node.children.map((entry, index) => ({
        level: node.level - 1,
        entry,
        parent: node,
        index,
        decoded: null,
        children: null,
      }));
    }
  }

  /** Read and strictly decode `node` against the entry that routed to it. */
  async load(node: OldNode): Promise<DecodedTreeNode> {
    if (node.decoded !== null) {
      return node.decoded;
    }
    const entry = node.entry!;
    const decoded = await this.#loadNode(treeNodeKey(this.#prefix, entry.attempt, entry.sha256), {
      prefix: this.#prefix,
      root: false,
      level: node.level,
      entry,
    });
    this.read.push(decoded);
    this.#adopt(node, decoded);
    return decoded;
  }

  async #children(node: OldNode): Promise<OldNode[]> {
    await this.load(node);
    return node.children!;
  }

  /** The node after `node` on its level, or `null` at the level's end. */
  async next(node: OldNode): Promise<OldNode | null> {
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
  async prev(node: OldNode): Promise<OldNode | null> {
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
  async first(level: number): Promise<OldNode> {
    let node = this.root;
    while (node.level > level) {
      const children = await this.#children(node);
      node = children[0]!;
    }
    return node;
  }

  /** The first leaf whose `hi` is not below `id`, else the last leaf. */
  async seekLeaf(id: string): Promise<OldNode> {
    let node = this.root;
    while (node.level > 0) {
      const children = await this.#children(node);
      node = children.find((child) => compareDocIds(id, child.entry!.hi) <= 0) ?? children.at(-1)!;
    }
    return node;
  }

  /** The documents of the old leaf `node`. */
  async docs(node: OldNode): Promise<CanonicalDocument[]> {
    const decoded = await this.load(node);
    if (decoded.node.kind !== "leaf") {
      return internal(`node at level ${node.level} is not a leaf`);
    }
    return decoded.node.docs.map(canonicalOf);
  }

  /**
   * Every node of the new `level`, in order: the old nodes with each
   * splice's run replaced by its fresh nodes. Reads every old node one
   * level up.
   */
  async levelItems(
    level: number,
    splices: readonly Splice<PlannedNode>[],
  ): Promise<{ readonly child: PlannedChild; readonly old: OldNode | null }[]> {
    const items: { child: PlannedChild; old: OldNode | null }[] = [];
    let si = 0;
    let node: OldNode | null = await this.first(level);
    while (node !== null) {
      const splice = splices[si];
      if (splice !== undefined && node === splice.first) {
        for (const fresh of splice.fresh) {
          items.push({ child: { kind: "fresh", node: fresh }, old: null });
        }
        si += 1;
        node = await this.next(splice.last);
        continue;
      }
      items.push({ child: { kind: "reused", entry: node.entry! }, old: node });
      node = await this.next(node);
    }
    return items;
  }

  /** The old node `node` as a fresh planned node, so it can become a root. */
  async materialize(node: OldNode): Promise<PlannedNode> {
    const decoded = await this.load(node);
    if (decoded.node.kind === "leaf") {
      return plannedLeaf(decoded.node.docs.map(canonicalOf));
    }
    return plannedBranch(
      decoded.node.level,
      decoded.node.children.map((entry) => ({ kind: "reused", entry })),
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
 * Apply `mutations` (sorted) to `docs` (sorted), calling `emit` for each
 * resulting document in order, and add the change in totals to `delta`.
 */
const mergeInto = async (
  docs: readonly CanonicalDocument[],
  mutations: readonly TreeMutation[],
  delta: Totals,
  emit: (doc: CanonicalDocument) => Promise<void> | void,
): Promise<void> => {
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
      await emit(old!);
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
      await emit(mutation!.doc);
    }
    m += 1;
  }
};

// ---------------------------------------------------------------------
// Level passes
// ---------------------------------------------------------------------

/** Where re-chunking for a change at `id` starts on the leaf level. */
const leafRestart = async (tree: CapturedTree, id: string, steps: PlanSteps): Promise<OldNode> => {
  const leaf = await tree.seekLeaf(id);
  if (
    compareDocIds(id, leaf.entry!.hi) <= 0 &&
    steps.leafRestartsBefore(leaf.entry!, steps.layout)
  ) {
    return (await tree.prev(leaf)) ?? leaf;
  }
  return leaf;
};

/** Re-chunk the leaf level around every mutation. */
const leafPass = async (
  tree: CapturedTree,
  mutations: readonly TreeMutation[],
  steps: PlanSteps,
  delta: Totals,
): Promise<Splice<PlannedLeaf>[]> => {
  const splices: Splice<PlannedLeaf>[] = [];
  let mi = 0;
  let restart = mutations.length > 0 ? await leafRestart(tree, mutations[0]!.id, steps) : null;
  while (restart !== null) {
    const first = restart;
    const fresh: PlannedLeaf[] = [];
    const chunker = new LeafChunker(steps, fresh);
    let leaf = first;
    let count = 0;
    restart = null;
    for (;;) {
      const docs = await tree.docs(leaf);
      count += 1;
      const next = await tree.next(leaf);
      // This leaf takes every pending mutation up to its `hi`; the last
      // leaf takes the rest, since the level's end is not a cut.
      let end = mutations.length;
      if (next !== null) {
        end = mi;
        while (end < mutations.length && compareDocIds(mutations[end]!.id, leaf.entry!.hi) <= 0) {
          end += 1;
        }
      }
      await mergeInto(docs, mutations.slice(mi, end), delta, (doc) => chunker.push(doc));
      mi = end;
      if (next === null) {
        chunker.flush();
        break;
      }
      const pending =
        mi < mutations.length ? await leafRestart(tree, mutations[mi]!.id, steps) : null;
      if (pending === null || compareNodes(pending, next) > 0) {
        if (steps.resyncStops(chunker.empty)) {
          chunker.flush();
          restart = pending;
          break;
        }
      }
      leaf = next;
    }
    splices.push({ first, last: leaf, count, fresh });
  }
  return splices;
};

/**
 * Re-chunk branch `level`, which the old tree chunked, around every
 * splice of the level below.
 */
const branchPass = async (
  tree: CapturedTree,
  level: number,
  below: readonly Splice<PlannedNode>[],
  steps: PlanSteps,
): Promise<Splice<PlannedBranch>[]> => {
  const splices: Splice<PlannedBranch>[] = [];
  let si = 0;
  while (si < below.length) {
    const first = below[si]!.first.parent!;
    const fresh: PlannedBranch[] = [];
    const chunker = new BranchChunker(level, steps, fresh);
    let parent = first;
    let count = 1;
    let cur: OldNode | null = first.children![0]!;
    for (;;) {
      if (cur === null) {
        chunker.flush();
        break;
      }
      if (cur.parent !== parent) {
        // At the start of the next old node of this level.
        const pending = below[si];
        if (pending === undefined || compareNodes(pending.first.parent!, cur.parent!) > 0) {
          if (steps.resyncStops(chunker.empty)) {
            chunker.flush();
            break;
          }
        }
        parent = cur.parent!;
        count += 1;
      }
      const splice = below[si];
      if (splice !== undefined && cur === splice.first) {
        for (const node of splice.fresh) {
          await chunker.push({ kind: "fresh", node });
        }
        si += 1;
        while (parent !== splice.last.parent) {
          parent = (await tree.next(parent))!;
          count += 1;
        }
        cur = await tree.next(splice.last);
        continue;
      }
      await chunker.push({ kind: "reused", entry: cur.entry! });
      cur = await tree.next(cur);
    }
    splices.push({ first, last: parent, count, fresh });
  }
  return splices;
};

// ---------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------

/** Every document of the old tree, read leaf by leaf. */
const allDocs = async (tree: CapturedTree): Promise<CanonicalDocument[]> => {
  const docs: CanonicalDocument[] = [];
  for (
    let leaf: OldNode | null = await tree.first(0);
    leaf !== null;
    leaf = await tree.next(leaf)
  ) {
    docs.push(...(await tree.docs(leaf)));
  }
  return docs;
};

/** The documents of `docs` with `mutations` applied. */
const merged = async (
  docs: readonly CanonicalDocument[],
  mutations: readonly TreeMutation[],
): Promise<CanonicalDocument[]> => {
  const out: CanonicalDocument[] = [];
  await mergeInto(docs, mutations, { rows: 0, bytes: 0 }, (doc) => {
    out.push(doc);
  });
  return out;
};

/** Plan `mutations` against the captured root, reading nodes through `loadNode`. */
const planWith = async (
  prefix: string,
  captured: DecodedTreeNode | null,
  mutations: readonly TreeMutation[],
  steps: PlanSteps,
  key: ChunkKey,
  config: TreeConfig,
  loadNode: NodeLoader,
): Promise<TreeFoldPlan> => {
  if (captured === null) {
    return { tree: await buildTree(await merged([], mutations), key, config), read: [] };
  }
  const totals = captured.node.root;
  if (totals === null) {
    return internal(`captured node ${JSON.stringify(captured.key)} is not a root`);
  }
  if (captured.node.kind === "leaf") {
    const docs = await merged(captured.node.docs.map(canonicalOf), mutations);
    return { tree: await buildTree(docs, key, config), read: [] };
  }
  const oldCounts = (totals as { readonly levelNodes: readonly number[] }).levelNodes;

  const tree = new CapturedTree(prefix, captured, loadNode);
  const depth = tree.root.level;
  const delta: Totals = { rows: 0, bytes: 0 };
  let below: readonly Splice<PlannedNode>[] = await leafPass(tree, mutations, steps, delta);

  const rows = totals.rows + delta.rows;
  if (rows === 0) {
    return { tree: null, read: tree.read };
  }
  if (steps.singleLeaf(rows, totals.bytes + delta.bytes, steps.layout)) {
    // Crossing the depth-0 limits downward rebuilds the whole leaf level.
    const docs = await merged(await allDocs(tree), mutations);
    return { tree: await buildTree(docs, key, config), read: tree.read };
  }

  const newCounts: number[] = [];
  for (let level = 0; ; level++) {
    // The new node count of `level`: the captured count, less the old
    // nodes replaced there, plus the fresh ones.
    const count = below.reduce(
      (total, splice) => total + splice.fresh.length - splice.count,
      oldCounts[level]!,
    );
    // Below the root's children the old level held more than
    // branchFanoutMax nodes and was chunked; it stays chunked while the
    // new level does too.
    if (level + 1 < depth && count > steps.layout.branchFanoutMax) {
      newCounts.push(count);
      below = await branchPass(tree, level + 1, below, steps);
      continue;
    }
    // Otherwise the new level is regrouped from all its nodes.
    const items = await tree.levelItems(level, below);
    if (items.length !== count) {
      // The captured root's level_nodes disagree with the nodes it routes to.
      throw new BaerlyError(
        "InvalidResponse",
        `tree fold plan: captured root ${JSON.stringify(captured.key)} records level_nodes ${JSON.stringify(oldCounts)}, but level ${level} holds ${items.length} nodes where those counts give ${count}`,
      );
    }
    const { top, levelNodes } = await assembleLevels(
      items.map((item) => item.child),
      level,
      steps,
    );
    const counts = [...newCounts, ...levelNodes];
    if (top.kind === "fresh") {
      return { tree: { root: top.node, levelNodes: counts }, read: tree.read };
    }
    const old = items.find((item) => item.child === top)!.old!;
    return { tree: { root: await tree.materialize(old), levelNodes: counts }, read: tree.read };
  }
};

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

/**
 * Calls reserved to publish `tree`: per fresh node, its create PUT and
 * the GET that adopts it when the create's acknowledgement was lost and
 * its retry met a 412; then the head CAS and the head re-read that
 * resolves its fate.
 */
export const publicationReserve = (tree: PlannedTree | null): number =>
  (tree === null ? 0 : freshNodeCount(tree.root)) *
    (TREE_RETRIED_CALL_CHARGE + TREE_RETRIED_CALL_CHARGE) +
  TREE_HEAD_CAS_CHARGE +
  TREE_RETRIED_CALL_CHARGE;

/**
 * `config` with its chunk hash memoised for one {@link FoldPlanner}, so
 * re-planning the accepted changes does not re-hash unchanged IDs. The
 * cache is keyed by chunk key, then level, then `_id`, so hashes under
 * different salts or levels never mix. The hashes are unchanged.
 */
const memoizedHashConfig = (config: TreeConfig): TreeConfig => {
  const hash = config.steps.chunkHash ?? chunkHash;
  const memo = new Map<ChunkKey, Map<number, Map<string, number>>>();
  const memoized = async (key: ChunkKey, level: number, id: string): Promise<number> => {
    let byLevel = memo.get(key);
    if (byLevel === undefined) {
      byLevel = new Map();
      memo.set(key, byLevel);
    }
    let byId = byLevel.get(level);
    if (byId === undefined) {
      byId = new Map();
      byLevel.set(level, byId);
    }
    const cached = byId.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const value = await hash(key, level, id);
    byId.set(id, value);
    return value;
  };
  return Object.freeze({
    layout: config.layout,
    steps: Object.freeze({ ...config.steps, chunkHash: memoized }),
  });
};

/** Input to {@link FoldPlanner}. */
export interface FoldPlannerInput extends Omit<PlanFoldInput, "mutations"> {
  /** Calls the request ledger allows this fold tick in total. */
  readonly budget: number;
  /** Calls already charged before planning: the head GET and the root GET. */
  readonly spent: number;
}

/**
 * Thrown inside a re-plan when its next node GET would not fit, and
 * caught by {@link FoldPlanner.add}; it never escapes the planner.
 */
class OverBudget extends Error {
  constructor() {
    super("tree fold plan: the next node GET would overrun the request ledger");
  }
}

/**
 * Plans a fold one change at a time, in seq order, against a request
 * ledger. Each {@link FoldPlanner.add} re-plans every change accepted so
 * far plus the new one, reusing the nodes already fetched, so only
 * nodes no earlier plan needed cost a GET. Before each node GET it checks
 * that the GET and the last accepted plan's {@link publicationReserve}
 * still fit; after the plan it checks that every GET issued so far plus
 * the new plan's reserve fits. A change that fails either check is
 * rejected: the fold ends before its seq and publishes the last accepted
 * plan, and the GETs issued for it stay charged.
 */
export class FoldPlanner {
  readonly #input: FoldPlannerInput;
  readonly #config: TreeConfig;
  readonly #steps: PlanSteps;
  readonly #fetched = new Map<string, DecodedTreeNode>();
  readonly #survivors = new Map<string, TreeMutation>();
  #gets = 0;
  #accepted: TreeFoldPlan | null = null;
  #acceptedReserve = 0;
  #rejected = false;

  constructor(input: FoldPlannerInput) {
    this.#input = input;
    this.#config = memoizedHashConfig(input.config ?? DEFAULT_TREE_CONFIG);
    this.#steps = planSteps(this.#config, input.chunkKey);
  }

  /** The last accepted plan, or `null` while no change has been accepted. */
  get plan(): TreeFoldPlan | null {
    return this.#accepted;
  }

  /**
   * Calls charged so far: those charged before planning, every node GET
   * issued (rejected changes included) and the reserve to publish the
   * last accepted plan.
   */
  get charge(): number {
    return this.#input.spent + this.#gets * TREE_RETRIED_CALL_CHARGE + this.#acceptedReserve;
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
    const survivors = new Map(this.#survivors).set(mutation.id, mutation);
    let plan: TreeFoldPlan;
    let reserve: number;
    try {
      plan = await planWith(
        this.#input.prefix,
        this.#input.root,
        orderedMutations([...survivors.values()], this.#steps),
        this.#steps,
        this.#input.chunkKey,
        this.#config,
        this.#chargedLoader(),
      );
      reserve = publicationReserve(plan.tree);
    } catch (error) {
      // A change that throws is rejected too, so a caller that catches
      // and keeps adding can never extend the accepted prefix past it.
      this.#rejected = true;
      if (error instanceof OverBudget) {
        return false;
      }
      throw error;
    }
    if (this.#input.spent + this.#gets * TREE_RETRIED_CALL_CHARGE + reserve > this.#input.budget) {
      this.#rejected = true;
      return false;
    }
    for (const [id, change] of survivors) {
      this.#survivors.set(id, change);
    }
    this.#accepted = plan;
    this.#acceptedReserve = reserve;
    return true;
  }

  #chargedLoader(): NodeLoader {
    const decode = decodingLoader(this.#input.get, this.#config);
    return async (key, expected) => {
      const cached = this.#fetched.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const charged =
        this.#input.spent + (this.#gets + 1) * TREE_RETRIED_CALL_CHARGE + this.#acceptedReserve;
      if (charged > this.#input.budget) {
        throw new OverBudget();
      }
      this.#gets += 1;
      const decoded = await decode(key, expected);
      this.#fetched.set(key, decoded);
      return decoded;
    };
  }
}
