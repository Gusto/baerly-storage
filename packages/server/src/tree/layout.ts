/**
 * Prototype tree layout: the frozen production constant and the one
 * internal seam that may override it.
 *
 * Nothing outside `packages/server/src/tree/` imports this directory:
 * no published entry, adapter, `_internal/*` subpath, or env parser
 * reaches it, so bundles are unchanged and no operator can set a
 * layout. `tests/unit/tree-isolation.test.ts` enforces that. Tests and
 * benches reach it by relative path.
 *
 * Every value is a format constant, not a host tuning knob. The
 * override seam exists so tests can sweep small layouts exhaustively;
 * collection, `Db` and app options never accept it.
 */

/** Leaf target size: 16 KiB. */
const LEAF_TARGET_BYTES = 16 * 1024;

/** No content cut while a leaf holds at most this many document bytes. */
const LEAF_MIN_BYTES = 8 * 1024;

/**
 * Size and shape constants of the prototype prolly tree. Frozen: a
 * collection's canonical tree is a function of its row set and these
 * values only. All byte counts are canonical document bytes unless a
 * field says otherwise. The literals are local to this module; they are
 * not part of any published format.
 */
export interface TreeLayout {
  /** Mean leaf document bytes. */
  readonly leafTargetBytes: number;
  /** No content cut while a leaf's document bytes are at most this. */
  readonly leafMinBytes: number;
  /**
   * Forced cut after the entry that makes the leaf reach this many
   * document bytes. The one-maximal-row requirement bounds
   * {@link TreeLayout.leafMaxBodyBytes}, not this field.
   */
  readonly leafMaxBytes: number;
  /** Decoder bound on a stored leaf body, in node bytes (envelope included). */
  readonly leafMaxBodyBytes: number;
  /**
   * A document of at least this many bytes gets a cut before and after
   * it, so it sits alone in its leaf.
   */
  readonly leafIsolationDocumentBytes: number;
  /** No hash cut before a branch node has this many entries. */
  readonly branchFanoutMin: number;
  /** Mean hash-cut interval, in entries, once the minimum is met. */
  readonly branchFanoutTarget: number;
  /** Forced cut at this many entries. */
  readonly branchFanoutMax: number;
  /**
   * Single-leaf rule, bytes: a row set whose canonical document bytes are
   * at most this (inclusive) and whose rows are within
   * {@link TreeLayout.singleLeafMaxRows} is one root leaf with no
   * content-defined cuts. A shape constant, not a capacity limit: it is the
   * smallest value that keeps today's Free envelope at one node, and it
   * does not track the Free fold ceiling if that ceiling later changes.
   * Counted in document bytes, not node bytes.
   */
  readonly singleLeafMaxBytes: number;
  /** Single-leaf rule, rows (inclusive). Same status as {@link TreeLayout.singleLeafMaxBytes}. */
  readonly singleLeafMaxRows: number;
}

/** The production layout. */
export const TREE_LAYOUT: TreeLayout = Object.freeze({
  leafTargetBytes: LEAF_TARGET_BYTES,
  leafMinBytes: LEAF_MIN_BYTES,
  leafMaxBytes: 2 * LEAF_TARGET_BYTES - LEAF_MIN_BYTES,
  leafMaxBodyBytes: 2 * 1024 * 1024,
  leafIsolationDocumentBytes: 24 * 1024,
  branchFanoutMin: 4,
  branchFanoutTarget: 32,
  branchFanoutMax: 128,
  singleLeafMaxBytes: 512 * 1024,
  singleLeafMaxRows: 2048,
});

/**
 * Injection points for test mutants. Add one optional
 * member per replaceable step (publish order, reuse set, planner, ...).
 * Empty today: no step is replaceable yet.
 */
export type TreeSteps = Readonly<Record<never, never>>;

/**
 * Constructor options of the prototype tree, internal only. These are
 * the only places a layout or a step override is accepted; they must
 * never be threaded into collection, `Db`, app or env configuration.
 */
export interface TreeConstructorOptions {
  /** Test-only layout override, for small-scope sweeps. */
  readonly layout?: TreeLayout;
  /** Test-only step overrides, for injecting mutants. */
  readonly steps?: Partial<TreeSteps>;
}

/** The layout in force for one tree: the override if given, else {@link TREE_LAYOUT}. */
export const resolveTreeLayout = (options?: TreeConstructorOptions): TreeLayout =>
  options?.layout ?? TREE_LAYOUT;
