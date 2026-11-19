/**
 * Synthetic tree fold step: the CPU of one write tick on a content-addressed
 * tree (docs/redesign options, "one content-addressed tree"). No baerly
 * code runs here; the cell isolates the two costs that bound how many leaves
 * fit in one Free invocation:
 *
 *   1. re-encode k leaves (JSON.stringify + UTF-8) of about B KiB, SHA-256
 *      each with `crypto.subtle.digest`;
 *   2. re-encode and hash d path nodes, bottom-up, each carrying the new
 *      child hashes.
 *
 * Shared mode: the d path nodes are one path, all k leaves under the same
 * parent chain (best case). Distinct mode: the k leaves sit on k distinct
 * root-to-leaf paths, so level L from the root (0 = root) holds
 * min(k, FANOUT^L) nodes, 1 + k*(d-1) in total for k <= FANOUT (see
 * `treePathNodes` in cells.ts). Leaf and node objects are synthetic (counter plus `x` padding)
 * and built once per isolate; that first request reports `cold: true` and
 * the analyzer drops it.
 */
import { TREE_FANOUT, treeNodesPerLevel, treePath, type TreeParams } from "./cells.ts";

const DOC_PAYLOAD = 200;

interface Leaf {
  schema_version: 1;
  docs: Array<{ _id: string; n: number; p: string }>;
}

interface PathNode {
  schema_version: 1;
  level: number;
  children: Array<{ first_id: string; hash: string; bytes: number }>;
}

interface TreeFixture {
  readonly leaves: Leaf[];
  /** Levels bottom-up (parent of the leaves first); one node each when shared. */
  readonly levels: PathNode[][];
}

const fixtures = new Map<string, TreeFixture>();
const encoder = new TextEncoder();

const hex = (buf: ArrayBuffer): string => new Uint8Array(buf).toHex();

const sha256Hex = async (bytes: BufferSource): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", bytes));

const makeFixture = (t: TreeParams): TreeFixture => {
  const p = "x".repeat(DOC_PAYLOAD);
  // ~ 230 B per encoded doc; size the leaf to about bKiB.
  const docsPerLeaf = Math.max(1, Math.round((t.bKiB * 1024) / (DOC_PAYLOAD + 30)));
  const leaves: Leaf[] = Array.from({ length: t.k }, (_unused, li) => ({
    schema_version: 1,
    docs: Array.from({ length: docsPerLeaf }, (_unused2, i) => ({
      _id: `d${String(li * docsPerLeaf + i).padStart(8, "0")}`,
      n: 0,
      p,
    })),
  }));
  const perLevel = treeNodesPerLevel(t).toReversed();
  const levels: PathNode[][] = perLevel.map((count, bottomUp) =>
    Array.from({ length: count }, () => ({
      schema_version: 1,
      level: bottomUp,
      children: Array.from({ length: TREE_FANOUT }, (_unused4, i) => ({
        first_id: `d${String(i).padStart(8, "0")}`,
        hash: "0".repeat(64),
        bytes: 0,
      })),
    })),
  );
  return { leaves, levels };
};

export interface TreeStepResult {
  readonly cold: boolean;
  readonly leaves: number;
  readonly pathNodes: number;
  readonly bytesHashed: number;
  readonly root: string;
}

let step = 0;

export const runTreeStep = async (t: TreeParams): Promise<TreeStepResult> => {
  const key = `${t.k}/${t.bKiB}/${t.d}/${treePath(t)}`;
  let fx = fixtures.get(key);
  const cold = fx === undefined;
  if (fx === undefined) {
    fx = makeFixture(t);
    fixtures.set(key, fx);
  }
  step += 1;
  let bytesHashed = 0;
  const leafHashes: string[] = [];
  const leafSizes: number[] = [];
  for (const leaf of fx.leaves) {
    // One changed document per leaf, so the re-encode is real work.
    leaf.docs[0]!.n = step;
    const bytes = encoder.encode(JSON.stringify(leaf));
    leafHashes.push(await sha256Hex(bytes));
    leafSizes.push(bytes.byteLength);
    bytesHashed += bytes.byteLength;
  }
  let hashes = leafHashes;
  let sizes = leafSizes;
  let root = hashes[0] ?? "";
  let pathNodes = 0;
  for (const level of fx.levels) {
    // Child i goes to node i % level.length: one-to-one where every child has
    // its own parent (distinct paths), all into node 0 when there is one node.
    const slot = Array.from({ length: level.length }, () => 0);
    hashes.forEach((h, i) => {
      const n = i % level.length;
      const child = level[n]!.children[slot[n]! % TREE_FANOUT]!;
      slot[n]! += 1;
      child.hash = h;
      child.bytes = sizes[i]!;
    });
    const nextHashes: string[] = [];
    const nextSizes: number[] = [];
    for (const node of level) {
      const bytes = encoder.encode(JSON.stringify(node));
      root = await sha256Hex(bytes);
      bytesHashed += bytes.byteLength;
      nextHashes.push(root);
      nextSizes.push(bytes.byteLength);
      pathNodes += 1;
    }
    hashes = nextHashes;
    sizes = nextSizes;
  }
  return { cold, leaves: t.k, pathNodes, bytesHashed, root };
};
