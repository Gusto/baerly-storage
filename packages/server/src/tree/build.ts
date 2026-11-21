/**
 * Canonical builder of the prototype tree: row set → tree.
 *
 * The canonical tree is a pure function of the row set, the layout and
 * the collection's chunk salt, through its chunk key. It never depends
 * on fold history, attempt identity, the collection name or the host.
 * A row is its canonical document bytes, which keep the writer's key
 * order, so two rows that differ only in key order are different rows.
 *
 * 1. Sort the documents by `_id` in `utf8-scalar-v1` order.
 * 2. Depth-0 rule: while the row count is at most `singleLeafMaxRows`
 *    and the document bytes at most `singleLeafMaxBytes` (both
 *    inclusive), every document goes in one root leaf, with no
 *    isolation.
 * 3. Otherwise cut the leaf level by content-defined chunking: a
 *    document of at least `leafIsolationDocumentBytes` sits alone in its
 *    leaf (a cut before and after it); every other document is appended
 *    and the leaf is cut after it when `cutLeaf` passes, which it always
 *    does once the leaf reaches `leafMaxBytes`. A row set that this
 *    makes one chunk is still one root leaf.
 * 4. Above the leaves, level by level: a level of at most
 *    `branchFanoutMax` nodes is grouped into one parent (the root rule);
 *    a larger one is cut after an entry once the node holds
 *    `branchFanoutMin` entries and the chunk hash of the entry's `hi` at
 *    that level passes, or when it holds `branchFanoutMax` entries.
 * 5. The single node left is the root. A root branch records how many
 *    nodes each level below it holds.
 *
 * The cut predicates and the chunk hash live in `./chunk.ts`; the loops,
 * isolation and the entry counting live here, and the fold planner
 * (`./plan.ts`) reuses the same chunkers. A built tree is identity-free
 * until {@link sealTree} encodes it under one attempt identity.
 */
import { BaerlyError } from "@baerly/protocol";
import { compareDocIds } from "../snapshot-doc-id.ts";
import { branchHashCuts, type ChunkKey, chunkHash, cutLeaf } from "./chunk.ts";
import { TREE_MAX_LEVEL } from "./constants.ts";
import { collectionOfPrefix } from "./key.ts";
import { DEFAULT_TREE_CONFIG, type TreeConfig, type TreeLayout } from "./layout.ts";
import {
  type CanonicalDocument,
  sealNode,
  type SealedTreeNode,
  type TreeChildEntry,
  type TreeNode,
  type TreeNodeSummary,
} from "./node-codec.ts";

// ---------------------------------------------------------------------
// Planned trees
// ---------------------------------------------------------------------

/** A leaf of a planned tree: canonical documents in `_id` order. */
export interface PlannedLeaf {
  readonly kind: "leaf";
  readonly level: 0;
  readonly docs: readonly CanonicalDocument[];
  readonly summary: TreeNodeSummary;
}

/** A branch of a planned tree. */
export interface PlannedBranch {
  readonly kind: "branch";
  readonly level: number;
  readonly children: readonly PlannedChild[];
  readonly summary: TreeNodeSummary;
}

/** A node a publication creates: identity-free until it is sealed. */
export type PlannedNode = PlannedLeaf | PlannedBranch;

/**
 * A child of a planned branch: a node this publication creates, or an
 * existing node referenced by an entry copied from a node of the
 * captured tree.
 */
export type PlannedChild =
  | { readonly kind: "fresh"; readonly node: PlannedNode }
  | { readonly kind: "reused"; readonly entry: TreeChildEntry };

/** A planned tree: its fresh root and the node count of every level below it. */
export interface PlannedTree {
  readonly root: PlannedNode;
  /**
   * `levelNodes[ℓ]` is the number of nodes at level ℓ, fresh and reused,
   * for ℓ = 0 up to the root's level − 1. Empty for a root leaf.
   */
  readonly levelNodes: readonly number[];
}

/** What a child covers: the values its parent entry records. */
export const childSummary = (child: PlannedChild): TreeNodeSummary =>
  child.kind === "fresh" ? child.node.summary : child.entry;

/** A planned leaf over `docs`, which must be non-empty and in `_id` order. */
export const plannedLeaf = (docs: readonly CanonicalDocument[]): PlannedLeaf => ({
  kind: "leaf",
  level: 0,
  docs,
  summary: {
    lo: docs[0]!.id,
    hi: docs.at(-1)!.id,
    rows: docs.length,
    bytes: docs.reduce((total, doc) => total + doc.bytes, 0),
  },
});

/** A planned branch at `level` over `children`, which must be non-empty and in order. */
export const plannedBranch = (level: number, children: readonly PlannedChild[]): PlannedBranch => {
  let rows = 0;
  let bytes = 0;
  for (const child of children) {
    const summary = childSummary(child);
    rows += summary.rows;
    bytes += summary.bytes;
  }
  return {
    kind: "branch",
    level,
    children,
    summary: {
      lo: childSummary(children[0]!).lo,
      hi: childSummary(children.at(-1)!).hi,
      rows,
      bytes,
    },
  };
};

/** How many fresh nodes a planned tree holds, the root included. */
export const freshNodeCount = (node: PlannedNode): number =>
  node.kind === "leaf"
    ? 1
    : node.children.reduce(
        (total, child) => total + (child.kind === "fresh" ? freshNodeCount(child.node) : 0),
        1,
      );

// ---------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------

/**
 * The branch cut after the node's `count`-th entry: forced at
 * `branchFanoutMax` entries; otherwise a hash cut once the node holds
 * `branchFanoutMin` entries. It reads only the count and the hash of
 * the entry's `hi`, never `rows`, `bytes` or refs.
 */
export const cutBranch = (count: number, hash: number, layout: TreeLayout): boolean =>
  count === layout.branchFanoutMax ||
  (count >= layout.branchFanoutMin && branchHashCuts(hash, layout));

/** The depth-0 rule, inclusive on both axes. A 0 limit disables it. */
export const singleLeafApplies = (rows: number, bytes: number, layout: TreeLayout): boolean =>
  rows <= layout.singleLeafMaxRows && bytes <= layout.singleLeafMaxBytes;

/** Whether a document of `bytes` document bytes is isolated in its own leaf. */
export const isIsolatedDocument = (bytes: number, layout: TreeLayout): boolean =>
  bytes >= layout.leafIsolationDocumentBytes;

/**
 * The chunking steps in force for a config (its overrides, else the
 * built-in steps), bound to one collection's chunk key.
 */
export interface ChunkSteps {
  readonly layout: TreeLayout;
  /** `h(level, id)` under the collection's chunk key. */
  readonly hash: (level: number, id: string) => Promise<number>;
  readonly orderIds: (a: string, b: string) => number;
  readonly isolates: (bytes: number, layout: TreeLayout) => boolean;
  readonly leafCut: (before: number, after: number, hash: number, layout: TreeLayout) => boolean;
  readonly branchCut: (count: number, hash: number, layout: TreeLayout) => boolean;
  readonly singleLeaf: (rows: number, bytes: number, layout: TreeLayout) => boolean;
}

/**
 * Resolve the chunking steps of `config` for the collection whose chunk
 * key is `key` (from `importChunkKey` over its salt, once per
 * invocation).
 */
export const chunkSteps = (config: TreeConfig, key: ChunkKey): ChunkSteps => {
  const hash = config.steps.chunkHash ?? chunkHash;
  return {
    layout: config.layout,
    hash: (level, id) => hash(key, level, id),
    orderIds: config.steps.orderIds ?? compareDocIds,
    isolates: config.steps.isolates ?? isIsolatedDocument,
    leafCut: config.steps.leafCut ?? cutLeaf,
    branchCut: config.steps.branchCut ?? cutBranch,
    singleLeaf: config.steps.singleLeaf ?? singleLeafApplies,
  };
};

// ---------------------------------------------------------------------
// Chunkers
// ---------------------------------------------------------------------

/**
 * Leaf-level content-defined chunking, one document at a time. Every
 * closed leaf is appended to `out`. The state resets at every cut, so a
 * chunker started at an old leaf boundary continues the canonical
 * chunking of everything after it.
 */
export class LeafChunker {
  readonly #steps: ChunkSteps;
  readonly #out: PlannedLeaf[];
  #current: CanonicalDocument[] = [];
  #bytes = 0;

  constructor(steps: ChunkSteps, out: PlannedLeaf[]) {
    this.#steps = steps;
    this.#out = out;
  }

  /** Whether the chunker holds no document since its last cut. */
  get empty(): boolean {
    return this.#current.length === 0;
  }

  /** Append the next document, which must sort after every one pushed so far. */
  async push(doc: CanonicalDocument): Promise<void> {
    const { layout } = this.#steps;
    if (this.#steps.isolates(doc.bytes, layout)) {
      this.flush();
      this.#out.push(plannedLeaf([doc]));
      return;
    }
    const before = this.#bytes;
    this.#bytes += doc.bytes;
    this.#current.push(doc);
    if (this.#steps.leafCut(before, this.#bytes, await this.#steps.hash(0, doc.id), layout)) {
      this.flush();
    }
  }

  /** Close the current leaf, if it holds any document. */
  flush(): void {
    if (this.#current.length > 0) {
      this.#out.push(plannedLeaf(this.#current));
      this.#current = [];
      this.#bytes = 0;
    }
  }
}

/**
 * Branch-level content-defined chunking at one level, one entry at a
 * time. Every closed node is appended to `out`. As for leaves, the state
 * resets at every cut, and branch cuts never look ahead.
 */
export class BranchChunker {
  readonly #level: number;
  readonly #steps: ChunkSteps;
  readonly #out: PlannedBranch[];
  #current: PlannedChild[] = [];

  constructor(level: number, steps: ChunkSteps, out: PlannedBranch[]) {
    this.#level = level;
    this.#steps = steps;
    this.#out = out;
  }

  /** Whether the chunker holds no entry since its last cut. */
  get empty(): boolean {
    return this.#current.length === 0;
  }

  /** Append the next entry, which must sort after every one pushed so far. */
  async push(child: PlannedChild): Promise<void> {
    this.#current.push(child);
    const hash = await this.#steps.hash(this.#level, childSummary(child).hi);
    if (this.#steps.branchCut(this.#current.length, hash, this.#steps.layout)) {
      this.flush();
    }
  }

  /** Close the current node, if it holds any entry. */
  flush(): void {
    if (this.#current.length > 0) {
      this.#out.push(plannedBranch(this.#level, this.#current));
      this.#current = [];
    }
  }
}

// ---------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------

const internal = (detail: string): never => {
  throw new BaerlyError("Internal", `tree build: ${detail}`);
};

/**
 * Stack the level-`level` nodes `items` into parents until one is left:
 * a level of at most `branchFanoutMax` nodes is grouped into one parent
 * (the root rule), a larger one is branch-chunked. Returns the single
 * remaining child, which is `items[0]` itself when there is only one,
 * and the node count of every level from `level` up to below it.
 *
 * `adopt` turns each node a branch-chunked level emits into the child
 * its parent holds; the default holds it as a fresh node. The parent
 * grouped by the root rule is always fresh.
 *
 * @throws BaerlyError code="Internal" — `items` is empty, or the tree
 *   would exceed `TREE_MAX_LEVEL`.
 */
export const assembleLevels = async (
  items: readonly PlannedChild[],
  level: number,
  steps: ChunkSteps,
  adopt: (node: PlannedBranch) => PlannedChild = (node) => ({ kind: "fresh", node }),
): Promise<{ readonly top: PlannedChild; readonly levelNodes: readonly number[] }> => {
  if (items.length === 0) {
    internal("no nodes to assemble");
  }
  const levelNodes: number[] = [];
  let current = items;
  let at = level;
  while (current.length > 1) {
    levelNodes.push(current.length);
    at += 1;
    if (at > TREE_MAX_LEVEL) {
      internal(`the tree would exceed level ${TREE_MAX_LEVEL}`);
    }
    if (current.length <= steps.layout.branchFanoutMax) {
      current = [{ kind: "fresh", node: plannedBranch(at, current) }];
      break;
    }
    const nodes: PlannedBranch[] = [];
    const chunker = new BranchChunker(at, steps, nodes);
    for (const item of current) {
      await chunker.push(item);
    }
    chunker.flush();
    current = nodes.map(adopt);
  }
  return { top: current[0]!, levelNodes };
};

/** Sort canonical documents by `_id` and refuse a duplicate. */
const sortedDocuments = (
  docs: Iterable<CanonicalDocument>,
  steps: ChunkSteps,
): CanonicalDocument[] => {
  const sorted = [...docs].toSorted((a, b) => steps.orderIds(a.id, b.id));
  for (let i = 1; i < sorted.length; i++) {
    if (compareDocIds(sorted[i - 1]!.id, sorted[i]!.id) === 0) {
      internal(`duplicate _id ${JSON.stringify(sorted[i]!.id)}`);
    }
  }
  return sorted;
};

/**
 * The leaf level of the canonical tree over sorted documents: one leaf
 * under the depth-0 rule, otherwise content-defined leaf chunks.
 */
export const leafLevel = async (
  sorted: readonly CanonicalDocument[],
  steps: ChunkSteps,
): Promise<PlannedLeaf[]> => {
  const bytes = sorted.reduce((total, doc) => total + doc.bytes, 0);
  if (steps.singleLeaf(sorted.length, bytes, steps.layout)) {
    return [plannedLeaf(sorted)];
  }
  const leaves: PlannedLeaf[] = [];
  const chunker = new LeafChunker(steps, leaves);
  for (const doc of sorted) {
    await chunker.push(doc);
  }
  chunker.flush();
  return leaves;
};

/**
 * The canonical tree of a row set, or `null` for no rows. Input order is
 * irrelevant. The documents must already be canonical and valid (the
 * fold canonicalizes every post-image with `canonicalDocument`).
 *
 * @param key  the collection's chunk key, from `importChunkKey` over the
 *   salt in its head.
 * @param config  the tree configuration; tests pass a small layout or a
 *   mutant here.
 * @throws BaerlyError code="Internal" — two documents share an `_id`, or
 *   the tree would exceed `TREE_MAX_LEVEL`.
 */
export const buildTree = async (
  docs: Iterable<CanonicalDocument>,
  key: ChunkKey,
  config: TreeConfig = DEFAULT_TREE_CONFIG,
): Promise<PlannedTree | null> => {
  const steps = chunkSteps(config, key);
  const sorted = sortedDocuments(docs, steps);
  if (sorted.length === 0) {
    return null;
  }
  const leaves = await leafLevel(sorted, steps);
  const { top, levelNodes } = await assembleLevels(
    leaves.map((node) => ({ kind: "fresh", node })),
    0,
    steps,
  );
  // Every item is fresh, so the top is too.
  return { root: (top as { readonly node: PlannedNode }).node, levelNodes };
};

// ---------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------

/** Where and under which identity a planned tree is sealed. */
export interface SealTarget {
  /** The collection prefix `P`. */
  readonly prefix: string;
  /** The publication attempt's identity, shared by every fresh node. */
  readonly attempt: string;
  /** The fold end the root records: the head's next `log_seq_start`. */
  readonly floor: number;
}

/** A planned tree encoded under one attempt identity. */
export interface SealedTree {
  /** The root, or `null` for an empty collection. */
  readonly root: SealedTreeNode | null;
  /**
   * Every fresh node, grouped by level from the leaves up (a level whose
   * nodes are all reused is empty), each level in `_id` order; the root
   * is the last node of the last level. A parent is published only
   * after every fresh child it references.
   */
  readonly levels: readonly (readonly SealedTreeNode[])[];
  /** Every reused entry a fresh node references, in tree order. */
  readonly reused: readonly TreeChildEntry[];
}

/**
 * Encode every fresh node of `plan` under `target.attempt`, deriving
 * each parent entry from its child's sealed body. The root carries
 * `floor`, the collection totals and, for a root branch, the plan's
 * level counts. Pure: nothing is written.
 *
 * @throws BaerlyError code="Internal" — a node breaks a node rule (a
 *   builder bug), including level counts that do not fit the root.
 * @throws BaerlyError code="InvalidConfig" — a key exceeds the storage
 *   key ceiling, or the prefix has no valid collection segment.
 */
export const sealTree = async (
  plan: PlannedTree | null,
  target: SealTarget,
): Promise<SealedTree> => {
  if (plan === null) {
    return { root: null, levels: [], reused: [] };
  }
  const collection = collectionOfPrefix(target.prefix);
  const levels: SealedTreeNode[][] = [];
  const reused: TreeChildEntry[] = [];

  const seal = async (node: PlannedNode, isRoot: boolean): Promise<SealedTreeNode> => {
    const totals = { floor: target.floor, rows: node.summary.rows, bytes: node.summary.bytes };
    let body: TreeNode;
    if (node.kind === "leaf") {
      body = {
        kind: "leaf",
        collection,
        attempt: target.attempt,
        level: 0,
        root: isRoot ? totals : null,
        docs: node.docs.map((doc) => doc.doc),
      };
    } else {
      const children: TreeChildEntry[] = [];
      for (const child of node.children) {
        if (child.kind === "reused") {
          reused.push(child.entry);
          children.push(child.entry);
          continue;
        }
        const sealed = await seal(child.node, false);
        children.push({
          ...sealed.summary,
          attempt: target.attempt,
          sha256: sealed.sha256,
        });
      }
      body = {
        kind: "branch",
        collection,
        attempt: target.attempt,
        level: node.level,
        root: isRoot ? { ...totals, levelNodes: plan.levelNodes } : null,
        children,
      };
    }
    const sealed = await sealNode(target.prefix, body);
    (levels[node.level] ??= []).push(sealed);
    return sealed;
  };

  const root = await seal(plan.root, true);
  // A level whose nodes are all reused has no fresh node.
  return { root, levels: Array.from(levels, (level) => level ?? []), reused };
};
