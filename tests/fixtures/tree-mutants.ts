/**
 * Single-defect mutants of the prototype tree, injected through the
 * `steps` member of `TreeConstructorOptions`
 * (`packages/server/src/tree/layout.ts`). Each acceptance suite has a
 * `mutation` test asserting that its checks go red under the mutants
 * named for it, so a suite that stops discriminating is caught.
 *
 * Add a mutant here, and a member to `TreeSteps` for the step it
 * replaces, rather than editing tree code to inject a defect.
 */
import { encodeJsonBytes } from "@baerly/protocol";
import { branchHashCuts, chunkHash } from "../../packages/server/src/tree/chunk.ts";
import {
  TREE_LAYOUT_RULES,
  type TreeConstructorOptions,
} from "../../packages/server/src/tree/layout.ts";
import { sortMutationsById } from "../../packages/server/src/tree/plan.ts";
import { readTreeTail } from "../../packages/server/src/tree/read.ts";

export interface TreeMutant {
  /** Stable name for test titles. */
  readonly name: string;
  /** The single defect the mutant introduces. */
  readonly defect: string;
  /** Pass to `createTreeConfig` to build the mutated tree. */
  readonly options: TreeConstructorOptions;
}

/**
 * A decoder that skips the canonical-bytes check, so it accepts any body
 * that parses to a valid node: whitespace, `2.50`, `-0`, duplicate
 * members, alternate escapes.
 */
export const DECODER_SKIPS_REENCODE: TreeMutant = {
  name: "decoder-skips-reencode",
  defect: "strict decode accepts a body that is not the canonical encoding of its value",
  options: { steps: { canonicalBytesMatch: () => true } },
};

/** A layout validator missing the rule named `rule`. */
export const layoutWithoutRule = (rule: string): TreeMutant => {
  if (!TREE_LAYOUT_RULES.some((r) => r.name === rule)) {
    throw new Error(`no layout rule named ${JSON.stringify(rule)}`);
  }
  return {
    name: `layout-without-${rule}`,
    defect: `layout validation omits rule ${rule}`,
    options: { steps: { layoutRules: TREE_LAYOUT_RULES.filter((r) => r.name !== rule) } },
  };
};

// ---------------------------------------------------------------------
// Canonical builder
// ---------------------------------------------------------------------

/**
 * A branch chunker without the forced cut at `branchFanoutMax`: a node
 * whose entries all fail the hash test grows past the maximum.
 */
export const BRANCH_WITHOUT_FANOUT_MAX: TreeMutant = {
  name: "branch-without-fanout-max",
  defect: "branch chunking has no forced cut at branchFanoutMax entries",
  options: {
    steps: {
      branchCut: (count, hash, layout) =>
        count >= layout.branchFanoutMin && branchHashCuts(hash, layout),
    },
  },
};

/** The depth-0 rule with exclusive limits: a row set exactly at a limit is chunked. */
export const SINGLE_LEAF_EXCLUSIVE: TreeMutant = {
  name: "single-leaf-exclusive",
  defect: "the depth-0 rule compares its limits exclusively",
  options: {
    steps: {
      singleLeaf: (rows, bytes, layout) =>
        rows < layout.singleLeafMaxRows && bytes < layout.singleLeafMaxBytes,
    },
  },
};

/** The depth-0 rule on the byte axis only. */
export const SINGLE_LEAF_IGNORES_ROWS: TreeMutant = {
  name: "single-leaf-ignores-rows",
  defect: "the depth-0 rule ignores its row limit",
  options: {
    steps: { singleLeaf: (_rows, bytes, layout) => bytes <= layout.singleLeafMaxBytes },
  },
};

/** A chunk hash whose level byte is stuck at 1 above the leaves: every branch level hashes alike. */
export const CHUNK_LEVEL_BYTE_STUCK: TreeMutant = {
  name: "chunk-level-byte-stuck",
  defect: "branch levels above 1 hash with level byte 1",
  options: { steps: { chunkHash: (key, level, id) => chunkHash(key, Math.min(level, 1), id) } },
};

const compareCodeUnits = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/** `_id`s sorted by UTF-16 code units instead of UTF-8 bytes. */
export const UTF16_ID_ORDER: TreeMutant = {
  name: "utf16-id-order",
  defect: "documents are sorted by UTF-16 code units, not utf8-scalar-v1",
  options: { steps: { orderIds: compareCodeUnits } },
};

/** Isolation only above `leafIsolationDocumentBytes`, not at it. */
export const ISOLATION_EXCLUSIVE: TreeMutant = {
  name: "isolation-exclusive",
  defect: "a document exactly at leafIsolationDocumentBytes is not isolated",
  options: { steps: { isolates: (bytes, layout) => bytes > layout.leafIsolationDocumentBytes } },
};

/** The builder mutants the canonical-shape vectors must catch. */
export const BUILD_MUTANTS: readonly TreeMutant[] = [
  BRANCH_WITHOUT_FANOUT_MAX,
  SINGLE_LEAF_EXCLUSIVE,
  SINGLE_LEAF_IGNORES_ROWS,
  CHUNK_LEVEL_BYTE_STUCK,
  UTF16_ID_ORDER,
  ISOLATION_EXCLUSIVE,
];

// ---------------------------------------------------------------------
// Fold planner
// ---------------------------------------------------------------------

/** A planner that loses the last mutation of the fold, in `_id` order. */
export const PLANNER_DROPS_LAST_MUTATION: TreeMutant = {
  name: "planner-drops-last-mutation",
  defect: "the fold planner drops the last mutation",
  options: {
    steps: {
      sortMutations: (mutations) => sortMutationsById(mutations).slice(0, -1),
    },
  },
};

/**
 * A planner that stops re-chunking at the first old node boundary past
 * a change even when its chunker is mid-chunk, closing that chunk
 * instead of resyncing into the neighbour.
 */
export const PLANNER_RESYNCS_ONE_SHORT: TreeMutant = {
  name: "planner-resyncs-one-short",
  defect: "the fold planner stops one neighbour short of a resynced cut",
  options: { steps: { resyncStops: () => true } },
};

/**
 * A planner that never re-chunks the leaf before an isolated document,
 * although that leaf's cut read the isolated document's size.
 */
export const PLANNER_SKIPS_ISOLATION_RESTART: TreeMutant = {
  name: "planner-skips-isolation-restart",
  defect: "the fold planner keeps the leaf cut before a changed isolated document",
  options: { steps: { leafRestartsBefore: () => false } },
};

/**
 * A planner that re-chunks the leaf before an isolated document only
 * when the document is larger than `leafIsolationDocumentBytes`, missing
 * the leaf before a document of exactly that size.
 */
export const PLANNER_ISOLATION_RESTART_EXCLUSIVE: TreeMutant = {
  name: "planner-isolation-restart-exclusive",
  defect: "the fold planner treats a leaf at exactly leafIsolationDocumentBytes as not isolated",
  options: {
    steps: {
      leafRestartsBefore: (leaf, layout) =>
        leaf.rows === 1 && leaf.bytes > layout.leafIsolationDocumentBytes,
    },
  },
};

/**
 * A planner that never resyncs: it re-chunks from the first change to
 * the end of every level. Its trees are canonical, but it rewrites
 * every node after the change.
 */
export const PLANNER_NEVER_RESYNCS: TreeMutant = {
  name: "planner-never-resyncs",
  defect: "the fold planner rewrites every node after the first change",
  options: { steps: { resyncStops: () => false } },
};

/** The planner mutants the fold-equals-build suite must catch. */
export const PLAN_MUTANTS: readonly TreeMutant[] = [
  PLANNER_DROPS_LAST_MUTATION,
  PLANNER_RESYNCS_ONE_SHORT,
  PLANNER_SKIPS_ISOLATION_RESTART,
  PLANNER_ISOLATION_RESTART_EXCLUSIVE,
];

// ---------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------

/** A publisher that CASes the head before it creates the fresh nodes. */
export const PUBLISH_HEAD_BEFORE_NODES: TreeMutant = {
  name: "publish-head-before-nodes",
  defect: "the publisher CASes the head before it creates the nodes the new root references",
  options: {
    steps: {
      publicationOrder: (writes) => [
        ...writes.filter((write) => write.kind === "head"),
        ...writes.filter((write) => write.kind !== "head"),
      ],
    },
  },
};

/**
 * A publisher that reuses any ref the plan hands it, without proving it
 * is reachable from the captured root.
 */
export const PUBLISH_REUSES_UNPROVEN_REF: TreeMutant = {
  name: "publish-reuses-unproven-ref",
  defect: "the publisher reuses a ref that is not live under the captured root",
  options: { steps: { reuseIsLive: () => true } },
};

/** A publisher that adopts whatever body it finds at a conflicting create's key. */
export const PUBLISH_ADOPTS_WITHOUT_COMPARE: TreeMutant = {
  name: "publish-adopts-without-compare",
  defect: "create-conflict adoption accepts a body without comparing it to the one created",
  options: { steps: { adoptionBytesMatch: () => true } },
};

/** The publication mutants the publish suite must catch. */
export const PUBLISH_MUTANTS: readonly TreeMutant[] = [
  PUBLISH_HEAD_BEFORE_NODES,
  PUBLISH_REUSES_UNPROVEN_REF,
  PUBLISH_ADOPTS_WITHOUT_COMPARE,
];

// ---------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------

/**
 * A reader that refreshes the head's `tail_hint` to the tail it probed,
 * as a write tick does: a read that writes.
 */
export const READ_REFRESHES_TAIL_HINT: TreeMutant = {
  name: "read-refreshes-tail-hint",
  defect: "a read writes the head (a tail-hint refresh)",
  options: {
    steps: {
      readTail: async (read) => {
        const tail = await readTreeTail(read);
        const { head } = read;
        await read.storage.put(
          head.key,
          encodeJsonBytes({ ...head.json, tail_hint: Math.max(head.json.tail_hint, tail.tail) }),
          { ifMatch: head.etag },
        );
        return tail;
      },
    },
  },
};

/** A reader whose tail overlay drops deletes, so a base row shows through a tail `D`. */
export const READ_IGNORES_TAIL_DELETES: TreeMutant = {
  name: "read-ignores-tail-deletes",
  defect: "the tail overlay drops deletes",
  options: {
    steps: {
      readTail: async (read) => {
        const tail = await readTreeTail(read);
        return {
          ...tail,
          overlay: new Map([...tail.overlay].filter(([, doc]) => doc !== null)),
        };
      },
    },
  },
};

/** A reader that descends every child of every branch, so a point read loads every leaf. */
export const READ_DESCENDS_EVERY_CHILD: TreeMutant = {
  name: "read-descends-every-child",
  defect: "routing selects every child entry, not the ones whose range intersects the read",
  options: { steps: { selectChildren: (children) => children } },
};

/** A reader with no scan admission check: an over-ledger scan runs until the ledger refuses a GET. */
export const SCAN_SKIPS_ADMISSION: TreeMutant = {
  name: "scan-skips-admission",
  defect: "a complete scan is admitted whatever its bound and the ledger left",
  options: { steps: { admitsScan: () => true } },
};

/** A reader that reports every missing node as corrupt, even when the root moved under it. */
export const MISSING_NODE_IS_CORRUPT: TreeMutant = {
  name: "missing-node-is-corrupt",
  defect: "a node missing after a fold moved the root is InvalidResponse, not a restart",
  options: { steps: { missingNodeAction: () => "corrupt" } },
};

/** A reader that restarts every time the root moved, however often it already restarted. */
export const READ_RESTARTS_WITHOUT_BOUND: TreeMutant = {
  name: "read-restarts-without-bound",
  defect: "a read restarts on every root move instead of refusing the second",
  options: {
    steps: { missingNodeAction: ({ rootMoved }) => (rootMoved ? "restart" : "corrupt") },
  },
};

/** A reader that re-reads the head on the first not-found, without GETting the node again. */
export const MISSING_NODE_NOT_REFETCHED: TreeMutant = {
  name: "missing-node-not-refetched",
  defect: "a node GET that finds nothing is not issued once more",
  options: { steps: { regetsMissingNode: () => false } },
};

/** A reader that re-GETs a missing node and re-reads the head whatever the ledger has left. */
export const MISSING_NODE_SKIPS_LEDGER: TreeMutant = {
  name: "missing-node-skips-ledger",
  defect: "a missing node's re-GET and head re-read are issued whatever the ledger left",
  options: { steps: { admitsMissingNodeCall: () => true } },
};

/** A reader that restarts whatever the request ledger has left. */
export const RESTART_SKIPS_LEDGER: TreeMutant = {
  name: "restart-skips-ledger",
  defect: "a read restart is admitted whatever its charge and the ledger left",
  options: { steps: { admitsRestart: () => true } },
};

/** The reader mutants the read acceptance suites must catch. */
export const READ_MUTANTS: readonly TreeMutant[] = [
  READ_REFRESHES_TAIL_HINT,
  READ_IGNORES_TAIL_DELETES,
  READ_DESCENDS_EVERY_CHILD,
  SCAN_SKIPS_ADMISSION,
  MISSING_NODE_IS_CORRUPT,
  READ_RESTARTS_WITHOUT_BOUND,
  MISSING_NODE_NOT_REFETCHED,
  RESTART_SKIPS_LEDGER,
  MISSING_NODE_SKIPS_LEDGER,
];
