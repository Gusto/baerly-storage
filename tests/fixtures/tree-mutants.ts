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
import { branchHashCuts, chunkHash } from "../../packages/server/src/tree/chunk.ts";
import {
  TREE_LAYOUT_RULES,
  type TreeConstructorOptions,
} from "../../packages/server/src/tree/layout.ts";
import { sortMutationsById } from "../../packages/server/src/tree/plan.ts";

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
