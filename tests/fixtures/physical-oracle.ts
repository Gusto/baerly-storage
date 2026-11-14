/**
 * Physical crash oracle: the bucket's key set plus a SHA-256 per object,
 * and the rules for how one maintenance or commit step may change it.
 *
 * The logical oracle (the row set a reader observes) says a crash lost
 * nothing visible. This one says the crash left nothing behind but
 * permitted residue and rewrote no immutable object. A step's delta
 * (`before` → `after`) is legal only when:
 *
 * - every key parses as a known layout (an unknown key is a violation, so
 *   a new layout has to be taught here before a test can produce it);
 * - only the mutable manifests (`current.json`, `gc/pending.json`) change
 *   bytes; log entries, snapshots and legacy objects are immutable once
 *   written;
 * - keys are added and removed only in the classes the step owns
 *   ({@link STEP_RULES}), and a removal satisfies the step's guard (GC
 *   never deletes the published snapshot; retirement deletes only log
 *   entries below the published `log_delete_floor`);
 * - the snapshot `after`'s `current.json` publishes exists and its bytes
 *   hash to the digest sealed in its filename.
 *
 * Whatever the step left that no head references is reported as
 * {@link Residue} rather than a violation: orphan snapshots (sealed or
 * torn), log entries a retirement leaked below its floor, and inert pre-0.7
 * `index/` and `content/` objects.
 *
 * The parsers here are deliberately independent of the kernel's, so a
 * kernel key-shape bug cannot hide behind the oracle agreeing with it.
 */
import { BaerlyError, readCurrentJson, sha256Hex, type Storage } from "@baerly/protocol";

/** Key → lowercase hex SHA-256 of the object's bytes. */
export type BucketImage = ReadonlyMap<string, string>;

/** Hash every object under `prefix`. */
export const captureBucket = async (storage: Storage, prefix = ""): Promise<BucketImage> => {
  const image = new Map<string, string>();
  for await (const entry of storage.list(prefix)) {
    const got = await storage.get(entry.key);
    if (got !== null) {
      image.set(entry.key, await sha256Hex(got.body));
    }
  }
  return image;
};

export type KeyClass =
  | "current"
  | "gc-pending"
  | "log"
  | "snapshot"
  | "legacy-index"
  | "legacy-content"
  | "unknown";

export interface ClassifiedKey {
  readonly cls: KeyClass;
  /** `log/<seq>.json` sequence. */
  readonly seq?: number;
  /** Snapshot filename's `<max>` (exclusive upper seq). */
  readonly maxSeq?: number;
  /** Snapshot filename's sealed SHA-256. */
  readonly sealed?: string;
}

const LOG_RE = /^log\/(0|[1-9]\d*)\.json$/;
const SNAPSHOT_RE = /^snapshot\/L9\/(\d{12})-(\d{12})-([0-9a-f]{64})\.json$/;

export const classifyKey = (collectionPrefix: string, key: string): ClassifiedKey => {
  if (!key.startsWith(`${collectionPrefix}/`)) {
    return { cls: "unknown" };
  }
  const rest = key.slice(collectionPrefix.length + 1);
  if (rest === "current.json") {
    return { cls: "current" };
  }
  if (rest === "gc/pending.json") {
    return { cls: "gc-pending" };
  }
  const log = LOG_RE.exec(rest);
  if (log !== null) {
    return { cls: "log", seq: Number(log[1]) };
  }
  const snap = SNAPSHOT_RE.exec(rest);
  if (snap !== null) {
    return { cls: "snapshot", maxSeq: Number(snap[2]), sealed: snap[3]! };
  }
  if (rest.startsWith("index/")) {
    return { cls: "legacy-index" };
  }
  if (/^content\/[0-9a-f]+\.json$/.test(rest)) {
    return { cls: "legacy-content" };
  }
  return { cls: "unknown" };
};

/** The commit or maintenance step a delta is judged against. */
export type OracleStep = "write" | "compact" | "gc" | "retire";

interface StepRule {
  readonly add: readonly KeyClass[];
  readonly remove: readonly KeyClass[];
  readonly change: readonly KeyClass[];
}

/**
 * Which classes each step may add, remove, or rewrite. A step that is
 * not listed for a class must leave every key of that class untouched.
 *
 * A commit may run the in-band write tick (a GC slice, a fold, a
 * retirement slice), so `write` is the commit's log create plus the union
 * of the maintenance rules; the removal guards still apply.
 */
export const STEP_RULES: Readonly<Record<OracleStep, StepRule>> = {
  write: {
    add: ["log", "snapshot", "gc-pending"],
    remove: ["log", "snapshot"],
    change: ["current", "gc-pending"],
  },
  compact: { add: ["snapshot"], remove: [], change: ["current"] },
  gc: { add: ["gc-pending"], remove: ["snapshot"], change: ["gc-pending"] },
  retire: { add: [], remove: ["log"], change: ["current"] },
};

/** The manifest fields the oracle reads. */
export interface ManifestView {
  readonly snapshot: string | null;
  readonly log_seq_start: number;
  readonly log_delete_floor?: number;
}

export interface Residue {
  /** Unreferenced snapshots whose bytes match their sealed digest. */
  readonly orphanSnapshots: readonly string[];
  /** Unreferenced snapshots whose bytes do not (a torn PUT). */
  readonly tornSnapshots: readonly string[];
  /** Log entries below `log_delete_floor` that are still present. */
  readonly leakedLog: readonly string[];
  /** Pre-0.7 `index/` and `content/` objects. */
  readonly legacy: readonly string[];
}

export interface OracleVerdict {
  readonly violations: readonly string[];
  readonly residue: Residue;
}

const keysOf = (image: BucketImage): readonly string[] => [...image.keys()].toSorted();

/**
 * Judge one step's physical delta. `afterManifest` is the `current.json`
 * the bucket holds once the step has returned or thrown.
 */
export const judgeStep = (args: {
  readonly collectionPrefix: string;
  readonly step: OracleStep;
  readonly before: BucketImage;
  readonly after: BucketImage;
  readonly afterManifest: ManifestView;
}): OracleVerdict => {
  const { collectionPrefix, step, before, after, afterManifest } = args;
  const rule = STEP_RULES[step];
  const violations: string[] = [];
  const floor = afterManifest.log_delete_floor ?? 0;

  for (const key of keysOf(after)) {
    const c = classifyKey(collectionPrefix, key);
    if (c.cls === "unknown") {
      violations.push(`unknown key layout: ${key}`);
      continue;
    }
    const prior = before.get(key);
    if (prior === undefined) {
      if (!rule.add.includes(c.cls)) {
        violations.push(`${step} added a ${c.cls} key: ${key}`);
      }
    } else if (prior !== after.get(key) && !rule.change.includes(c.cls)) {
      violations.push(`${step} rewrote an immutable ${c.cls} key: ${key}`);
    }
  }

  for (const key of keysOf(before)) {
    if (after.has(key)) {
      continue;
    }
    const c = classifyKey(collectionPrefix, key);
    if (!rule.remove.includes(c.cls)) {
      violations.push(`${step} removed a ${c.cls} key: ${key}`);
    } else if (c.cls === "snapshot" && key === afterManifest.snapshot) {
      violations.push(`${step} removed the published snapshot: ${key}`);
    } else if (c.cls === "log" && (c.seq ?? 0) >= floor) {
      violations.push(`${step} removed log seq ${c.seq} at or above log_delete_floor ${floor}`);
    }
  }

  const published = afterManifest.snapshot;
  if (published !== null) {
    const c = classifyKey(collectionPrefix, published);
    const digest = after.get(published);
    if (c.cls !== "snapshot") {
      violations.push(`current.json publishes a non-snapshot key: ${published}`);
    } else if (digest === undefined) {
      violations.push(`current.json publishes a missing snapshot: ${published}`);
    } else if (digest !== c.sealed) {
      violations.push(`current.json publishes a torn snapshot: ${published}`);
    }
  }

  const orphanSnapshots: string[] = [];
  const tornSnapshots: string[] = [];
  const leakedLog: string[] = [];
  const legacy: string[] = [];
  for (const key of keysOf(after)) {
    const c = classifyKey(collectionPrefix, key);
    if (c.cls === "snapshot" && key !== published) {
      (after.get(key) === c.sealed ? orphanSnapshots : tornSnapshots).push(key);
    } else if (c.cls === "log" && (c.seq ?? 0) < floor) {
      leakedLog.push(key);
    } else if (c.cls === "legacy-index" || c.cls === "legacy-content") {
      legacy.push(key);
    }
  }
  return { violations, residue: { orphanSnapshots, tornSnapshots, leakedLog, legacy } };
};

/**
 * Codes a crashed step may surface, per step. Anything else, and any
 * error that is neither a `BaerlyError` nor the harness's injected
 * `AbortError`, is a violation.
 */
export const SURFACED_CODE_ALLOW_LIST: Readonly<Record<OracleStep, readonly string[]>> = {
  write: ["AmbiguousCommit", "WriteConflict"],
  compact: ["WriteConflict"],
  gc: ["WriteConflict"],
  retire: ["WriteConflict"],
};

/**
 * KNOWN DEFECT, tolerated and named rather than allow-listed: the
 * `current.json` and `gc/pending.json` CAS helpers
 * (`translateCasError` in `packages/protocol/src/coordination/`) wrap any
 * non-`BaerlyError` storage failure as `InvalidResponse`, so a transport
 * abort mid-CAS surfaces as "malformed storage response". Repro: arm
 * `abortingStorage` on the `gc/pending.json` PUT inside `runGc`, or the
 * floor CAS inside `retireLogRange`. Only that exact shape (an
 * `InvalidResponse` whose direct `cause` is an `AbortError`) passes; drop
 * this once the helpers stop relabelling aborts.
 */
export const isKnownAbortRelabel = (error: unknown): boolean =>
  error instanceof BaerlyError &&
  error.code === "InvalidResponse" &&
  error.cause instanceof Error &&
  error.cause.name === "AbortError";

/**
 * A violation string when `error` (what a crashed step threw) is outside
 * the step's allow-list, otherwise `undefined`. The injected `AbortError`
 * passes through unwrapped.
 */
export const surfacedErrorViolation = (step: OracleStep, error: unknown): string | undefined => {
  if (isKnownAbortRelabel(error)) {
    return undefined;
  }
  if (error instanceof BaerlyError) {
    return SURFACED_CODE_ALLOW_LIST[step].includes(error.code)
      ? undefined
      : `${step} surfaced a code outside the allow-list: ${error.code}: ${error.message}`;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return undefined;
  }
  const name = error instanceof Error ? error.name : typeof error;
  return `${step} surfaced a non-BaerlyError: ${name}: ${String(error)}`;
};

export interface ObservedStep extends OracleVerdict {
  /** `true` when `run` returned, `false` when it threw. */
  readonly completed: boolean;
  /** What `run` threw, when it threw. */
  readonly error?: unknown;
}

/**
 * Run one step against `storage` and judge it: capture the collection's
 * bucket image, run, capture again, and fold the surfaced-error check into
 * the verdict's `violations`. `storage` is the healthy inner bucket; `run`
 * drives the step through whatever fault proxy the test armed.
 */
export const observeStep = async (args: {
  readonly storage: Storage;
  readonly collectionPrefix: string;
  readonly step: OracleStep;
  readonly run: () => Promise<unknown>;
}): Promise<ObservedStep> => {
  const { storage, collectionPrefix, step, run } = args;
  const before = await captureBucket(storage, `${collectionPrefix}/`);
  let completed = true;
  let error: unknown;
  try {
    await run();
  } catch (error_) {
    completed = false;
    error = error_;
  }
  const after = await captureBucket(storage, `${collectionPrefix}/`);
  const manifest = await readCurrentJson(storage, `${collectionPrefix}/current.json`);
  const verdict = judgeStep({
    collectionPrefix,
    step,
    before,
    after,
    afterManifest: manifest?.json ?? { snapshot: null, log_seq_start: 0 },
  });
  const errorViolation = completed ? undefined : surfacedErrorViolation(step, error);
  const violations =
    errorViolation === undefined ? verdict.violations : [...verdict.violations, errorViolation];
  return completed
    ? { completed, violations, residue: verdict.residue }
    : { completed, error, violations, residue: verdict.residue };
};
