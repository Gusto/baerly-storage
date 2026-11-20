/**
 * Pure fold harness for the prototype tree's canonical builder and fold
 * planner (`packages/server/src/tree/{build,plan}.ts`).
 *
 * A {@link FoldRun} keeps an in-memory key → bytes map of published
 * nodes and a log of row changes. Each {@link FoldRun.fold} turns the
 * next tick's changes into survivors, plans a fold against the captured
 * root, seals it under a fresh attempt identity and publishes it
 * create-only. {@link FoldRun.check} then compares the published tree
 * with the canonical tree of the expected rows:
 *
 * - The expected rows come from the logical oracle
 *   (`tree-oracle-logical.ts`) over the whole log, not from the planner.
 * - The published tree is strictly decoded from the root down, each node
 *   against the parent entry that routed to it, so every entry is proven
 *   to equal what its child's body yields.
 * - The identity-free shapes are compared, and a mismatch reports the
 *   first difference: levels from the leaves up, each left to right; a
 *   leaf compared by its documents, a branch by its level and its
 *   entries' `lo`, `hi`, `rows` and `bytes`.
 * - A root branch's `level_nodes` must equal the nodes reachable at each
 *   level, and every level below the root's children must hold more
 *   than `branchFanoutMax` nodes.
 *
 * Every fold also checks that each reused entry was copied from the
 * captured root or from a node the planner read below it.
 */
import { type DocumentData, encodeJsonBytes, type LogEntry, sha256Hex } from "@baerly/protocol";
import {
  buildTree,
  type PlannedNode,
  type PlannedTree,
  type SealedTree,
  sealTree,
} from "../../packages/server/src/tree/build.ts";
import { treeNodeKey } from "../../packages/server/src/tree/key.ts";
import {
  createTreeConfig,
  TREE_LAYOUT,
  type TreeConfig,
  type TreeLayout,
} from "../../packages/server/src/tree/layout.ts";
import {
  canonicalDocument,
  type DecodedTreeNode,
  decodeNode,
  type TreeChildEntry,
  type TreeNodeExpectation,
} from "../../packages/server/src/tree/node-codec.ts";
import {
  FoldPlanner,
  planFold,
  type TreeFoldPlan,
  type TreeMutation,
} from "../../packages/server/src/tree/plan.ts";
import { TREE_RETRIED_CALL_CHARGE } from "../../packages/server/src/tree/constants.ts";
import type { ChunkKey } from "../../packages/server/src/tree/chunk.ts";
import { testChunkKey } from "./tree-chunk-salt.ts";
import { foldLogical } from "./tree-oracle-logical.ts";
import type { TreeMutant } from "./tree-mutants.ts";

export const FOLD_PREFIX = "app/helpdesk/tenant/acme/manifests/tickets";

const COLLECTION = "tickets";

/** One row change: the row's new document, or `null` to delete it. */
export interface RowChange {
  readonly id: string;
  readonly value: DocumentData | null;
}

/** One node of a tree, as the first-difference report compares it. */
interface LevelNode {
  readonly key: string | null;
  readonly lo: string;
  readonly hi: string;
  /** The compared value: `S(leaf)`, or a branch's level and entry summaries. */
  readonly compared: string;
}

/** What one fold did. */
export interface FoldResult {
  /** The published plan, or `null` when the tick folded nothing. */
  readonly plan: TreeFoldPlan | null;
  readonly sealed: SealedTree | null;
  /** Fresh nodes published, the root included. */
  readonly written: number;
  /** Log entries folded this tick. */
  readonly folded: number;
  /** For a charged fold: the planner, after its last change. */
  readonly planner?: FoldPlanner;
}

/** Calls a charged fold has spent before planning: the head GET and the root GET. */
export const FOLD_SPENT_BEFORE_PLANNING = 2 * TREE_RETRIED_CALL_CHARGE;

const json = (value: unknown): string => new TextDecoder().decode(encodeJsonBytes(value));

const summaryOf = (children: readonly { lo: string; hi: string; rows: number; bytes: number }[]) =>
  children.map(({ lo, hi, rows, bytes }) => ({ lo, hi, rows, bytes }));

/** `sha256Hex` of the identity-free shape S. */
export const shapeDigest = (shape: unknown): Promise<string> => sha256Hex(encodeJsonBytes(shape));

/** The shape and level listing of a built tree, whose nodes are all fresh. */
export const plannedShape = (
  tree: PlannedTree | null,
): { readonly shape: unknown; readonly levels: LevelNode[][] } => {
  const levels: LevelNode[][] = [];
  const walk = (node: PlannedNode): unknown => {
    let shape: unknown;
    let compared: string;
    if (node.kind === "leaf") {
      shape = { level: 0, docs: node.docs.map((d) => d.doc) };
      compared = json(shape);
    } else {
      const children = node.children.map((child) => {
        if (child.kind !== "fresh") {
          throw new Error("plannedShape: a built tree holds no reused child");
        }
        return { ...child.node.summary, node: walk(child.node) };
      });
      shape = {
        level: node.level,
        children: children.map(({ lo, hi, rows, bytes, node: n }) => ({
          lo,
          hi,
          rows,
          bytes,
          node: n,
        })),
      };
      compared = json({ level: node.level, children: summaryOf(children) });
    }
    (levels[node.level] ??= []).push({
      key: null,
      lo: node.summary.lo,
      hi: node.summary.hi,
      compared,
    });
    return shape;
  };
  return { shape: tree === null ? null : walk(tree.root), levels };
};

/**
 * Strictly decode a published tree from its root and list its shape and
 * levels. `counts` reports a root branch whose `level_nodes` is not the
 * number of nodes reachable at each level, or names a level below the
 * root's children with at most `branchFanoutMax` nodes; it is
 * `undefined` when the counts hold.
 */
export const publishedShape = async (
  store: ReadonlyMap<string, Uint8Array>,
  rootKey: string | null,
  floor: number,
  config: TreeConfig,
): Promise<{
  readonly shape: unknown;
  readonly levels: LevelNode[][];
  readonly counts: string | undefined;
}> => {
  const levels: LevelNode[][] = [];
  let stored: readonly number[] = [];
  const walk = async (key: string, expected: TreeNodeExpectation): Promise<unknown> => {
    const decoded = await decodeNode(key, store.get(key) ?? null, expected, config);
    const { node, summary } = decoded;
    if (expected.root === true && node.kind === "branch") {
      stored = node.root!.levelNodes;
    }
    let shape: unknown;
    let compared: string;
    if (node.kind === "leaf") {
      shape = { level: 0, docs: node.docs };
      compared = json(shape);
    } else {
      const children = [];
      for (const entry of node.children) {
        const child = await walk(treeNodeKey(FOLD_PREFIX, entry.attempt, entry.sha256), {
          prefix: FOLD_PREFIX,
          root: false,
          level: node.level - 1,
          entry,
        });
        const { lo, hi, rows, bytes } = entry;
        children.push({ lo, hi, rows, bytes, node: child });
      }
      shape = { level: node.level, children };
      compared = json({ level: node.level, children: summaryOf(children) });
    }
    (levels[node.level] ??= []).push({ key, lo: summary.lo, hi: summary.hi, compared });
    return shape;
  };
  const shape =
    rootKey === null ? null : await walk(rootKey, { prefix: FOLD_PREFIX, root: true, floor });
  const reachable = levels.slice(0, -1).map((level) => level.length);
  let counts: string | undefined;
  if (json(reachable) !== json(stored)) {
    counts = `root level_nodes ${json(stored)}, reachable ${json(reachable)}`;
  } else if (reachable.slice(0, -1).some((n) => n <= config.layout.branchFanoutMax)) {
    counts = `a level below the root's children holds at most branchFanoutMax nodes: ${json(reachable)}`;
  }
  return { shape, levels, counts };
};

/** The first difference between a published and a canonical tree, or `undefined`. */
export const firstDifference = (
  published: readonly LevelNode[][],
  canonical: readonly LevelNode[][],
  rootKey: string | null,
): string | undefined => {
  const depth = Math.max(published.length, canonical.length);
  const range = (level: readonly LevelNode[] | undefined) =>
    level === undefined || level.length === 0
      ? "none"
      : `${level[0]!.lo}..${level.at(-1)!.hi} (${level.length} nodes)`;
  for (let level = 0; level < depth; level++) {
    const left = published[level] ?? [];
    const right = canonical[level] ?? [];
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const l = left[index];
      const r = right[index];
      if (l?.compared !== r?.compared) {
        const node = (n: LevelNode | undefined) => (n === undefined ? "none" : `${n.lo}..${n.hi}`);
        return (
          `level ${level}, index ${index}, published key ${l?.key ?? rootKey ?? "(no root)"}: ` +
          `published ${node(l)} of ${range(left)}, canonical ${node(r)} of ${range(right)}`
        );
      }
    }
  }
  return undefined;
};

/** A fold history over one collection, published into memory. */
export class FoldRun {
  readonly store = new Map<string, Uint8Array>();
  readonly #config: TreeConfig;
  readonly #key: ChunkKey;
  readonly #log: LogEntry[] = [];
  readonly #live = new Set<string>();
  #rootKey: string | null = null;
  #floor = 0;
  #attempts = 0;

  /** A fold history under `config`, whose chunk key is `key`. */
  constructor(config: TreeConfig, key: ChunkKey) {
    this.#config = config;
    this.#key = key;
  }

  /** A fold history under `config` and the test chunk salt. */
  static async open(config: TreeConfig): Promise<FoldRun> {
    return new FoldRun(config, await testChunkKey());
  }

  /** An independent copy of this run, to fold different changes onto the same tree. */
  fork(): FoldRun {
    const copy = new FoldRun(this.#config, this.#key);
    for (const [key, bytes] of this.store) {
      copy.store.set(key, bytes);
    }
    copy.#log.push(...this.#log);
    for (const id of this.#live) {
      copy.#live.add(id);
    }
    copy.#rootKey = this.#rootKey;
    copy.#floor = this.#floor;
    copy.#attempts = this.#attempts;
    return copy;
  }

  get rootKey(): string | null {
    return this.#rootKey;
  }

  get floor(): number {
    return this.#floor;
  }

  /**
   * Log `changes` in order, then fold the unfolded entries in one tick.
   * Without `budget` the tick folds them all through `planFold`. With
   * it, a `FoldPlanner` adds them in seq order against that many calls
   * and the tick folds the accepted prefix, publishing nothing when no
   * entry fits.
   */
  async fold(changes: readonly RowChange[], budget?: number): Promise<FoldResult> {
    for (const { id, value } of changes) {
      const seq = this.#log.length;
      let op: LogEntry["op"] = "D";
      if (value === null) {
        this.#live.delete(id);
      } else {
        op = this.#live.has(id) ? "U" : "I";
        this.#live.add(id);
      }
      this.#log.push({
        lsn: `lsn-${seq}`,
        commit_ts: "2026-01-01T00:00:00.000Z",
        op,
        collection: COLLECTION,
        doc_id: id,
        session: "ssn001",
        seq,
        ...(value !== null && { after: value }),
      } as LogEntry);
    }
    const pending: TreeMutation[] = this.#log.slice(this.#floor).map((entry) => ({
      id: entry.doc_id,
      doc: entry.op === "D" ? null : canonicalDocument(entry.after, `log seq ${entry.seq}`),
    }));
    const root = await this.captured();
    const input = {
      prefix: FOLD_PREFIX,
      root,
      chunkKey: this.#key,
      get: (key: string) => Promise.resolve(this.store.get(key) ?? null),
      config: this.#config,
    };
    let plan: TreeFoldPlan | null;
    let folded = pending.length;
    let planner: FoldPlanner | undefined;
    if (budget === undefined) {
      const survivors = new Map(pending.map((m) => [m.id, m]));
      plan = await planFold({ ...input, mutations: [...survivors.values()] });
    } else {
      planner = new FoldPlanner({ ...input, budget, spent: FOLD_SPENT_BEFORE_PLANNING });
      folded = 0;
      for (const mutation of pending) {
        if (!(await planner.add(mutation))) {
          break;
        }
        folded += 1;
      }
      plan = planner.plan;
    }
    if (plan === null || folded === 0) {
      return { plan: null, sealed: null, written: 0, folded: 0, planner };
    }
    this.#attempts += 1;
    const floor = this.#floor + folded;
    const sealed = await sealTree(plan.tree, {
      prefix: FOLD_PREFIX,
      attempt: this.#attempts.toString(16).padStart(32, "0"),
      floor,
    });
    assertCapturedLiveReuse(sealed.reused, root, plan.read);
    let written = 0;
    for (const level of sealed.levels) {
      for (const node of level) {
        if (this.store.has(node.key)) {
          throw new Error(`fold harness: ${node.key} published twice`);
        }
        this.store.set(node.key, node.bytes);
        written += 1;
      }
    }
    this.#rootKey = sealed.root?.key ?? null;
    this.#floor = floor;
    return { plan, sealed, written, folded, planner };
  }

  /** The current root, strictly decoded as a root. */
  async captured(): Promise<DecodedTreeNode | null> {
    if (this.#rootKey === null) {
      return null;
    }
    return decodeNode(
      this.#rootKey,
      this.store.get(this.#rootKey) ?? null,
      { prefix: FOLD_PREFIX, root: true, floor: this.#floor },
      this.#config,
    );
  }

  /** The rows the published tree must hold: the logical oracle up to the folded seq. */
  expectedRows(): DocumentData[] {
    const view = foldLogical({
      collection: COLLECTION,
      base: new Map(),
      baseSeq: 0,
      entries: this.#log,
      targetSeq: this.#floor,
    });
    return [...view.rows.values()];
  }

  /**
   * Compare the published tree with the canonical tree of the expected
   * rows, then check its root's level counts. Returns the first
   * difference or count finding, or `undefined` when both hold.
   */
  async check(canonicalConfig: TreeConfig = this.#config): Promise<string | undefined> {
    const rows = this.expectedRows().map((row) => canonicalDocument(row, "expected row"));
    const canonical = plannedShape(await buildTree(rows, this.#key, canonicalConfig));
    const published = await publishedShape(this.store, this.#rootKey, this.#floor, this.#config);
    const [left, right] = await Promise.all([
      shapeDigest(published.shape),
      shapeDigest(canonical.shape),
    ]);
    if (left !== right) {
      return (
        firstDifference(published.levels, canonical.levels, this.#rootKey) ??
        `shape digests differ: published ${left}, canonical ${right}`
      );
    }
    return published.counts;
  }
}

/** Throw unless every reused entry is a child of the captured root or of a node read below it. */
const assertCapturedLiveReuse = (
  reused: readonly TreeChildEntry[],
  root: DecodedTreeNode | null,
  read: readonly DecodedTreeNode[],
): void => {
  const live = new Set<string>();
  for (const node of [...(root === null ? [] : [root]), ...read]) {
    if (node.node.kind === "branch") {
      for (const entry of node.node.children) {
        live.add(`${entry.attempt}/${entry.sha256}`);
      }
    }
  }
  for (const entry of reused) {
    if (!live.has(`${entry.attempt}/${entry.sha256}`)) {
      throw new Error(
        `fold harness: reused ${entry.lo}..${entry.hi} is not a child of a captured node`,
      );
    }
  }
};

// ---------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------

/**
 * The small-scope layout: short rows make deep trees, so small row sets
 * reach every branch rule. 20 rows `k0..k19` are a depth-2 tree.
 */
export const SMALL_LAYOUT: TreeLayout = {
  leafTargetBytes: 32,
  leafMinBytes: 16,
  leafMaxBytes: 48,
  leafIsolationDocumentBytes: 48,
  branchFanoutMin: 2,
  branchFanoutTarget: 2,
  branchFanoutMax: 3,
  singleLeafMaxBytes: 0,
  singleLeafMaxRows: 0,
};
/** The production layout with the depth-0 rule disabled. */
export const NO_DEPTH_ZERO: TreeLayout = {
  ...TREE_LAYOUT,
  singleLeafMaxBytes: 0,
  singleLeafMaxRows: 0,
};

/** A tree configuration for `layout`, with `mutant`'s steps when given. */
export const configOf = (layout: TreeLayout, mutant?: TreeMutant): TreeConfig =>
  createTreeConfig({ layout, ...mutant?.options });

/** A row of exactly `bytes` document bytes (at least the bare `{"_id":id}`), filled with `fill`. */
export const sizedRow = (id: string, bytes: number, fill = "x"): DocumentData => {
  const bare = encodeJsonBytes({ _id: id }).byteLength;
  if (bytes <= bare) {
    return { _id: id };
  }
  const base = encodeJsonBytes({ _id: id, p: "" }).byteLength;
  return { _id: id, p: fill.repeat(Math.max(0, bytes - base)) };
};

/**
 * Fold `ticks` in order onto `run` (an empty collection by default),
 * checking the canonical root after every tick. Returns the first
 * failure, or `undefined`.
 */
export const runTicks = async (
  config: TreeConfig,
  ticks: readonly (readonly RowChange[])[],
  canonical: TreeConfig = config,
  start?: FoldRun,
): Promise<string | undefined> => {
  const run = start ?? (await FoldRun.open(config));
  for (const [i, tick] of ticks.entries()) {
    try {
      await run.fold(tick);
    } catch (error) {
      return `tick ${i} threw: ${(error as Error).message}`;
    }
    const difference = await run.check(canonical);
    if (difference !== undefined) {
      return `after tick ${i}: ${difference}`;
    }
  }
  return undefined;
};
