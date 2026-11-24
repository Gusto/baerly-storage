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
import { foldRecordBase, foldRecordSuperseded } from "../../packages/server/src/tree/record.ts";
import { classifyFloor } from "../../packages/server/src/tree/gc.ts";
import {
  keyOnlyMember,
  TREE_GC_ROUTING,
  type TreeGcRootView,
  treeGcMembership,
  treeGcMembershipVia,
} from "../../packages/server/src/tree/gc-member.ts";
import { parseTreeNodeKey, treeNodeKeyPrefix } from "../../packages/server/src/tree/key.ts";

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

/** A publisher that creates the fresh nodes before the fold record. */
export const PUBLISH_NODES_BEFORE_RECORD: TreeMutant = {
  name: "publish-nodes-before-record",
  defect: "a fresh node is written before the fold record",
  options: {
    steps: {
      publicationOrder: (writes) => [
        ...writes.filter((write) => write.kind === "nodes"),
        ...writes.filter((write) => write.kind === "record"),
        ...writes.filter((write) => write.kind === "head"),
      ],
    },
  },
};

/** A fold record that also lists one of the nodes the new tree reuses. */
export const RECORD_NAMES_REUSED_NODE: TreeMutant = {
  name: "record-names-reused-node",
  defect: "the fold record lists a node the new tree reuses as superseded",
  options: {
    steps: {
      recordSuperseded: (root, read, reused) => [
        ...foldRecordSuperseded(root, read, reused),
        ...reused.slice(0, 1).map((entry) => `${entry.attempt}/${entry.sha256}`),
      ],
    },
  },
};

/** A fold record that leaves one superseded node out. */
export const RECORD_OMITS_SUPERSEDED: TreeMutant = {
  name: "record-omits-superseded",
  defect: "the fold record leaves out a superseded node",
  options: {
    steps: {
      recordSuperseded: (root, read, reused) =>
        foldRecordSuperseded(root, read, reused).slice(0, -1),
    },
  },
};

/**
 * A fold record that removes only the reused refs themselves from the
 * captured tree, not the read nodes below a reused branch.
 */
export const RECORD_NO_DOWNWARD_CLOSURE: TreeMutant = {
  name: "record-no-downward-closure",
  defect: "the fold record lists a node under a reused branch as superseded",
  options: {
    steps: {
      recordSuperseded: (root, read, reused) => {
        const kept = new Set(reused.map((entry) => `${entry.attempt}/${entry.sha256}`));
        return foldRecordSuperseded(root, read, []).filter((ref) => !kept.has(ref));
      },
    },
  },
};

/** A fold record whose base floor is one past the floor of the head the CAS is sent against. */
export const RECORD_FLOOR_NOT_CAPTURED: TreeMutant = {
  name: "record-floor-not-captured",
  defect: "the fold record's base floor is not the floor of the head being CASed",
  options: {
    steps: {
      recordBase: (head) => ({ ...foldRecordBase(head), floor: head.json.log_seq_start + 1 }),
    },
  },
};

/** The publication mutants the publish suite must catch. */
export const PUBLISH_MUTANTS: readonly TreeMutant[] = [
  PUBLISH_HEAD_BEFORE_NODES,
  PUBLISH_REUSES_UNPROVEN_REF,
  PUBLISH_ADOPTS_WITHOUT_COMPARE,
  PUBLISH_NODES_BEFORE_RECORD,
  RECORD_NAMES_REUSED_NODE,
  RECORD_OMITS_SUPERSEDED,
  RECORD_NO_DOWNWARD_CLOSURE,
  RECORD_FLOOR_NOT_CAPTURED,
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

// ---------------------------------------------------------------------
// Artifact GC
// ---------------------------------------------------------------------

/** A membership check that calls the current root's own key unreachable. */
export const GC_IGNORES_LIVE_ROOT: TreeMutant = {
  name: "gc-ignores-live-root",
  defect: "membership treats the current root's own key as unreachable",
  options: {
    steps: {
      gcIsMember: (x, view) =>
        x === view.root?.key ? Promise.resolve("non-member") : treeGcMembership(x, view),
    },
  },
};

/** A sweep that takes any key under the node prefix for a node key. */
export const GC_DELETES_UNPARSEABLE_KEY: TreeMutant = {
  name: "gc-deletes-unparseable-key",
  defect: "the sweep deletes a listed key that does not parse as a node key",
  options: {
    steps: {
      gcParsesKey: (prefix, key) => {
        const tail = key.slice(treeNodeKeyPrefix(prefix).length);
        return key.startsWith(treeNodeKeyPrefix(prefix))
          ? { attempt: tail.slice(0, 32), sha256: tail.slice(33) }
          : null;
      },
    },
  },
};

/** GC that deletes any corrupt candidate, not just a known loser's. */
export const GC_DELETES_CORRUPT_CANDIDATE: TreeMutant = {
  name: "gc-deletes-corrupt-candidate",
  defect: "a candidate whose body fails its hash or strict decode is deleted at depth 2 or more",
  options: { steps: { gcOnCorrupt: () => true } },
};

/** Membership by the root's child refs alone, at any depth. */
export const GC_KEY_ONLY_MEMBERSHIP_AT_DEPTH_2: TreeMutant = {
  name: "gc-key-only-membership-at-depth-2",
  defect: "the key-only root-children rule is applied at depth 2",
  options: {
    steps: {
      gcIsMember: async (x, view) => {
        const parts = parseTreeNodeKey(view.prefix, x);
        return parts !== null && keyOnlyMember(x, view.root, parts) ? "member" : "non-member";
      },
    },
  },
};

/** A descent that stops one level too deep, at the candidate's own level. */
export const GC_MEMBER_WRONG_LEVEL: TreeMutant = {
  name: "gc-member-wrong-level",
  defect: "the descent stops one level early or late",
  options: {
    steps: {
      gcIsMember: (x, view) =>
        treeGcMembershipVia(x, view, { ...TREE_GC_ROUTING, parentLevel: (level) => level }, true),
    },
  },
};

/** A parent entry that names a candidate by attempt alone. */
export const GC_MEMBER_ATTEMPT_ONLY: TreeMutant = {
  name: "gc-member-attempt-only",
  defect: "a parent entry matches the candidate by attempt alone",
  options: {
    steps: {
      gcIsMember: (x, view) =>
        treeGcMembershipVia(
          x,
          view,
          { ...TREE_GC_ROUTING, names: (entry, parts) => entry.attempt === parts.attempt },
          true,
        ),
    },
  },
};

/** A missing or undecodable path node read as non-membership. */
export const GC_PATH_MISS_AS_NONMEMBER: TreeMutant = {
  name: "gc-path-miss-as-nonmember",
  defect: "a missing or undecodable path node counts as non-membership",
  options: {
    steps: {
      gcIsMember: async (x, view) => {
        const found = await treeGcMembership(x, view);
        return found === "path-unreadable" ? "non-member" : found;
      },
    },
  },
};

/** A recorded node deleted without any check against the current root. */
export const GC_SKIPS_MEMBERSHIP_CHECK: TreeMutant = {
  name: "gc-skips-membership-check",
  defect: "a recorded node is deleted without checking the current root",
  options: { steps: { gcIsMember: () => Promise.resolve("non-member") } },
};

/** The root of the tick that noted each mark, remembered by key. */
const notedViews = new Map<string, TreeGcRootView>();

/** A sweep that checks each mark against the root of the tick that noted it. */
export const SWEEP_MEMBER_AGAINST_MARK_ROOT: TreeMutant = {
  name: "sweep-member-against-mark-root",
  defect: "the sweep checks membership against the root of the tick that noted the mark",
  options: {
    steps: {
      sweepIsMember: (x, view, phase) => {
        if (phase === "note") {
          notedViews.set(x, view);
          return treeGcMembership(x, view);
        }
        return treeGcMembership(x, notedViews.get(x) ?? view);
      },
    },
  },
};

/** A publisher that mints one identity and reuses it for every publication. */
export const PUBLISH_REUSES_ATTEMPT: TreeMutant = {
  name: "publish-reuses-attempt",
  defect: "a publication reuses the identity of an earlier attempt that lost",
  options: { steps: { mintAttempt: () => "a".repeat(32) } },
};

/** GC that deletes by any identity, reused or still publishing. */
export const GC_IGNORES_DUPLICATE_IDENTITY: TreeMutant = {
  name: "gc-ignores-duplicate-identity",
  defect: "an attempt id present in two records, or still publishing, is deleted by",
  options: { steps: { gcTrustsIdentity: () => true } },
};

/** GC that treats the records at the head's own floor as closed. */
export const GC_PROCESSES_OPEN_FLOOR: TreeMutant = {
  name: "gc-processes-open-floor",
  defect: "records at the head's own floor are treated as closed",
  options: { steps: { gcIsClosed: (floor, headFloor) => floor <= headFloor } },
};

/** GC that keeps its state across a generation change or a floor regression. */
export const GC_IGNORES_GENERATION: TreeMutant = {
  name: "gc-ignores-generation",
  defect: "the GC state is kept across a generation change or floor regression",
  options: { steps: { gcBindsHead: () => true } },
};

/** GC that swaps a floor's winner with one of its losers. */
export const GC_WINNER_AS_LOSER: TreeMutant = {
  name: "gc-winner-as-loser",
  defect:
    "the winner of a floor is treated as a loser, so its fresh nodes are deleted with no delay",
  options: {
    steps: {
      gcClassify: (members, evidence, duplicates) => {
        const verdict = classifyFloor(members, evidence, duplicates);
        const [swap, ...rest] = verdict.losers;
        return verdict.winner === null || swap === undefined
          ? verdict
          : { ...verdict, winner: swap, losers: [verdict.winner, ...rest] };
      },
    },
  },
};

/** GC that never drains a floor's losers. */
export const GC_LOSER_AS_WINNER: TreeMutant = {
  name: "gc-loser-as-winner",
  defect: "a loser of a floor is treated as the winner, so its fresh nodes are never deleted",
  options: {
    steps: {
      gcClassify: (members, evidence, duplicates) => ({
        ...classifyFloor(members, evidence, duplicates),
        losers: [],
      }),
    },
  },
};

/** GC that takes the first listed record of a floor as its winner. */
export const GC_WINNER_BY_KEY_ORDER: TreeMutant = {
  name: "gc-winner-by-key-order",
  defect: "the winner of a floor is the first listed record, not head or successor evidence",
  options: {
    steps: {
      gcClassify: (members, _evidence, duplicates) => {
        const eligible = members.filter((a) => !duplicates.has(a));
        const [winner, ...losers] = eligible;
        return winner === undefined
          ? { winner: null, losers: [], ambiguous: false }
          : { winner, losers, ambiguous: false };
      },
    },
  },
};

/** GC that never waits for a due time. */
export const GC_IGNORES_DUE_AT: TreeMutant = {
  name: "gc-ignores-due-at",
  defect: "superseded nodes are deleted in the tick that resolves their group",
  options: { steps: { gcIsDue: () => true } },
};

/** GC that reads its clock locally instead of from the storage server. */
export const GC_LOCAL_CLOCK: TreeMutant = {
  name: "gc-local-clock",
  defect: "due times come from the local clock instead of storage server time",
  options: { steps: { gcNow: (_serverDate, local) => local } },
};

/** A sweep that stamps marks without a later fold moving the floor. */
export const SWEEP_NO_FLOOR_GATE: TreeMutant = {
  name: "sweep-no-floor-gate",
  defect: "the sweep stamps or deletes a mark without a later fold moving the floor",
  options: { steps: { sweepPassesFloorGate: () => true } },
};

/** A probe tick that reads the head before it lists the sweep page. */
export const SWEEP_FLOOR_BEFORE_LIST: TreeMutant = {
  name: "sweep-floor-before-list",
  defect: "the sweep notes marks with a head floor read before its LIST",
  options: { steps: { sweepListsBeforeHead: () => false } },
};

/** A sweep that starts a mark's age when it notes it. */
export const SWEEP_AGE_FROM_NOTE: TreeMutant = {
  name: "sweep-age-from-note",
  defect: "the sweep's age starts when a mark is noted, not when it is stamped",
  options: { steps: { sweepStartsAge: (phase) => phase === "note" } },
};

/** GC that calls a candidate corrupt on its first failed read. */
export const GC_CORRUPT_NO_RETRY: TreeMutant = {
  name: "gc-corrupt-no-retry",
  defect: "a candidate's failed GET is not retried before it is counted corrupt",
  options: { steps: { gcRetriesCorrupt: () => false } },
};

/** The GC mutants the GC suite must catch. */
export const GC_MUTANTS: readonly TreeMutant[] = [
  GC_IGNORES_LIVE_ROOT,
  GC_DELETES_UNPARSEABLE_KEY,
  GC_DELETES_CORRUPT_CANDIDATE,
  GC_KEY_ONLY_MEMBERSHIP_AT_DEPTH_2,
  GC_MEMBER_WRONG_LEVEL,
  GC_MEMBER_ATTEMPT_ONLY,
  GC_PATH_MISS_AS_NONMEMBER,
  SWEEP_MEMBER_AGAINST_MARK_ROOT,
  GC_SKIPS_MEMBERSHIP_CHECK,
  PUBLISH_REUSES_ATTEMPT,
  GC_IGNORES_DUPLICATE_IDENTITY,
  GC_PROCESSES_OPEN_FLOOR,
  GC_IGNORES_GENERATION,
  GC_WINNER_AS_LOSER,
  GC_LOSER_AS_WINNER,
  GC_WINNER_BY_KEY_ORDER,
  GC_IGNORES_DUE_AT,
  GC_LOCAL_CLOCK,
  SWEEP_NO_FLOOR_GATE,
  SWEEP_FLOOR_BEFORE_LIST,
  SWEEP_AGE_FROM_NOTE,
  GC_CORRUPT_NO_RETRY,
];
