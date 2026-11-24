/**
 * Whether a node key is reachable from the root a GC tick read: the
 * per-candidate proof behind every tree GC deletion.
 *
 * For a node key `x` and the tick's root `ρ` at level `d`:
 *
 * 1. no root: not a member; `x` is the root's key: a member;
 * 2. `d ≤ 1`: a member iff `x` is one of the root's child refs, decided
 *    from the key alone (every non-root node of such a tree is a child of
 *    the root);
 * 3. `d ≥ 2`: GET `x`. Absent: already gone. A body that fails its strict
 *    decode is read once more: still failing, it is corrupt; decoding the
 *    second time, it is deferred to a later tick. An authenticated node
 *    at level `λ ≥ d` is not a member. Otherwise it is a member iff the
 *    level-`λ + 1` node on its first `_id`'s path from the root has an
 *    entry naming both its attempt and its sha256. Each path node is
 *    validated against its parent entry and cached for the tick; one
 *    that is missing after a re-GET, or fails to decode, makes the answer
 *    "path unreadable", which ends the tick's deletions.
 *
 * A node the current root does not reach is never reachable again,
 * except as a fresh node of an attempt that can still publish: a root
 * reuses only refs reachable from the head its attempt captured, and
 * fresh nodes carry a new identity. The tick excludes that case by
 * closure (a later fold moved the floor past the attempt's) or by the
 * sweep's floor gate.
 */
import { compareDocIds } from "../snapshot-doc-id.ts";
import type { Storage } from "@baerly/protocol";
import { parseTreeNodeKey, treeNodeKeyPrefix, type TreeNodeKeyParts } from "./key.ts";
import type { TreeConfig } from "./layout.ts";
import { type DecodedTreeNode, decodeNode, type TreeChildEntry } from "./node-codec.ts";

/** What a membership check found. */
export type TreeGcMembership =
  /** The root reaches the node: never delete it. */
  | "member"
  /** The root does not reach the node. */
  | "non-member"
  /** The node is already absent. */
  | "gone"
  /** The node's body failed its strict decode twice. */
  | "corrupt"
  /** The node's body failed once and decoded on the re-read: left for later. */
  | "deferred"
  /** A node on the path from the root is missing or undecodable: proves nothing. */
  | "path-unreadable"
  /** The key is not a node key of the collection: never deleted. */
  | "not-a-node";

/** The root a GC tick read, and how to fetch what a check needs. */
export interface TreeGcRootView {
  readonly prefix: string;
  /** The strictly decoded root of the head the tick read, or `null`. */
  readonly root: DecodedTreeNode | null;
  /** The root's level; 0 with no root. */
  readonly depth: number;
  readonly config: TreeConfig;
  /** GET a candidate's body, uncached; `null` when absent. */
  readonly getBody: (key: string) => Promise<Uint8Array | null>;
  /**
   * The node `entry` of `parent` names, strictly decoded against that
   * entry and cached for the tick, or `null` when it is missing after a
   * re-GET or fails to decode.
   */
  readonly pathNode: (
    parent: DecodedTreeNode,
    entry: TreeChildEntry,
  ) => Promise<DecodedTreeNode | null>;
}

/** Whether `entry` names the node `parts` by both attempt and sha256. */
export const entryNamesNode = (entry: TreeChildEntry, parts: TreeNodeKeyParts): boolean =>
  entry.attempt === parts.attempt && entry.sha256 === parts.sha256;

/**
 * The key-only rule, valid only for a root at level 0 or 1: `x` is the
 * root, or one of its child refs.
 */
export const keyOnlyMember = (
  x: string,
  root: DecodedTreeNode | null,
  parts: TreeNodeKeyParts,
): boolean => {
  if (root === null) {
    return false;
  }
  if (x === root.key) {
    return true;
  }
  return root.node.kind === "branch" && root.node.children.some((e) => entryNamesNode(e, parts));
};

/**
 * The node at `level` on `id`'s path from the view's root: the root
 * itself when `level` is its level. `null` when some node on the way has
 * no entry whose `[lo, hi]` contains `id`; `"unreadable"` when a path
 * node is missing or undecodable.
 */
export const routeTo = async (
  view: TreeGcRootView,
  id: string,
  level: number,
): Promise<DecodedTreeNode | null | "unreadable"> => {
  let node = view.root;
  while (node !== null && node.node.level > level) {
    if (node.node.kind !== "branch") {
      return null;
    }
    const entry = node.node.children.find(
      (e) => compareDocIds(e.lo, id) <= 0 && compareDocIds(id, e.hi) <= 0,
    );
    if (entry === undefined) {
      return null;
    }
    const child = await view.pathNode(node, entry);
    if (child === null) {
      return "unreadable";
    }
    node = child;
  }
  return node;
};

/** A candidate's body, authenticated or not. */
export type TreeGcCandidateRead =
  | { readonly kind: "node"; readonly node: DecodedTreeNode }
  | { readonly kind: "gone" | "corrupt" | "deferred" };

/**
 * GET and strictly decode candidate `x` as any node of the collection,
 * root or not. A body that fails is read once more when
 * `retriesCorrupt`; still failing, the candidate is corrupt.
 */
export const readCandidate = async (
  x: string,
  view: TreeGcRootView,
  retriesCorrupt: boolean,
): Promise<TreeGcCandidateRead> => {
  const decode = async (body: Uint8Array): Promise<DecodedTreeNode | null> => {
    try {
      return await decodeNode(x, body, { prefix: view.prefix, root: "either" }, view.config);
    } catch {
      return null;
    }
  };
  const body = await view.getBody(x);
  if (body === null) {
    return { kind: "gone" };
  }
  const node = await decode(body);
  if (node !== null) {
    return { kind: "node", node };
  }
  if (!retriesCorrupt) {
    return { kind: "corrupt" };
  }
  const again = await view.getBody(x);
  if (again === null) {
    return { kind: "gone" };
  }
  return (await decode(again)) === null ? { kind: "corrupt" } : { kind: "deferred" };
};

/** How a check routes an authenticated candidate; production uses {@link TREE_GC_ROUTING}. */
export interface TreeGcRouting {
  /** The level of the node whose entries must name a candidate at `level`. */
  readonly parentLevel: (level: number) => number;
  /** Whether `entry` names the candidate `parts`. */
  readonly names: (entry: TreeChildEntry, parts: TreeNodeKeyParts) => boolean;
}

/** The routing every production check uses: the parent one level up, matched by attempt and sha256. */
export const TREE_GC_ROUTING: TreeGcRouting = Object.freeze({
  parentLevel: (level: number) => level + 1,
  names: entryNamesNode,
});

/**
 * Whether node key `x` is reachable from the view's root; see the module
 * comment. `routing` and `retriesCorrupt` are what tests vary.
 */
export const treeGcMembershipVia = async (
  x: string,
  view: TreeGcRootView,
  routing: TreeGcRouting,
  retriesCorrupt: boolean,
): Promise<TreeGcMembership> => {
  const parts = parseTreeNodeKey(view.prefix, x);
  if (parts === null) {
    return "not-a-node";
  }
  if (view.root === null) {
    return "non-member";
  }
  if (x === view.root.key) {
    return "member";
  }
  if (view.depth <= 1) {
    return keyOnlyMember(x, view.root, parts) ? "member" : "non-member";
  }
  const read = await readCandidate(x, view, retriesCorrupt);
  if (read.kind !== "node") {
    return read.kind;
  }
  const level = read.node.node.level;
  if (level >= view.depth) {
    return "non-member";
  }
  const parent = await routeTo(view, read.node.summary.lo, routing.parentLevel(level));
  if (parent === "unreadable") {
    return "path-unreadable";
  }
  if (parent === null || parent.node.kind !== "branch") {
    return "non-member";
  }
  return parent.node.children.some((entry) => routing.names(entry, parts))
    ? "member"
    : "non-member";
};

/** The production membership check. */
export const treeGcMembership = (x: string, view: TreeGcRootView): Promise<TreeGcMembership> =>
  treeGcMembershipVia(x, view, TREE_GC_ROUTING, view.config.steps.gcRetriesCorrupt?.() ?? true);

/**
 * The view a tick checks candidates against: `root` as read, candidate
 * GETs straight from `storage`, and path nodes read once per tick, each
 * re-read once when missing and strictly decoded against its parent
 * entry.
 */
export const createTreeGcRootView = (
  storage: Storage,
  prefix: string,
  root: DecodedTreeNode | null,
  config: TreeConfig,
  signal?: AbortSignal,
): TreeGcRootView => {
  const opts = signal === undefined ? undefined : { signal };
  const nodePrefix = treeNodeKeyPrefix(prefix);
  const cache = new Map<string, DecodedTreeNode | null>();
  const getBody = async (key: string): Promise<Uint8Array | null> => {
    const got = await storage.get(key, opts);
    return got?.body ?? null;
  };
  return {
    prefix,
    root,
    depth: root?.node.level ?? 0,
    config,
    getBody,
    pathNode: async (parent, entry) => {
      const key = `${nodePrefix}${entry.attempt}/${entry.sha256}`;
      if (cache.has(key)) {
        return cache.get(key)!;
      }
      const body = (await getBody(key)) ?? (await getBody(key));
      let node: DecodedTreeNode | null = null;
      if (body !== null) {
        try {
          node = await decodeNode(
            key,
            body,
            { prefix, root: false, level: parent.node.level - 1, entry },
            config,
          );
        } catch {
          node = null;
        }
      }
      cache.set(key, node);
      return node;
    },
  };
};
