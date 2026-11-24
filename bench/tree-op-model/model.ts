/**
 * Static storage-call model for a content-addressed tree layout: the
 * worst-case storage calls of one maintenance tick, a point read and a
 * full scan, against the Workers Paid request ledger (the tree's design
 * target) and the Workers Free + R2 binding ledger (the floor: writes
 * capped at depth 0, reads of any depth).
 *
 * Pure and I/O-free. It answers "does this tree shape fit the host's
 * request budget", not "is it fast": CPU is a separate question.
 *
 * The layout modelled is one prolly tree per collection (content-defined,
 * key-only boundaries, wide nodes), whose head
 * (`current.json`) names `{root, folded seq}`. A write tick folds a bounded
 * prefix of the log tail along the changed root-to-leaf paths only: it GETs
 * those paths, PUTs new leaves and new internal nodes (children before
 * parents, create-only and content-addressed), then CASes the head. Depth 0
 * is today's layout: the root is the single snapshot object.
 *
 * Every count reuses main's call structure (`runBoundedMaintenance` +
 * `compact()` for the tick, the collection read for reads, the `Writer`
 * hot path for the write the tick shares an invocation with) and replaces
 * only the one snapshot GET/PUT with path and leaf calls, so at depth 0 the
 * model reproduces `request-counts.json` exactly (`model.test.ts`).
 *
 * Every layout parameter is a field of {@link TreeParams} (defaults: the
 * prototype's starting values) and every assumption this model does not
 * fix is a field of {@link DesignAssumptions}, never a hidden constant.
 */

import {
  CF_FREE_INTERNAL_REQUEST_LIMIT,
  CF_PAID_REQUEST_LIMIT,
  COMMIT_RESOLUTION_RESERVE,
  GC_PENDING_CAS_MAX_ATTEMPTS,
  GC_MARK_LIST_PAGE_KEYS,
  LOG_RETENTION_MAX_DELETES_PER_TICK,
  MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  MAINTENANCE_MAX_FOLD_ROWS,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_CF_PAID,
  STORAGE_RETRY_MAX_ATTEMPTS,
  WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_GC_MAX_SWEEPS,
} from "@baerly/protocol";

// ── Call tallies ─────────────────────────────────────────────────────────

/**
 * Logical storage calls by retry class. `creates` are create-only PUTs
 * (`If-None-Match: "*"`), which the adapter retries; `casPuts` are
 * `If-Match` PUTs, which it sends once (a resend after a lost ack would meet
 * its own write as a 412: `STORAGE_RETRY_MAX_ATTEMPTS` JSDoc);
 * `unretriedGets` are GETs that explicitly bypass adapter retries;
 * the best-effort `tail_hint` refresh uses a normal retried GET.
 */
export interface Calls {
  readonly gets: number;
  readonly unretriedGets: number;
  readonly creates: number;
  readonly casPuts: number;
  readonly deletes: number;
  readonly listPages: number;
}

const ZERO: Calls = {
  gets: 0,
  unretriedGets: 0,
  creates: 0,
  casPuts: 0,
  deletes: 0,
  listPages: 0,
};

export const sumCalls = (...parts: readonly Partial<Calls>[]): Calls =>
  parts.reduce<Calls>(
    (acc, p) => ({
      gets: acc.gets + (p.gets ?? 0),
      unretriedGets: acc.unretriedGets + (p.unretriedGets ?? 0),
      creates: acc.creates + (p.creates ?? 0),
      casPuts: acc.casPuts + (p.casPuts ?? 0),
      deletes: acc.deletes + (p.deletes ?? 0),
      listPages: acc.listPages + (p.listPages ?? 0),
    }),
    ZERO,
  );

/** The `request-counts.json` cell shape: calls by kind, one attempt each. */
export interface KindCounts {
  readonly get: number;
  readonly put: number;
  readonly delete: number;
  readonly listPage: number;
}

export const byKind = (c: Calls): KindCounts => ({
  get: c.gets + c.unretriedGets,
  put: c.creates + c.casPuts,
  delete: c.deletes,
  listPage: c.listPages,
});

// ── Retry policy ─────────────────────────────────────────────────────────

/** How many requests the ledger charges per logical call. */
export interface RetryPolicy {
  /** Attempts per retried call. Main: `STORAGE_RETRY_MAX_ATTEMPTS`, one layer only. */
  readonly attemptsPerCall: number;
  /**
   * Attempts per `If-Match` PUT. Main: 1 (`STORAGE_RETRY_MAX_ATTEMPTS`
   * JSDoc). A lost head CAS is not retried inside the tick: only one fold
   * wins per head version.
   */
  readonly casAttempts: number;
  /**
   * UNSPECIFIED BY THIS MODEL. Readback GETs per node create after a create
   * of unknown outcome, to adopt a byte-identical occupant (adoption of an
   * existing node is safe only when its bytes are identical).
   * Each readback is itself retried. Main's `log/<seq>` create pays exactly
   * one such readback (`COMMIT_RESOLUTION_RESERVE` JSDoc); 1 assumes node
   * creates resolve the same way.
   */
  readonly adoptionReadbacksPerCreate: number;
}

/** Every call answered first time: what `request-counts.json` records. */
export const HAPPY_PATH: RetryPolicy = {
  attemptsPerCall: 1,
  casAttempts: 1,
  adoptionReadbacksPerCreate: 0,
};

/** Every retried call spends every attempt. */
export const ALL_ATTEMPTS: RetryPolicy = {
  attemptsPerCall: STORAGE_RETRY_MAX_ATTEMPTS,
  casAttempts: 1,
  adoptionReadbacksPerCreate: 1,
};

/** Requests the ledger charges for `c` under `policy`. */
export const chargedRequests = (c: Calls, policy: RetryPolicy): number => {
  const a = policy.attemptsPerCall;
  return (
    (c.gets + c.deletes + c.listPages) * a +
    c.creates * a * (1 + policy.adoptionReadbacksPerCreate) +
    c.unretriedGets +
    c.casPuts * policy.casAttempts
  );
};

// ── Tree shape ───────────────────────────────────────────────────────────

/**
 * A tree's shape. `depth` counts internal levels above the leaves: depth 0
 * is a single leaf (today's snapshot), depth `d` has `d` internal nodes on
 * every root-to-leaf path. `fanout` is the worst-case (least-filled)
 * children per internal node, so `fanout ** depth >= leaves`.
 */
export interface TreeShape {
  readonly depth: number;
  readonly fanout: number;
  readonly leaves: number;
}

/** Nodes at level `level` (0 = root, `depth` = leaves). */
export const nodesAtLevel = (shape: TreeShape, level: number): number =>
  Math.max(1, Math.ceil(shape.leaves / shape.fanout ** (shape.depth - level)));

/** Internal nodes in the whole tree. */
export const internalNodeCount = (shape: TreeShape): number => {
  let n = 0;
  for (let level = 0; level < shape.depth; level++) {
    n += nodesAtLevel(shape, level);
  }
  return n;
};

/**
 * How the changed leaves sit in the tree. `distinct`: no two share a parent
 * below the root, the worst case for the internal-node union (about k*d
 * nodes). `shared`: the changed leaves are contiguous,
 * so they share every ancestor they can, the best case.
 */
export type PathSharing = "distinct" | "shared";

/** Internal nodes on the union of the root-to-leaf paths of `leavesTouched` leaves. */
export const pathUnionInternalNodes = (
  shape: TreeShape,
  leavesTouched: number,
  sharing: PathSharing,
): number => {
  let n = 0;
  for (let level = 0; level < shape.depth; level++) {
    const atLevel = nodesAtLevel(shape, level);
    const span =
      sharing === "distinct"
        ? leavesTouched
        : Math.ceil(leavesTouched / shape.fanout ** (shape.depth - level));
    n += Math.min(atLevel, span);
  }
  return n;
};

// ── Collections and tree parameters ──────────────────────────────────────

/** A collection's logical size. */
export interface CollectionSize {
  readonly bytes: number;
  readonly rows: number;
}

/**
 * The floor's largest collection: fold ceilings `C` / `E` of the `cf-free`
 * profile, 512 KiB / 2,048 rows.
 */
export const FLOOR_COLLECTION: CollectionSize = {
  bytes: MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  rows: MAINTENANCE_MAX_FOLD_ROWS,
};

/**
 * The design target's largest collection: fold ceilings `C` / `E` of the
 * `cf-paid` profile, 8 MiB / 32,768 rows (Paid is the tree's design
 * target).
 */
export const PAID_COLLECTION: CollectionSize = {
  bytes: MAINTENANCE_PROFILE_CF_PAID.maxFoldBytes,
  rows: MAINTENANCE_PROFILE_CF_PAID.maxFoldRows,
};

/**
 * The tree's layout parameters. The defaults are the prototype's starting
 * values (`PROTOTYPE_TREE_DEFAULTS`), not settled design, and the CLI
 * names them in its output.
 */
export interface TreeParams {
  /** CDC target leaf size in bytes. */
  readonly leafTargetBytes: number;
  /**
   * Worst-case fill of a leaf as a fraction of the target (the chunker's
   * minimum cut over its target). The worst case for request counts is the
   * least-filled tree: most leaves.
   */
  readonly leafMinFill: number;
  /**
   * Worst-case (least) children per internal node, the internal fanout
   * target: the depth a collection reaches is the least `d` with
   * `minFanout ** d >= leaves` ({@link canonicalDepth}).
   */
  readonly minFanout: number;
  /**
   * Most children an internal node can name (its hard max over a child
   * descriptor's size). `Infinity` means unconstrained, so any depth can
   * hold the collection.
   */
  readonly maxFanout: number;
  /**
   * Depth-0 rule `T`: a collection at or under `T` in both document bytes
   * and rows (inclusive; 512 KiB / 2,048 rows by default) is one leaf,
   * today's snapshot; above it the CDC rule applies.
   */
  readonly depth0: CollectionSize;
}

/**
 * Prototype starting values: 16 KiB leaf target at 0.5 minimum fill,
 * fanout >= 32 (the least at which Paid C/E is depth <= 2: 8 MiB / 8 KiB =
 * 1,024 leaves = 32 ** 2), no fanout hard max, and `T` = today's floor C/E.
 */
export const PROTOTYPE_TREE_DEFAULTS: TreeParams = {
  leafTargetBytes: 16 * 1024,
  leafMinFill: 0.5,
  minFanout: 32,
  maxFanout: Infinity,
  depth0: FLOOR_COLLECTION,
};

/** The leaf targets swept before one is chosen. */
export const LEAF_TARGET_SWEEP: readonly number[] = [16 * 1024, 64 * 1024];

/** Refuse counts or dimensions that cannot be represented exactly. */
export const assertSafeInteger = (value: number, name: string, minimum = 0): void => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}, got ${value}`);
  }
};

/** Validate layout domains before deriving a shape or its depth. */
export const validateTreeParams = (params: TreeParams): void => {
  assertSafeInteger(params.leafTargetBytes, "leaf-bytes", 1);
  if (!Number.isFinite(params.leafMinFill) || params.leafMinFill <= 0 || params.leafMinFill > 1) {
    throw new RangeError(`min-fill must be finite and in (0, 1], got ${params.leafMinFill}`);
  }
  assertSafeInteger(params.minFanout, "min-fanout", 2);
  if (params.maxFanout !== Infinity) {
    assertSafeInteger(params.maxFanout, "max-fanout", params.minFanout);
  }
  assertSafeInteger(params.depth0.bytes, "t-bytes");
  assertSafeInteger(params.depth0.rows, "t-rows");
};

/** Leaves of `size` in its least-filled tree: at most one per row. */
export const leafCount = (params: TreeParams, size: CollectionSize): number => {
  validateTreeParams(params);
  assertSafeInteger(size.bytes, "collection bytes");
  assertSafeInteger(size.rows, "collection rows");
  return Math.min(size.rows, Math.ceil(size.bytes / (params.leafTargetBytes * params.leafMinFill)));
};

/**
 * The depth the canonical tree of `size` has under `params`: 0 within the
 * depth-0 rule's `T` (or when the content fits one leaf), else the least
 * depth whose worst-case fanout holds every leaf.
 */
export const canonicalDepth = (params: TreeParams, size: CollectionSize): number => {
  const leaves = leafCount(params, size);
  if ((size.bytes <= params.depth0.bytes && size.rows <= params.depth0.rows) || leaves < 2) {
    return 0;
  }
  let depth = 1;
  while (params.minFanout ** depth < leaves) {
    depth++;
  }
  return depth;
};

/**
 * The worst-case shape of `size` as a depth-`depth` tree: as many leaves as
 * minimum fill allows, and the least fanout that still reaches that depth.
 * `null` when the collection cannot take that depth: one leaf at depth >= 1,
 * or more leaves than `maxFanout ** depth`. Depth 0 is always one leaf,
 * today's snapshot. The shape ignores `minFanout`, so a depth deeper than
 * {@link canonicalDepth} still has a (more pessimistic) row.
 */
export const collectionShape = (
  depth: number,
  params: TreeParams,
  size: CollectionSize,
): TreeShape | null => {
  assertSafeInteger(depth, "depth");
  const leaves = leafCount(params, size);
  if (depth === 0) {
    return { depth: 0, fanout: 1, leaves: 1 };
  }
  if (leaves < 2) {
    return null;
  }
  let fanout = 2;
  while (fanout ** depth < leaves) {
    fanout++;
  }
  // A depth-d tree with fanout F needs more than F^(d-1) leaves, or it is
  // really a shallower tree.
  if (fanout > params.maxFanout || fanout ** (depth - 1) >= leaves) {
    return null;
  }
  return { depth, fanout, leaves };
};

// ── Design assumptions ───────────────────────────────────────────────────

/** Assumptions this model does not fix. Each field says where it would be settled. */
export interface DesignAssumptions {
  /**
   * UNSPECIFIED. Neighbor leaves a changed leaf drags into the fold when its
   * content-defined boundary moves (a cut disappears or appears and merges
   * or splits into the next leaf). No propagation bound is demonstrated
   * yet. Each neighbor is read and rewritten. Applies at depth >= 1 only.
   */
  readonly neighborLeavesPerChangedLeaf: number;
  /**
   * UNSPECIFIED. Extra node creates per rewritten node when an edit splits
   * it in two (a leaf, or a parent gaining a child). Applies at depth >= 1
   * only; depth 0 rewrites the single snapshot. A root split that adds a
   * level is not modelled (the shape's depth is fixed per tick).
   */
  readonly splitCreatesPerRewrittenNode: number;
  /**
   * UNSPECIFIED. GETs per GC tick to establish the fresh root's live set
   * (bounded transitive membership). `"internal-nodes"` walks every internal node
   * of the fresh root (parents name their children, so leaves need no
   * GET); a number is a fixed per-tick budget, e.g. a fence journal.
   */
  readonly gcMembershipGets: "internal-nodes" | number;
  /**
   * UNSPECIFIED. Node objects the GC LIST walks, as a multiple of the live
   * node count (live nodes plus superseded nodes awaiting sweep). Main lists
   * one snapshot per fold; a tree retains every replaced path node.
   */
  readonly gcListedObjectsPerLiveNode: number;
}

/**
 * Defaults for the open assumptions, chosen to be conservative, never as a
 * claim about the layout. The CLI prints them.
 */
export const DEFAULT_ASSUMPTIONS: DesignAssumptions = {
  neighborLeavesPerChangedLeaf: 1,
  splitCreatesPerRewrittenNode: 1,
  gcMembershipGets: "internal-nodes",
  gcListedObjectsPerLiveNode: 2,
};

// ── Tick ─────────────────────────────────────────────────────────────────

export interface FoldTickInput {
  readonly shape: TreeShape;
  /** Changed leaves the folded entries land in (at most `entriesFolded`, at most the tree's leaves). */
  readonly changedLeaves: number;
  readonly sharing: PathSharing;
  /**
   * Log entries the pass folds. Main's `cf-free` pass:
   * `WRITE_TICK_FOLD_ENTRIES_PER_PASS` (20). Each entry changes at most
   * one leaf, so `changedLeaves <= entriesFolded`.
   */
  readonly entriesFolded: number;
  /** No prior tree: the first fold reads no leaf or path. */
  readonly emptyBase: boolean;
  /**
   * Commits that land between the writer's observed tail and the fold's
   * tail probe; each costs the probe one more GET. 0 in the request-count grid.
   */
  readonly concurrentCommits: number;
  /**
   * Worst case for the head CAS: it is lost. The tree's publisher then
   * re-reads the head once to resolve the CAS's fate (one retried GET,
   * `packages/server/src/tree/publish.ts`; main's `compact()` has no such
   * read), and the tick also pays the closing best-effort `tail_hint`
   * refresh (one retried GET + an unretried CAS PUT).
   */
  readonly headCasLost: boolean;
  readonly assumptions: DesignAssumptions;
}

/** Leaves a fold reads and rewrites: the changed ones plus boundary neighbors. */
export const leavesTouched = (input: FoldTickInput): number => {
  const changed = Math.min(input.changedLeaves, input.shape.leaves);
  const neighbors =
    input.shape.depth === 0 ? 0 : changed * input.assumptions.neighborLeavesPerChangedLeaf;
  return Math.min(input.shape.leaves, changed + neighbors);
};

/**
 * Fold-record creates per fold attempt: one, before any node
 * (`packages/server/src/tree/publish.ts`). Like a node create it is
 * retried and may need one adoption readback, so under every-attempt
 * charging it costs 6 calls.
 */
export const FOLD_RECORD_CREATES = 1;

/**
 * One write-tick fold, as main's single-phase tick runs it
 * (`runBoundedMaintenance` Step 3 + `compact()`), with the snapshot GET/PUT
 * replaced by path and leaf calls:
 *
 * - runner `current.json` GET (1);
 * - `compact()`'s `current.json` GET (1);
 * - tail probe at the writer's observed tail (1 + concurrent commits);
 * - one GET per folded log entry;
 * - internal node GETs on the union of changed paths, and the touched leaves;
 * - the fold record's create (1), before any node;
 * - node creates: every touched leaf and every union node, plus splits;
 * - the head CAS (1), and on a lost CAS the fate re-read of the head and
 *   the closing `tail_hint` refresh.
 *
 * At depth 0 with one leaf that is `MAINTENANCE_FOLD_BASE_REQUESTS + 1 + e`
 * plus the fold record (27 at e = 20): the `tick:fold` cells of
 * `request-counts.json`, which count main's compactor, plus one create.
 */
export const foldTickCalls = (input: FoldTickInput): Calls => {
  const { shape, assumptions } = input;
  const leaves = leavesTouched(input);
  const union = pathUnionInternalNodes(shape, leaves, input.sharing);
  const rewritten = union + leaves;
  const splits = shape.depth === 0 ? 0 : rewritten * assumptions.splitCreatesPerRewrittenNode;
  return sumCalls(
    { gets: 1 + 1 + 1 + input.concurrentCommits + input.entriesFolded },
    input.emptyBase ? {} : { gets: union + leaves },
    { creates: FOLD_RECORD_CREATES + rewritten + splits, casPuts: 1 },
    input.headCasLost ? { gets: 2, casPuts: 1 } : {},
  );
};

/**
 * How contended and how due a GC tick is. Main's GC slice
 * (`packages/server/src/maintenance.ts`, the `CLOUDFLARE_FREE_TIER` JSDoc
 * "GC, maximally contended": 12 + S) pays for contention on the
 * `gc/pending.json` ledger and for a due sweep; these say which of those
 * the tick pays. The tree design does not change them.
 */
export interface GcTickState {
  /**
   * `gc/pending.json` does not exist yet, so the slice creates it (one
   * create-only PUT) before its CAS.
   */
  readonly pendingBootstrap: boolean;
  /** The bootstrap create lost a race, so the slice re-reads the pending ledger (one GET). */
  readonly pendingBootstrapConflict: boolean;
  /**
   * Attempts of the final pending CAS, each a GET + an `If-Match` PUT. 1
   * uncontended; at most `GC_PENDING_CAS_MAX_ATTEMPTS` (3).
   */
  readonly pendingCasAttempts: number;
  /** A sweep is due, so the slice re-reads `current.json` before deleting (one GET). */
  readonly freshCurrentGet: boolean;
  /**
   * The tick's rate-limited `tail_hint` refresh runs (one retried
   * GET + CAS PUT, `MAINTENANCE_TAIL_HINT_REFRESH_REQUESTS`). Due when the
   * hint lags by `MAINTENANCE_TAIL_HINT_REFRESH_WRITES`.
   */
  readonly tailHintRefresh: boolean;
}

/** The worst GC tick: every contention arm, a due sweep, and the refresh. */
export const GC_WORST_STATE: GcTickState = {
  pendingBootstrap: true,
  pendingBootstrapConflict: true,
  pendingCasAttempts: GC_PENDING_CAS_MAX_ATTEMPTS,
  freshCurrentGet: true,
  tailHintRefresh: true,
};

export interface GcTickInput {
  readonly shape: TreeShape;
  /** Delete cap per tick. Main's `cf-free` slice: `WRITE_TICK_GC_MAX_SWEEPS`. */
  readonly sweeps: number;
  /**
   * Log objects the retirement pass deletes. Main's cap:
   * `LOG_RETENTION_MAX_DELETES_PER_TICK`. With 0 the pass stops after its
   * advisory gate GET.
   */
  readonly retirementDeletes: number;
  /** Keys per LIST page. S3 and R2 return up to `GC_MARK_LIST_PAGE_KEYS` (1,000). */
  readonly listPageKeys: number;
  readonly state: GcTickState;
  readonly assumptions: DesignAssumptions;
}

/**
 * One hard-GC write tick (`runBoundedMaintenance` Step 2: GC slice, the
 * `tail_hint` refresh, then log retirement; never in the same tick as a
 * fold), with the snapshot LIST replaced by a LIST of the node namespace
 * and a membership walk:
 *
 * - runner `current.json` GET (1);
 * - GC slice: its `current.json` GET, the `gc/pending.json` GET, the LIST
 *   (here: every listed node, paged), the bootstrap create and its
 *   conflict re-read, the fresh `current.json` GET before a due sweep,
 *   each pending CAS attempt (GET + PUT), membership GETs, one DELETE per
 *   sweep;
 * - the `tail_hint` refresh (retried GET + unretried CAS PUT) when due;
 * - retirement: the advisory gate GET, then, with something to retire, the
 *   floor CAS's GET + PUT and one DELETE per log object
 *   (`MAINTENANCE_RETIRE_PRE_FLOOR_REQUESTS`, 7 at all attempts).
 *
 * At depth 0 this is main: `model.test.ts` asserts the uncontended state
 * against the `tick:gc` / `tick:gc-sweep` cells of `request-counts.json`
 * and the worst state against `maintenance-budget.test.ts`'s pinned
 * contended tick.
 */
export const gcTickCalls = (input: GcTickInput): Calls => {
  const { shape, assumptions, state } = input;
  const liveNodes = internalNodeCount(shape) + shape.leaves;
  const listed = Math.ceil(liveNodes * assumptions.gcListedObjectsPerLiveNode);
  const listPages = Math.max(1, Math.ceil(listed / input.listPageKeys));
  const membership =
    assumptions.gcMembershipGets === "internal-nodes"
      ? internalNodeCount(shape)
      : assumptions.gcMembershipGets;
  return sumCalls(
    { gets: 1 },
    { gets: 2 + membership, listPages, deletes: input.sweeps },
    state.pendingBootstrap ? { creates: 1 } : {},
    state.pendingBootstrapConflict ? { gets: 1 } : {},
    { gets: state.pendingCasAttempts, casPuts: state.pendingCasAttempts },
    state.freshCurrentGet ? { gets: 1 } : {},
    state.tailHintRefresh ? { gets: 1, casPuts: 1 } : {},
    { gets: 1 },
    input.retirementDeletes > 0 ? { gets: 1, casPuts: 1, deletes: input.retirementDeletes } : {},
  );
};

// ── Tree GC tick ─────────────────────────────────────────────────────────

/**
 * Charged calls of one tree GC candidate check at root level `depth`:
 * its DELETE plus its membership GETs, each charged at every attempt.
 * At depth 0 or 1 membership is decided from the key alone; above, a
 * check GETs the candidate and at most `depth − 1` path nodes
 * (`packages/server/src/tree/gc-member.ts`).
 */
export const treeGcCandidateCalls = (depth: number): number =>
  depth <= 1 ? STORAGE_RETRY_MAX_ATTEMPTS : STORAGE_RETRY_MAX_ATTEMPTS * (depth + 1);

/**
 * The static bound on one tree GC tick's charged calls with `candidates`
 * checks at root level `depth` (`packages/server/src/tree/gc.ts`): the
 * state GET, the sweep and record LISTs, the head and root GETs, 4
 * record GETs and 4 record DELETEs (each charged at every attempt), one
 * state create (retried) and one state CAS (sent once), the checks, and
 * log retirement (its gate GET alone, or 69 when it finds work).
 */
export const treeGcTickBound = (
  candidates: number,
  depth: number,
  retirementFindsWork: boolean,
): number => {
  const a = STORAGE_RETRY_MAX_ATTEMPTS;
  const fixed = 5 * a + 4 * a + 4 * a + a + 1;
  const retire = retirementFindsWork ? 3 * a + 20 * a : a;
  return fixed + candidates * treeGcCandidateCalls(depth) + retire;
};

/**
 * Class A operations per minute that tree GC adds, at `foldsPerMinute`
 * folds and `ticksPerMinute` GC ticks a minute: each fold attempt's
 * record create and at most one state write to resolve its floor; per
 * clock probe (at most one a minute) two state writes and the sweep's
 * LIST page; and per tick one LIST page of the fold records. Only that
 * last term grows with the tick rate, so with in-band ticks it grows
 * with the write rate.
 */
export const treeGcClassAPerMinute = (foldsPerMinute: number, ticksPerMinute: number): number =>
  foldsPerMinute * 2 + 3 + ticksPerMinute;

// ── Reads ────────────────────────────────────────────────────────────────

export interface ReadInput {
  readonly shape: TreeShape;
  /** Unfolded log entries past the head's folded seq. */
  readonly tailEntries: number;
  readonly emptyBase: boolean;
}

/**
 * A point read (`get(id)`): head GET, the internal nodes on one path, the
 * leaf, every tail entry (the strict walk to `tail_hint` plus the forward
 * probe's occupied slots), and the probe's one terminating miss. Reads are
 * pure: no maintenance. Depth 0 is `3 + T`, the `get` cells.
 */
export const pointReadCalls = (input: ReadInput): Calls =>
  sumCalls(
    { gets: 1 + input.tailEntries + 1 },
    input.emptyBase ? {} : { gets: input.shape.depth + 1 },
  );

/**
 * A full scan (`where` on an unindexed field, or any read on this layout:
 * every read folds the whole collection, `read-admission.ts`): head GET,
 * every internal node, every leaf, the tail and the probe miss. Depth 0 is
 * `3 + T`, the `scan` cells.
 */
export const scanCalls = (input: ReadInput): Calls =>
  sumCalls(
    { gets: 1 + input.tailEntries + 1 },
    input.emptyBase ? {} : { gets: internalNodeCount(input.shape) + input.shape.leaves },
  );

// ── The write the tick shares an invocation with ─────────────────────────

/**
 * GETs `findLogTail` spends from `hint` when the true tail is `gap` slots
 * past it: a gallop to bracket the tail, then a binary search. Exact
 * replay of `packages/server/src/log-tail.ts`'s loop over a dense prefix.
 */
export const findLogTailGets = (gap: number): number => {
  const exists = (offset: number): boolean => offset < gap;
  let gets = 1;
  if (!exists(0)) {
    return gets;
  }
  let lo = 0;
  let step = 1;
  let hi = step;
  for (;;) {
    gets++;
    if (!exists(hi)) {
      break;
    }
    lo = hi;
    step *= 2;
    hi = lo + step;
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    gets++;
    if (exists(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return gets;
};

export interface WriteRouteInput {
  readonly read: ReadInput;
  /**
   * UNSPECIFIED. What the write reads before it commits. Main reads the
   * whole collection (`insert` = the `get` cell + the writer's 3 GETs +
   * the create); on a tree a capacity / pre-image check may need only the
   * target path (`"point"`) or still the whole tree (`"scan"`). Equal at
   * depth 0.
   */
  readonly writeStateRead: "point" | "scan";
  /** Slots the true tail is past `tail_hint` (≤ `MAINTENANCE_TAIL_HINT_REFRESH_WRITES` when healthy). */
  readonly tailHintLag: number;
}

/**
 * The write route before its commit hold: its state read plus the
 * `Writer`'s `current.json` GET and `findLogTail` probe. The committing
 * create and the delete-floor `current.json` GET are not here: they are
 * inside the commit hold, {@link commitHoldRequests}.
 */
export const writeRouteCalls = (input: WriteRouteInput): Calls =>
  sumCalls(input.writeStateRead === "point" ? pointReadCalls(input.read) : scanCalls(input.read), {
    gets: 1 + findLogTailGets(input.tailHintLag),
  });

/**
 * Requests a commit holds on the ledger: the `log/<seq>` create at every
 * attempt plus `COMMIT_RESOLUTION_RESERVE` (occupant readback and the
 * delete-floor GET, each at every attempt). Held whatever the retry
 * policy, so the reserve stays intact (`writer.ts` `#withCommitHold`).
 */
export const commitHoldRequests = (): number =>
  STORAGE_RETRY_MAX_ATTEMPTS + COMMIT_RESOLUTION_RESERVE;

// ── Ledgers and hosts ────────────────────────────────────────────────────

/**
 * A per-invocation request ledger, margin already taken. Storage reaches
 * the bucket through the R2 binding, so every charge is on one pool:
 * Free's `internal` pool, or Paid's single limit (which covers binding and
 * `fetch` calls alike). Free + S3 over `fetch` is not a supported host and
 * is not modelled.
 */
export interface Ledger {
  readonly internal: number;
}

/**
 * The Workers Free + R2 binding ledger: 900 internal requests, the
 * documented 1,000 internal subrequests less the 10% margin
 * (`CF_FREE_INTERNAL_REQUEST_LIMIT`). R2 binding calls charge no
 * `external` request and the Worker makes no Cache API call.
 */
export const FREE_LEDGER: Ledger = {
  internal: CF_FREE_INTERNAL_REQUEST_LIMIT,
};

/**
 * The Workers Paid ledger: 9,000 requests, Paid's default 10,000
 * subrequests less the 10% margin (`CF_PAID_REQUEST_LIMIT`, the limit the
 * `cf-paid` profile enforces).
 */
export const PAID_LEDGER: Ledger = {
  internal: CF_PAID_REQUEST_LIMIT,
};

/**
 * A host: its ledger, its largest collection (fold ceilings `C` / `E`),
 * and the in-band write tick's per-pass caps under its maintenance
 * profile (`runBoundedMaintenance`).
 */
export interface HostProfile {
  readonly name: string;
  readonly ledger: Ledger;
  readonly collection: CollectionSize;
  /** Log entries one fold pass takes (`maxFoldEntriesPerPass`). */
  readonly entriesPerPass: number;
  /** Storage calls a fold keeps in flight at once (`foldParallelCalls`). */
  readonly foldParallelCalls: number;
  /** GC deletes per tick (`gcMaxSweeps`). */
  readonly gcSweeps: number;
  /** Log objects one retirement pass deletes (`LOG_RETENTION_MAX_DELETES_PER_TICK`). */
  readonly retirementDeletes: number;
  /** Keys per LIST page. S3 and R2 return up to `GC_MARK_LIST_PAGE_KEYS` (1,000). */
  readonly listPageKeys: number;
  /**
   * Default unfolded tail a read replays: the larger of the in-band fold
   * floor (`WRITE_TICK_MIN_ENTRIES_TO_COMPACT`) and one pass, so the read
   * that shares an invocation with a full pass sees that pass's entries.
   */
  readonly tailEntries: number;
}

/** Workers Free + R2 binding under `cf-free`: the floor, writes capped at depth 0. */
export const FREE_R2_HOST: HostProfile = {
  name: "Free + R2",
  ledger: FREE_LEDGER,
  collection: FLOOR_COLLECTION,
  entriesPerPass: WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  foldParallelCalls: MAINTENANCE_PROFILE_CF_FREE.foldParallelCalls,
  gcSweeps: WRITE_TICK_GC_MAX_SWEEPS,
  retirementDeletes: LOG_RETENTION_MAX_DELETES_PER_TICK,
  listPageKeys: GC_MARK_LIST_PAGE_KEYS,
  tailEntries: Math.max(WRITE_TICK_MIN_ENTRIES_TO_COMPACT, WRITE_TICK_FOLD_ENTRIES_PER_PASS),
};

/** Workers Paid under `cf-paid`: the tree's design target. */
export const PAID_HOST: HostProfile = {
  name: "Paid",
  ledger: PAID_LEDGER,
  collection: PAID_COLLECTION,
  entriesPerPass: MAINTENANCE_PROFILE_CF_PAID.maxFoldEntriesPerPass,
  foldParallelCalls: MAINTENANCE_PROFILE_CF_PAID.foldParallelCalls,
  gcSweeps: MAINTENANCE_PROFILE_CF_PAID.gcMaxSweeps,
  retirementDeletes: LOG_RETENTION_MAX_DELETES_PER_TICK,
  listPageKeys: GC_MARK_LIST_PAGE_KEYS,
  tailEntries: Math.max(
    WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
    MAINTENANCE_PROFILE_CF_PAID.maxFoldEntriesPerPass,
  ),
};

/** A charge on the ledger's pools. External is always 0 on the R2 binding. */
export interface PoolCharge {
  readonly internal: number;
  readonly external: 0;
}

export const poolCharge = (requests: number): PoolCharge => ({ internal: requests, external: 0 });

export interface Verdict {
  /** What the operation charges. */
  readonly charge: PoolCharge;
  /** What the ledger leaves the operation. */
  readonly budget: PoolCharge;
  readonly fits: boolean;
}

const verdict = (charge: PoolCharge, budget: PoolCharge): Verdict => ({
  charge,
  budget,
  fits: charge.internal <= budget.internal,
});

/**
 * A read against the ledger. A read holds no commit reserve (it commits
 * nothing), so its budget is the whole ledger, margin already taken.
 */
export const readVerdict = (calls: Calls, policy: RetryPolicy, ledger: Ledger): Verdict =>
  verdict(poolCharge(chargedRequests(calls, policy)), poolCharge(ledger.internal));

/**
 * What a tick may spend: on Workers the tick runs in the write's
 * `ctx.waitUntil`, in the same invocation, so its budget is the ledger less
 * the write route and the commit hold (the reserve stays intact).
 */
export const tickBudget = (write: Calls, policy: RetryPolicy, ledger: Ledger): number =>
  ledger.internal - chargedRequests(write, policy) - commitHoldRequests();

/** A tick against what the ledger leaves it ({@link tickBudget}). */
export const tickVerdict = (
  tick: Calls,
  write: Calls,
  policy: RetryPolicy,
  ledger: Ledger,
): Verdict =>
  verdict(poolCharge(chargedRequests(tick, policy)), poolCharge(tickBudget(write, policy, ledger)));

// ── Host sweep ───────────────────────────────────────────────────────────

/** One scenario: the parameters the sweep holds fixed. */
export interface Scenario {
  readonly host: HostProfile;
  readonly params: TreeParams;
  readonly sharing: PathSharing;
  readonly tailEntries: number;
  readonly tailHintLag: number;
  readonly concurrentCommits: number;
  readonly writeStateRead: "point" | "scan";
  readonly policy: RetryPolicy;
  readonly assumptions: DesignAssumptions;
}

const hostRead = (shape: TreeShape, s: Scenario): ReadInput => ({
  shape,
  tailEntries: s.tailEntries,
  emptyBase: false,
});

/** The write route (before its commit hold) on a collection of `shape`. */
export const hostWriteRoute = (shape: TreeShape, s: Scenario): Calls =>
  writeRouteCalls({
    read: hostRead(shape, s),
    writeStateRead: s.writeStateRead,
    tailHintLag: s.tailHintLag,
  });

/**
 * The fold tick changing `k` leaves of a collection at `shape`, in the
 * invocation of a write on the same collection. The pass folds
 * `max(k, entriesPerPass)` entries: `k` above the profile's pass means a
 * larger pass, which is how the sweep finds where it stops fitting.
 */
export const hostFoldTickVerdict = (shape: TreeShape, k: number, s: Scenario): Verdict => {
  const tick = foldTickCalls({
    shape,
    changedLeaves: k,
    sharing: s.sharing,
    entriesFolded: Math.max(k, s.host.entriesPerPass),
    emptyBase: false,
    concurrentCommits: s.concurrentCommits,
    headCasLost: true,
    assumptions: s.assumptions,
  });
  return tickVerdict(tick, hostWriteRoute(shape, s), s.policy, s.host.ledger);
};

/**
 * The worst fold tick the host's profile can dispatch: one full pass whose
 * every entry lands in a different leaf, `min(entriesPerPass, leaves)`.
 */
export const worstFoldTickVerdict = (shape: TreeShape, s: Scenario): Verdict =>
  hostFoldTickVerdict(shape, Math.min(s.host.entriesPerPass, shape.leaves), s);

export const hostGcTickVerdict = (shape: TreeShape, s: Scenario): Verdict =>
  tickVerdict(
    gcTickCalls({
      shape,
      sweeps: s.host.gcSweeps,
      retirementDeletes: s.host.retirementDeletes,
      listPageKeys: s.host.listPageKeys,
      state: GC_WORST_STATE,
      assumptions: s.assumptions,
    }),
    hostWriteRoute(shape, s),
    s.policy,
    s.host.ledger,
  );

/** A point read of a collection at `shape`, on `ledger` (default: the scenario host's). */
export const hostPointReadVerdict = (
  shape: TreeShape,
  s: Scenario,
  ledger: Ledger = s.host.ledger,
): Verdict => readVerdict(pointReadCalls(hostRead(shape, s)), s.policy, ledger);

/** A full scan of a collection at `shape`, on `ledger` (default: the scenario host's). */
export const hostScanVerdict = (
  shape: TreeShape,
  s: Scenario,
  ledger: Ledger = s.host.ledger,
): Verdict => readVerdict(scanCalls(hostRead(shape, s)), s.policy, ledger);

/**
 * The most changed leaves one fold tick can take at `shape` and stay in
 * budget, up to the tree's leaf count; 0 when not even one fits. The
 * charge is monotone in `k`, so the first miss ends the search.
 */
export const maxFittingChangedLeaves = (shape: TreeShape, s: Scenario): number => {
  let best = 0;
  for (let k = 1; k <= shape.leaves; k++) {
    if (!hostFoldTickVerdict(shape, k, s).fits) {
      break;
    }
    best = k;
  }
  return best;
};

export interface DepthSummary {
  readonly depth: number;
  /** `null` when the host's collection cannot take this depth under the params. */
  readonly shape: TreeShape | null;
  /** This is the depth the canonical tree of the host's collection has ({@link canonicalDepth}). */
  readonly canonical: boolean;
  readonly pointRead: Verdict | null;
  readonly scan: Verdict | null;
  readonly gcTick: Verdict | null;
  /** One changed leaf. */
  readonly foldTick1: Verdict | null;
  /** {@link worstFoldTickVerdict}. */
  readonly worstFoldTick: Verdict | null;
  /** Max changed leaves per fold tick that fit (0 = none fit). */
  readonly maxK: number;
  /**
   * Over budget at this depth: the worst fold tick, the GC tick or a read
   * does not fit.
   */
  readonly overBudget: boolean;
}

export const summarizeDepth = (depth: number, s: Scenario): DepthSummary => {
  const canonical = canonicalDepth(s.params, s.host.collection) === depth;
  const shape = collectionShape(depth, s.params, s.host.collection);
  if (shape === null) {
    return {
      depth,
      shape,
      canonical,
      pointRead: null,
      scan: null,
      gcTick: null,
      foldTick1: null,
      worstFoldTick: null,
      maxK: 0,
      overBudget: false,
    };
  }
  const pointRead = hostPointReadVerdict(shape, s);
  const scan = hostScanVerdict(shape, s);
  const gcTick = hostGcTickVerdict(shape, s);
  const foldTick1 = hostFoldTickVerdict(shape, 1, s);
  const worstFoldTick = worstFoldTickVerdict(shape, s);
  const maxK = maxFittingChangedLeaves(shape, s);
  return {
    depth,
    shape,
    canonical,
    pointRead,
    scan,
    gcTick,
    foldTick1,
    worstFoldTick,
    maxK,
    overBudget: !pointRead.fits || !scan.fits || !gcTick.fits || !worstFoldTick.fits,
  };
};
