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

import {
  MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  MAINTENANCE_MAX_FOLD_ROWS,
  MAX_DOCUMENT_BYTES,
} from "@baerly/protocol";

/**
 * Bytes a leaf may carry beyond one maximal row: the leaf header plus
 * one entry's framing and `_id` key (at most `MAX_KEY_BYTES`, 1,024).
 * Local to this module because a `@baerly/protocol` constant would
 * change protocol chunk sizes and the published bundles. It is not
 * part of any published format.
 */
const LEAF_ENVELOPE_HEADROOM_BYTES = 4096;

/** Leaf target size: 16 KiB (see {@link TreeLayout.leafTargetBytes}). */
const LEAF_TARGET_BYTES = 16 * 1024;

/**
 * Size and shape constants of the prototype prolly tree. Frozen: a
 * collection's canonical tree is a function of its row set and these
 * values only.
 */
export interface TreeLayout {
  /** Byte size at which the leaf boundary threshold reaches 1. */
  readonly leafTargetBytes: number;
  /** Least leaf fill the op model assumes: 0.5 of the target. */
  readonly leafMinBytes: number;
  /**
   * Forced cut after the entry that crosses it. At least one
   * `MAX_DOCUMENT_BYTES` row plus envelope, so one maximal row always
   * fits one leaf.
   */
  readonly leafMaxBytes: number;
  /** Target entries per internal node (at least 32). */
  readonly internalFanoutTarget: number;
  /**
   * Depth-0 limit `T`, bytes: a collection within `T` is one leaf. Starts
   * equal to today's snapshot ceiling `C` (Free profile) so Free's write
   * envelope is unchanged.
   */
  readonly depth0MaxBytes: number;
  /** Depth-0 limit `T`, rows. Starts equal to today's Free ceiling `E`. */
  readonly depth0MaxRows: number;
}

/** The production layout. */
export const TREE_LAYOUT: TreeLayout = Object.freeze({
  leafTargetBytes: LEAF_TARGET_BYTES,
  leafMinBytes: LEAF_TARGET_BYTES / 2,
  leafMaxBytes: MAX_DOCUMENT_BYTES + LEAF_ENVELOPE_HEADROOM_BYTES,
  internalFanoutTarget: 32,
  depth0MaxBytes: MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  depth0MaxRows: MAINTENANCE_MAX_FOLD_ROWS,
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
