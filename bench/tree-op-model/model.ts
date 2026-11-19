/**
 * Static storage-call model for a content-addressed tree layout: the
 * worst-case storage calls of one maintenance tick, a point read and a
 * full scan, against the Workers Free + R2 binding request ledger.
 *
 * Pure and I/O-free. It answers "does this tree shape fit the floor's
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
 * Every assumption this model does not fix is a named field of
 * {@link DesignAssumptions}, never a hidden constant.
 */

import {
  CF_FREE_EXTERNAL_REQUEST_LIMIT,
  CF_FREE_INTERNAL_REQUEST_LIMIT,
  COMMIT_RESOLUTION_RESERVE,
  GC_MARK_LIST_PAGE_KEYS,
  LOG_RETENTION_MAX_DELETES_PER_TICK,
  MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  MAINTENANCE_MAX_FOLD_ROWS,
  STORAGE_RETRY_MAX_ATTEMPTS,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_GC_MAX_SWEEPS,
} from "@baerly/protocol";

// ── Call tallies ─────────────────────────────────────────────────────────

/**
 * Logical storage calls by retry class. `creates` are create-only PUTs
 * (`If-None-Match: "*"`), which the adapter retries; `casPuts` are
 * `If-Match` PUTs, which it sends once (a resend after a lost ack would meet
 * its own write as a 412: `STORAGE_RETRY_MAX_ATTEMPTS` JSDoc);
 * `unretriedGets` are GETs issued by a non-retrying helper (the write tick's
 * best-effort `tail_hint` refresh).
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

// ── Floor collection ─────────────────────────────────────────────────────

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
 * UNSPECIFIED BY THIS MODEL: leaf sizing. Leaves have content-defined
 * boundaries and nodes are wide, but this model fixes no leaf target or
 * minimum fill.
 */
export interface LeafSizing {
  /** CDC target leaf size in bytes. */
  readonly leafTargetBytes: number;
  /**
   * Worst-case fill of a leaf as a fraction of the target (a CDC chunker's
   * minimum cut over its target). The worst case for request counts is the
   * least-filled tree: most leaves.
   */
  readonly leafMinFill: number;
  /**
   * Most children an internal node can name (its byte target over a child
   * descriptor's size). `Infinity` means unconstrained, so any depth can
   * hold the collection.
   */
  readonly maxFanout: number;
}

/**
 * The worst-case shape of `size` as a depth-`depth` tree: as many leaves as
 * minimum fill allows (at most one per row), and the least fanout that
 * still reaches that depth. `null` when the collection cannot take that
 * depth: one leaf at depth >= 1, or more leaves than `maxFanout ** depth`.
 * Depth 0 is always one leaf, today's snapshot.
 */
export const collectionShape = (
  depth: number,
  sizing: LeafSizing,
  size: CollectionSize = FLOOR_COLLECTION,
): TreeShape | null => {
  if (depth === 0) {
    return { depth: 0, fanout: 1, leaves: 1 };
  }
  const leaves = Math.min(
    size.rows,
    Math.ceil(size.bytes / (sizing.leafTargetBytes * sizing.leafMinFill)),
  );
  if (leaves < 2) {
    return null;
  }
  let fanout = 2;
  while (fanout ** depth < leaves) {
    fanout++;
  }
  // A depth-d tree with fanout F needs more than F^(d-1) leaves, or it is
  // really a shallower tree.
  if (fanout > sizing.maxFanout || fanout ** (depth - 1) >= leaves) {
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
   * Worst case for the head CAS: it is lost, so the tick also pays the
   * closing best-effort `tail_hint` refresh (one non-retrying GET + CAS PUT,
   * `MAINTENANCE_TAIL_HINT_REFRESH_REQUESTS`).
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
 * One write-tick fold, as main's single-phase tick runs it
 * (`runBoundedMaintenance` Step 3 + `compact()`), with the snapshot GET/PUT
 * replaced by path and leaf calls:
 *
 * - runner `current.json` GET (1);
 * - `compact()`'s `current.json` GET (1);
 * - tail probe at the writer's observed tail (1 + concurrent commits);
 * - one GET per folded log entry;
 * - internal node GETs on the union of changed paths, and the touched leaves;
 * - node creates: every touched leaf and every union node, plus splits;
 * - the head CAS (1), and on a lost CAS the closing `tail_hint` refresh.
 *
 * At depth 0 with one leaf that is `MAINTENANCE_FOLD_BASE_REQUESTS + 1 + e`
 * (26 at e = 20), the `tick:fold` cells of `request-counts.json`.
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
    { creates: rewritten + splits, casPuts: 1 },
    input.headCasLost ? { unretriedGets: 1, casPuts: 1 } : {},
  );
};

export interface GcTickInput {
  readonly shape: TreeShape;
  /** Delete cap per tick. Main's `cf-free` slice: `WRITE_TICK_GC_MAX_SWEEPS`. */
  readonly sweeps: number;
  /** Log objects the retirement pass may delete. Main: `LOG_RETENTION_MAX_DELETES_PER_TICK`. */
  readonly retirementDeletes: number;
  /** Keys per LIST page. S3 and R2 return up to `GC_MARK_LIST_PAGE_KEYS` (1,000). */
  readonly listPageKeys: number;
  readonly assumptions: DesignAssumptions;
}

/**
 * Pending-ledger contention the GC slice can add: the bootstrap race plus
 * two more `gc/pending.json` CAS attempts ("Contention adds at most 6",
 * `MAINTENANCE_GC_BASE_REQUESTS` JSDoc). Charged here as retried GETs,
 * which over-counts the CAS PUT share: conservative.
 */
const GC_CONTENTION_EXTRA_CALLS = 6;

/**
 * One hard-GC write tick (`runBoundedMaintenance` Step 2: GC slice, then
 * log retirement; never in the same tick as a fold), with the snapshot
 * LIST replaced by a LIST of the node namespace and a membership walk.
 *
 * - GC slice common path (`MAINTENANCE_GC_BASE_REQUESTS`, 6): `current.json`
 *   GET, `gc/pending.json` GET, the LIST (here: every listed node, paged),
 *   the fresh `current.json` GET before a due sweep, pending CAS GET + PUT;
 *   contention; membership GETs; one DELETE per sweep.
 * - Retirement (`MAINTENANCE_RETIRE_PRE_FLOOR_REQUESTS`, 7 at all attempts):
 *   advisory `current.json` GET and the floor CAS's GET + PUT, then one
 *   DELETE per retired log object.
 *
 * Not anchored to `request-counts.json`: the grid's GC cells measure a
 * nearly empty pending ledger, not the worst case. `model.test.ts` checks
 * the composition against the two constants instead.
 */
export const gcTickCalls = (input: GcTickInput): Calls => {
  const { shape, assumptions } = input;
  const liveNodes = internalNodeCount(shape) + shape.leaves;
  const listed = Math.ceil(liveNodes * assumptions.gcListedObjectsPerLiveNode);
  const listPages = Math.max(1, Math.ceil(listed / input.listPageKeys));
  const membership =
    assumptions.gcMembershipGets === "internal-nodes"
      ? internalNodeCount(shape)
      : assumptions.gcMembershipGets;
  return sumCalls(
    { gets: 4, casPuts: 1, listPages },
    { gets: GC_CONTENTION_EXTRA_CALLS + membership, deletes: input.sweeps },
    { gets: 2, casPuts: 1, deletes: input.retirementDeletes },
  );
};

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

// ── Ledger ───────────────────────────────────────────────────────────────

/** How the host reaches storage, which decides the pools charged. */
export type Transport = "r2-binding" | "fetch";

/**
 * The Workers Free ledger. `internal` is 900: the documented 1,000
 * internal subrequests less the 10% margin (`CF_FREE_INTERNAL_REQUEST_LIMIT`);
 * `external` is 45: 50 less 5 (`CF_FREE_EXTERNAL_REQUEST_LIMIT`). Every
 * storage call charges `internal`; a call over `fetch` also charges
 * `external`. The R2 binding charges no external call, and the Worker makes
 * no Cache API call.
 */
export interface Ledger {
  readonly internal: number;
  readonly external: number;
}

export const FREE_LEDGER: Ledger = {
  internal: CF_FREE_INTERNAL_REQUEST_LIMIT,
  external: CF_FREE_EXTERNAL_REQUEST_LIMIT,
};

export interface PoolCharge {
  readonly internal: number;
  readonly external: number;
}

export const poolCharge = (requests: number, transport: Transport): PoolCharge => ({
  internal: requests,
  external: transport === "fetch" ? requests : 0,
});

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
  fits: charge.internal <= budget.internal && charge.external <= budget.external,
});

/**
 * A read against the ledger. A read holds no commit reserve (it commits
 * nothing), so its budget is the whole ledger, margin already taken.
 */
export const readVerdict = (
  calls: Calls,
  policy: RetryPolicy,
  transport: Transport = "r2-binding",
  ledger: Ledger = FREE_LEDGER,
): Verdict => verdict(poolCharge(chargedRequests(calls, policy), transport), ledger);

/**
 * A tick against the ledger. On Workers the tick runs in the write's
 * `ctx.waitUntil`, in the same invocation, so its budget is the ledger
 * less the write route and the commit hold (the reserve stays intact).
 */
export const tickVerdict = (
  tick: Calls,
  write: Calls,
  policy: RetryPolicy,
  transport: Transport = "r2-binding",
  ledger: Ledger = FREE_LEDGER,
): Verdict => {
  const writeCharge = poolCharge(chargedRequests(write, policy) + commitHoldRequests(), transport);
  return verdict(poolCharge(chargedRequests(tick, policy), transport), {
    internal: ledger.internal - writeCharge.internal,
    external: ledger.external - writeCharge.external,
  });
};

// ── Floor sweep ──────────────────────────────────────────────────────────

/** One scenario: the parameters the sweep holds fixed. */
export interface Scenario {
  readonly sizing: LeafSizing;
  readonly sharing: PathSharing;
  readonly tailEntries: number;
  readonly tailHintLag: number;
  readonly concurrentCommits: number;
  readonly writeStateRead: "point" | "scan";
  readonly policy: RetryPolicy;
  readonly transport: Transport;
  readonly assumptions: DesignAssumptions;
}

/** `cf-free` defaults for a scenario's fold pass and GC slice. */
export const FLOOR_PROFILE = {
  entriesPerPass: WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  gcSweeps: WRITE_TICK_GC_MAX_SWEEPS,
  retirementDeletes: LOG_RETENTION_MAX_DELETES_PER_TICK,
  listPageKeys: GC_MARK_LIST_PAGE_KEYS,
} as const;

/**
 * The fold tick changing `k` leaves of the floor collection at `shape`.
 * The pass folds `max(k, entriesPerPass)` entries: `k` above the profile's
 * pass means a larger pass, which is how the sweep finds where it stops
 * fitting.
 */
export const floorFoldTickVerdict = (shape: TreeShape, k: number, s: Scenario): Verdict => {
  const tick = foldTickCalls({
    shape,
    changedLeaves: k,
    sharing: s.sharing,
    entriesFolded: Math.max(k, FLOOR_PROFILE.entriesPerPass),
    emptyBase: false,
    concurrentCommits: s.concurrentCommits,
    headCasLost: true,
    assumptions: s.assumptions,
  });
  return tickVerdict(tick, floorWriteRoute(shape, s), s.policy, s.transport);
};

const floorRead = (shape: TreeShape, s: Scenario): ReadInput => ({
  shape,
  tailEntries: s.tailEntries,
  emptyBase: false,
});

export const floorWriteRoute = (shape: TreeShape, s: Scenario): Calls =>
  writeRouteCalls({
    read: floorRead(shape, s),
    writeStateRead: s.writeStateRead,
    tailHintLag: s.tailHintLag,
  });

export const floorGcTickVerdict = (shape: TreeShape, s: Scenario): Verdict =>
  tickVerdict(
    gcTickCalls({
      shape,
      sweeps: FLOOR_PROFILE.gcSweeps,
      retirementDeletes: FLOOR_PROFILE.retirementDeletes,
      listPageKeys: FLOOR_PROFILE.listPageKeys,
      assumptions: s.assumptions,
    }),
    floorWriteRoute(shape, s),
    s.policy,
    s.transport,
  );

export const floorPointReadVerdict = (shape: TreeShape, s: Scenario): Verdict =>
  readVerdict(pointReadCalls(floorRead(shape, s)), s.policy, s.transport);

export const floorScanVerdict = (shape: TreeShape, s: Scenario): Verdict =>
  readVerdict(scanCalls(floorRead(shape, s)), s.policy, s.transport);

/**
 * The most changed leaves one fold tick can take at `shape` and stay in
 * budget, up to the tree's leaf count; 0 when not even one fits. The
 * charge is monotone in `k`, so the first miss ends the search.
 */
export const maxFittingChangedLeaves = (shape: TreeShape, s: Scenario): number => {
  let best = 0;
  for (let k = 1; k <= shape.leaves; k++) {
    if (!floorFoldTickVerdict(shape, k, s).fits) {
      break;
    }
    best = k;
  }
  return best;
};

export interface DepthSummary {
  readonly depth: number;
  /** `null` when the floor collection cannot take this depth under the sizing. */
  readonly shape: TreeShape | null;
  readonly pointRead: Verdict | null;
  readonly scan: Verdict | null;
  readonly gcTick: Verdict | null;
  /** Max changed leaves per fold tick that fit (0 = none fit). */
  readonly maxK: number;
  /**
   * A required tick (one changed leaf, or the GC tick) or read does not fit
   * at this depth.
   */
  readonly overBudget: boolean;
}

export const summarizeDepth = (depth: number, s: Scenario): DepthSummary => {
  const shape = collectionShape(depth, s.sizing);
  if (shape === null) {
    return { depth, shape, pointRead: null, scan: null, gcTick: null, maxK: 0, overBudget: false };
  }
  const pointRead = floorPointReadVerdict(shape, s);
  const scan = floorScanVerdict(shape, s);
  const gcTick = floorGcTickVerdict(shape, s);
  const maxK = maxFittingChangedLeaves(shape, s);
  return {
    depth,
    shape,
    pointRead,
    scan,
    gcTick,
    maxK,
    overBudget: !pointRead.fits || !scan.fits || !gcTick.fits || maxK === 0,
  };
};
