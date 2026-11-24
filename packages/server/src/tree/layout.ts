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
 * collection, `Db` and app options never accept it. Decoder bounds such
 * as the leaf body ceiling live in `./constants.ts`, outside the layout,
 * so no override can widen what a reader accepts.
 */
import { BaerlyError } from "@baerly/protocol";
import type { ChunkKey } from "./chunk.ts";
import type { TreeGcClassification } from "./gc.ts";
import type { TreeGcMembership, TreeGcRootView } from "./gc-member.ts";
import type { TreeGcState } from "./gc-state.ts";
import type { TreeHead } from "./head.ts";
import type { TreeNodeKeyParts } from "./key.ts";
import type { DecodedTreeNode, TreeChildEntry } from "./node-codec.ts";
import type { LiveTreeRef, TreePublicationWrite } from "./publish.ts";
import type { FoldRecordBase } from "./record.ts";
import type { TreeRange, TreeTail, TreeTailRead } from "./read.ts";

/** Leaf target size: 16 KiB. */
const LEAF_TARGET_BYTES = 16 * 1024;

/** No content cut while a leaf holds at most this many document bytes. */
const LEAF_MIN_BYTES = 8 * 1024;

/**
 * Size and shape constants of the prototype prolly tree. Frozen: a
 * collection's canonical tree is a function of its row set and these
 * values only. All byte counts are canonical document bytes. The
 * literals are local to this module; they are not part of any published
 * format.
 */
export interface TreeLayout {
  /** Mean leaf document bytes. */
  readonly leafTargetBytes: number;
  /** No content cut while a leaf's document bytes are at most this. */
  readonly leafMinBytes: number;
  /**
   * Forced cut after the entry that makes the leaf reach this many
   * document bytes. Always `2 × leafTargetBytes − leafMinBytes`, which
   * makes the cut size uniform on `(leafMinBytes, leafMaxBytes]`. The
   * one-maximal-row requirement bounds the decoder's leaf body ceiling,
   * not this field.
   */
  readonly leafMaxBytes: number;
  /**
   * A document of at least this many bytes gets a cut before and after
   * it, so it sits alone in its leaf.
   */
  readonly leafIsolationDocumentBytes: number;
  /** No hash cut before a branch node has this many entries. */
  readonly branchFanoutMin: number;
  /** Mean hash-cut interval, in entries, once the minimum is met. */
  readonly branchFanoutTarget: number;
  /** Forced cut at this many entries. A level with at most this many entries is one node. */
  readonly branchFanoutMax: number;
  /**
   * Single-leaf rule, bytes: a row set whose canonical document bytes are
   * at most this (inclusive) and whose rows are within
   * {@link TreeLayout.singleLeafMaxRows} is one root leaf with no
   * content-defined cuts. A shape constant, not a capacity limit: it is the
   * smallest value that keeps today's Free envelope at one node, and it
   * does not track the Free fold ceiling if that ceiling later changes.
   * Counted in document bytes, not node bytes. 0 disables the rule.
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
  leafIsolationDocumentBytes: 24 * 1024,
  branchFanoutMin: 4,
  branchFanoutTarget: 32,
  branchFanoutMax: 128,
  singleLeafMaxBytes: 512 * 1024,
  singleLeafMaxRows: 2048,
});

/** The fields a layout carries. */
const LAYOUT_FIELDS: readonly (keyof TreeLayout)[] = Object.freeze([
  "leafTargetBytes",
  "leafMinBytes",
  "leafMaxBytes",
  "leafIsolationDocumentBytes",
  "branchFanoutMin",
  "branchFanoutTarget",
  "branchFanoutMax",
  "singleLeafMaxBytes",
  "singleLeafMaxRows",
]);

/**
 * Upper bound on `leafMaxBytes`. It keeps every non-isolated leaf below
 * `2 × leafMaxBytes ≤ 1 MiB` of document bytes, and keeps
 * `leafMaxBytes − leafMinBytes ≤ 2^20`, so every product in the leaf cut
 * predicate (a 32-bit hash times a byte span) stays below 2^52 and is
 * exact in a double.
 */
const LEAF_MAX_BYTES_CEILING = 524_288;

/** Largest `branchFanoutTarget`: a hash-cut probability of 2^-16 per entry. */
const BRANCH_FANOUT_TARGET_CEILING = 65_536;

/** Largest `branchFanoutMax`; matches the decoder's per-branch entry ceiling. */
const BRANCH_FANOUT_MAX_CEILING = 256;

/** Largest `singleLeafMaxBytes`: one root leaf never holds more than 1 MiB of documents. */
const SINGLE_LEAF_MAX_BYTES_CEILING = 1_048_576;

/** Largest `singleLeafMaxRows`. */
const SINGLE_LEAF_MAX_ROWS_CEILING = 65_536;

/**
 * One layout validation rule. A layout is valid when every rule holds;
 * the first that fails is reported. Rules are data so a test mutant can
 * drop one through the `steps` seam and show the suite notices.
 */
export interface TreeLayoutRule {
  /** Stable rule name, used in the error message and by mutants. */
  readonly name: string;
  /** The rule, stated for the error message. */
  readonly statement: string;
  readonly holds: (layout: TreeLayout) => boolean;
}

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

/** Every rule a `TreeLayout` must satisfy, in check order. */
export const TREE_LAYOUT_RULES: readonly TreeLayoutRule[] = Object.freeze([
  {
    // Rejects a stray field, so nothing outside the layout (a decoder
    // bound, say) can ride in on an override.
    // Every own key counts (Reflect.ownKeys), so a non-enumerable or
    // symbol-keyed extra is refused too, and each field must be an
    // enumerable data property, so no getter is ever read.
    name: "fields",
    statement: `the layout has exactly the fields ${LAYOUT_FIELDS.join(", ")}, as enumerable data properties`,
    holds: (layout: TreeLayout) =>
      Reflect.ownKeys(layout).length === LAYOUT_FIELDS.length &&
      LAYOUT_FIELDS.every((f) => {
        const descriptor = Object.getOwnPropertyDescriptor(layout, f);
        return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor;
      }),
  },
  {
    name: "safe-integers",
    statement: "every field is a safe integer",
    holds: (layout: TreeLayout) => LAYOUT_FIELDS.every((f) => Number.isSafeInteger(layout[f])),
  },
  {
    name: "leaf-min-below-target",
    statement: "1 ≤ leafMinBytes < leafTargetBytes",
    holds: (l: TreeLayout) => l.leafMinBytes >= 1 && l.leafMinBytes < l.leafTargetBytes,
  },
  {
    name: "leaf-max-derived",
    statement: "leafMaxBytes = 2 × leafTargetBytes − leafMinBytes",
    holds: (l: TreeLayout) => l.leafMaxBytes === 2 * l.leafTargetBytes - l.leafMinBytes,
  },
  {
    name: "leaf-max-ceiling",
    statement: `leafMaxBytes ≤ ${LEAF_MAX_BYTES_CEILING}`,
    holds: (l: TreeLayout) => l.leafMaxBytes <= LEAF_MAX_BYTES_CEILING,
  },
  {
    // A short leaf cut before an isolated document pairs with it to hold
    // at least 2 × (leafMinBytes + 1) document bytes. That is what keeps
    // the leaf count of a collection at most
    // ⌊bytes / (leafMinBytes + 1)⌋ + 1, which the scan bound relies on.
    // Without it, leafMinBytes 16 and leafIsolationDocumentBytes 20 give
    // 20 leaves over 310 bytes (alternating 11- and 20-byte documents)
    // against a bound of 19.
    name: "isolation-lower-bound",
    statement: "2 × (leafMinBytes + 1) ≤ leafIsolationDocumentBytes",
    holds: (l: TreeLayout) => 2 * (l.leafMinBytes + 1) <= l.leafIsolationDocumentBytes,
  },
  {
    name: "isolation-upper-bound",
    statement: "leafIsolationDocumentBytes ≤ leafMaxBytes",
    holds: (l: TreeLayout) => l.leafIsolationDocumentBytes <= l.leafMaxBytes,
  },
  {
    name: "fanout-target-power-of-two",
    statement: `branchFanoutTarget is a power of two in [2, ${BRANCH_FANOUT_TARGET_CEILING}]`,
    holds: (l: TreeLayout) =>
      l.branchFanoutTarget >= 2 &&
      l.branchFanoutTarget <= BRANCH_FANOUT_TARGET_CEILING &&
      isPowerOfTwo(l.branchFanoutTarget),
  },
  {
    // branchFanoutMin ≥ 2 makes every branch level strictly smaller than
    // the level below it, so the build terminates.
    name: "fanout-min-max",
    statement: `2 ≤ branchFanoutMin ≤ branchFanoutMax ≤ ${BRANCH_FANOUT_MAX_CEILING}`,
    holds: (l: TreeLayout) =>
      l.branchFanoutMin >= 2 &&
      l.branchFanoutMin <= l.branchFanoutMax &&
      l.branchFanoutMax <= BRANCH_FANOUT_MAX_CEILING,
  },
  {
    name: "single-leaf-bytes-range",
    statement: `0 ≤ singleLeafMaxBytes ≤ ${SINGLE_LEAF_MAX_BYTES_CEILING}`,
    holds: (l: TreeLayout) =>
      l.singleLeafMaxBytes >= 0 && l.singleLeafMaxBytes <= SINGLE_LEAF_MAX_BYTES_CEILING,
  },
  {
    name: "single-leaf-rows-range",
    statement: `0 ≤ singleLeafMaxRows ≤ ${SINGLE_LEAF_MAX_ROWS_CEILING}`,
    holds: (l: TreeLayout) =>
      l.singleLeafMaxRows >= 0 && l.singleLeafMaxRows <= SINGLE_LEAF_MAX_ROWS_CEILING,
  },
]);

/**
 * Injection points for test mutants: one member per replaceable step.
 * Tree code reads each step from a {@link TreeConfig}, so a mutant passed
 * to {@link createTreeConfig} reaches every caller of that config.
 *
 * The optional members are the canonical builder's, fold planner's,
 * publisher's and reader's steps. When one is absent, the module that
 * runs it uses its own built-in step, which keeps this module free of a
 * runtime import of those modules.
 */
export interface TreeSteps {
  /** The rules a layout must satisfy. */
  readonly layoutRules: readonly TreeLayoutRule[];
  /**
   * The strict decoder's canonical-bytes check: the stored body must
   * equal the canonical re-encoding of what it parsed to, byte for byte.
   */
  readonly canonicalBytesMatch: (stored: Uint8Array, reencoded: Uint8Array) => boolean;
  /**
   * Whether a leaf is cut after the entry that took its document bytes
   * from `before` to `after`, given that entry's level-0 chunk hash.
   */
  readonly leafCut?: (before: number, after: number, hash: number, layout: TreeLayout) => boolean;
  /** The chunk hash `h(level, id)` under a collection's chunk key. */
  readonly chunkHash?: (key: ChunkKey, level: number, id: string) => Promise<number>;
  /** The order of `_id`s: `utf8-scalar-v1`. */
  readonly orderIds?: (a: string, b: string) => number;
  /** Whether a document of `bytes` document bytes is isolated in its own leaf. */
  readonly isolates?: (bytes: number, layout: TreeLayout) => boolean;
  /**
   * Whether a branch node is cut after its `count`-th entry, given the
   * chunk hash of that entry's `hi` at the level being chunked.
   */
  readonly branchCut?: (count: number, hash: number, layout: TreeLayout) => boolean;
  /** The depth-0 rule: whether a row set with these totals is one root leaf. */
  readonly singleLeaf?: (rows: number, bytes: number, layout: TreeLayout) => boolean;
  /**
   * Whether the fold planner may accept a plan whose fold record would
   * list `keys` keys, fresh and superseded together.
   */
  readonly recordKeysFit?: (keys: number) => boolean;
  /** The fold planner's ordering of its mutations by `_id`, in `utf8-scalar-v1` order. */
  readonly sortMutations?: <M extends { readonly id: string }>(mutations: readonly M[]) => M[];
  /**
   * Whether a change at or just before the first entry of the old leaf
   * with these totals also re-chunks the old leaf before it: true when
   * that earlier leaf's cut may have read the first entry's size.
   */
  readonly leafRestartsBefore?: (
    leaf: { readonly rows: number; readonly bytes: number },
    layout: TreeLayout,
  ) => boolean;
  /**
   * Whether the fold planner stops re-chunking at an old node boundary
   * past every pending change, given whether its chunker is empty there.
   * Stopping with a non-empty chunker closes the partial chunk.
   */
  readonly resyncStops?: (chunkerEmpty: boolean) => boolean;
  /** The attempt identity a publication mints: 128 fresh random bits as hex. */
  readonly mintAttempt?: () => string;
  /**
   * The order a publication issues its writes in, given the writes in
   * their required order: the fold record, each level of fresh nodes
   * from the leaves up, then the head CAS.
   */
  readonly publicationOrder?: (
    writes: readonly TreePublicationWrite[],
  ) => readonly TreePublicationWrite[];
  /**
   * Whether a publication may reuse the ref `entry` in a slot at
   * `level`, given every ref proven live under the captured root (keyed
   * `<attempt>/<sha256>`, with the level of the node each names): it
   * must be one of them, at that level, with the same summary.
   */
  readonly reuseIsLive?: (
    entry: TreeChildEntry,
    level: number,
    live: ReadonlyMap<string, LiveTreeRef>,
  ) => boolean;
  /**
   * Whether a publication adopts the body it found at a node key whose
   * create conflicted: only when it equals the body it created, byte
   * for byte.
   */
  readonly adoptionBytesMatch?: (stored: Uint8Array, created: Uint8Array) => boolean;
  /**
   * The nodes a fold record lists as superseded, as `<attempt>/<sha256>`,
   * given the captured root, every node the plan read and the new
   * tree's reused refs: every captured node the new tree does not reach.
   */
  readonly recordSuperseded?: (
    root: DecodedTreeNode | null,
    read: readonly DecodedTreeNode[],
    reused: readonly TreeChildEntry[],
  ) => readonly string[];
  /** The base a fold record names for an attempt that captured `head`. */
  readonly recordBase?: (head: TreeHead) => FoldRecordBase;
  /** GC's reachability check of node key `x` against the view's root; see `gc-member.ts`. */
  readonly gcIsMember?: (x: string, view: TreeGcRootView) => Promise<TreeGcMembership>;
  /** Whether GC reads a candidate whose body failed its decode once more before calling it corrupt. */
  readonly gcRetriesCorrupt?: () => boolean;
  /**
   * Whether GC deletes a corrupt candidate, given its role and whether
   * the key-only guard holds (its attempt is neither the head's
   * installer nor that of any child ref of the root).
   */
  readonly gcOnCorrupt?: (role: "loser" | "superseded" | "sweep", guardHolds: boolean) => boolean;
  /** The parts of a key the leak sweep listed, or `null` when it is not a node key. */
  readonly gcParsesKey?: (prefix: string, key: string) => TreeNodeKeyParts | null;
  /**
   * The winner and losers among the attempts recorded at one closed
   * floor, given the attempts the tick's evidence names and the attempts
   * that appear in more than one listed record.
   */
  readonly gcClassify?: (
    members: readonly string[],
    evidence: ReadonlySet<string>,
    duplicates: ReadonlySet<string>,
  ) => TreeGcClassification;
  /** Whether the records at `floor` are closed under a head at `headFloor`. */
  readonly gcIsClosed?: (floor: number, headFloor: number) => boolean;
  /** Whether an item due at `dueAt` (server time) is due at server time `now`. */
  readonly gcIsDue?: (dueAt: string | null, now: Date | undefined) => boolean;
  /** The server time a probe reads, from the probe write's `serverDate` and the local clock. */
  readonly gcNow?: (serverDate: Date | undefined, local: Date) => Date | undefined;
  /** Whether the GC state as read still belongs to the history of `head`. */
  readonly gcBindsHead?: (state: TreeGcState, head: TreeHead) => boolean;
  /** The leak sweep's membership check, by phase. */
  readonly sweepIsMember?: (
    x: string,
    view: TreeGcRootView,
    phase: "note" | "stamp" | "delete",
  ) => Promise<TreeGcMembership>;
  /** Whether a mark noted under a head at `markFloor` may be stamped under a head at `headFloor`. */
  readonly sweepPassesFloorGate?: (markFloor: number, headFloor: number) => boolean;
  /** Whether the sweep starts a mark's age in `phase`. */
  readonly sweepStartsAge?: (phase: "note" | "stamp") => boolean;
  /** Whether a probe tick lists its sweep page before it reads the head. */
  readonly sweepListsBeforeHead?: () => boolean;
  /**
   * The reader's tail step: walk and probe the unfolded log tail of the
   * head it is given, and fold it into a per-`_id` overlay.
   */
  readonly readTail?: (read: TreeTailRead) => Promise<TreeTail>;
  /** The entries of a branch a read descends into for `range`. */
  readonly selectChildren?: (
    children: readonly TreeChildEntry[],
    range: TreeRange,
  ) => readonly TreeChildEntry[];
  /**
   * Whether a complete scan whose base needs `charged` storage calls,
   * every attempt counted, is admitted when the request has `left`.
   */
  readonly admitsScan?: (charged: number, left: number) => boolean;
  /** Whether a read GETs a node it found missing once more before it re-reads the head. */
  readonly regetsMissingNode?: () => boolean;
  /**
   * Whether one GET a missing node calls for (its re-GET or the head
   * re-read), charged `charged` storage calls for every attempt, is
   * admitted when the request has `left`.
   */
  readonly admitsMissingNodeCall?: (charged: number, left: number) => boolean;
  /**
   * What a read does about a node still missing after its re-GET, given
   * whether the head's root has moved off the root that routed to it and
   * whether the view has already restarted once.
   */
  readonly missingNodeAction?: (seen: MissingNodeSeen) => MissingNodeAction;
  /**
   * Whether a read restart whose GETs need `charged` storage calls,
   * every attempt counted, is admitted when the request has `left`.
   */
  readonly admitsRestart?: (charged: number, left: number) => boolean;
}

/** What a read knows about a node still missing after its re-GET. */
export interface MissingNodeSeen {
  /** The re-read head names a different root than the one that routed to the node. */
  readonly rootMoved: boolean;
  /** The view has already restarted once. */
  readonly restarted: boolean;
}

/**
 * A read's answer to a missing node: read again from the new root,
 * refuse retriably, or report the node as corrupt.
 */
export type MissingNodeAction = "restart" | "refuse" | "corrupt";

/** Whether two byte arrays hold the same bytes. */
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

const TREE_STEPS: TreeSteps = Object.freeze({
  layoutRules: TREE_LAYOUT_RULES,
  canonicalBytesMatch: bytesEqual,
});

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

/** The validated layout and the steps in force for one tree. */
export interface TreeConfig {
  readonly layout: TreeLayout;
  readonly steps: TreeSteps;
}

/** Longest string field value a layout error message repeats. */
const LAYOUT_MESSAGE_VALUE_CHARS = 64;

/**
 * The layout's own properties for an error message. It reads no getter
 * and never throws, whatever the field values are (a `BigInt` makes
 * `JSON.stringify` throw).
 */
const describeLayout = (layout: object): string =>
  Reflect.ownKeys(layout)
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(layout, key)!;
      const name = typeof key === "string" ? key : String(key);
      if (!("value" in descriptor)) {
        return `${name}: <accessor>`;
      }
      const value: unknown = descriptor.value;
      switch (typeof value) {
        case "number":
        case "boolean": {
          return `${name}: ${String(value)}`;
        }
        case "bigint": {
          return `${name}: ${value}n`;
        }
        case "string": {
          return `${name}: ${JSON.stringify(value.length > LAYOUT_MESSAGE_VALUE_CHARS ? `${value.slice(0, LAYOUT_MESSAGE_VALUE_CHARS)}…` : value)}`;
        }
        default: {
          return `${name}: <${value === null ? "null" : typeof value}>`;
        }
      }
    })
    .join(", ");

/**
 * Check `layout` against `rules`, in order.
 *
 * @throws BaerlyError code="InvalidConfig" — naming the first rule that fails.
 */
export const assertTreeLayout = (
  layout: TreeLayout,
  rules: readonly TreeLayoutRule[] = TREE_LAYOUT_RULES,
): void => {
  if (layout === null || typeof layout !== "object") {
    throw new BaerlyError("InvalidConfig", "tree layout: must be an object");
  }
  for (const rule of rules) {
    if (!rule.holds(layout)) {
      throw new BaerlyError(
        "InvalidConfig",
        `tree layout: rule ${rule.name} failed: ${rule.statement} (got {${describeLayout(layout)}})`,
      );
    }
  }
};

/**
 * A fresh object with `layout`'s own property descriptors, prototype
 * dropped. Validating and returning this copy means the values checked
 * are the values used: the caller's object can change afterwards, and a
 * getter is copied as a getter, so the `fields` rule refuses it.
 */
const copyLayout = (layout: TreeLayout): TreeLayout => {
  if (layout === null || typeof layout !== "object") {
    return layout;
  }
  return Object.defineProperties({}, Object.getOwnPropertyDescriptors(layout)) as TreeLayout;
};

/**
 * The internal tree constructor: resolve the layout (the override if
 * given, else {@link TREE_LAYOUT}) and the steps, and validate the
 * layout. The result is frozen.
 *
 * @throws BaerlyError code="InvalidConfig" — the layout breaks a rule.
 */
export const createTreeConfig = (options?: TreeConstructorOptions): TreeConfig => {
  const steps: TreeSteps = Object.freeze({ ...TREE_STEPS, ...options?.steps });
  const layout = copyLayout(options?.layout ?? TREE_LAYOUT);
  assertTreeLayout(layout, steps.layoutRules);
  return Object.freeze({ layout: Object.freeze(layout), steps });
};

/** The production configuration: {@link TREE_LAYOUT} and the real steps. */
export const DEFAULT_TREE_CONFIG: TreeConfig = createTreeConfig();
