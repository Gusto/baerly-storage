/**
 * Explicit transition executor for model-based tests of the prototype tree
 * (`packages/server/src/tree/`).
 *
 * A schedule is a list of {@link TreeTransition}s: commits through the real
 * `Writer`, fold ticks, fold prepares and publishes run apart so two folds
 * can race, GC ticks, cold and warm reads, and retries of a crashed step.
 * Commits, folds and GC ticks can carry a {@link TreeCrashPoint}. The
 * executor runs them one at a time, in order, against a fresh
 * `MemoryStorage` bucket. Each step runs under an observability context
 * with in-band maintenance disabled, because the default context would run
 * `compact()` onto the tree head and replace it with a monolithic snapshot.
 * After every step it records what the step returned, which storage ops
 * reached the bucket and which of them took effect, whether its crash point
 * fired, and the whole bucket image. It also fails the run if the head
 * gained a snapshot or a `<prefix>/snapshot/` key appeared.
 * `tests/fixtures/tree-model-properties.ts` checks runs against the logical
 * oracle.
 *
 * The system under test is built by a factory, one {@link TreeSystem} per
 * process. It supplies the commit path, a cold reader and, once they exist,
 * a fold step, a GC step and a warm reader. A transition whose capability
 * the system lacks is refused with a plain `Error` before any step runs;
 * the executor never pretends to fold or collect. {@link logPathSystem} is
 * the system that exists today: the real `Writer` and a reader over the
 * unfolded log tail.
 *
 * A `before` crash is a process death. Once its fault fires, every later
 * op of that process throws the same `AbortError` without reaching the
 * bucket, so catch and finally blocks cannot keep writing; the step's
 * outcome is `crashed` whatever the step returned, since a dead process
 * answers no one; and the next step runs on a new system from the factory,
 * with no warm reader and no prepared fold. An `after` crash is a lost
 * response, not a death: the process, its warm reader and its prepared
 * folds carry on.
 *
 * Storage stack, outermost first: adapter retry (`retryStorageCall`,
 * configured the way the S3 and R2 adapters configure it, with no backoff
 * sleep) → the process's death guard → {@link abortingStorage} fault
 * injection → a tap → the bucket. Retry sits above the faults so a lost
 * response (`after`) reaches create-conflict adoption the way it would
 * through a real adapter. The tap sits below them, so it records only ops
 * that reached the bucket.
 *
 * Test-only. NOT part of the protocol contract.
 */
import { fc } from "@fast-check/vitest";
import {
  BaerlyError,
  decodeJsonBytes,
  type DocumentData,
  type LogEntry,
  logObjectKey,
  MemoryStorage,
  readCurrentJson,
  retryStorageCall,
  type Storage,
} from "@baerly/protocol";
import { findLogTail, probeTailFrom } from "@baerly/server/_internal/kernel";
import { createObservabilityContext } from "@baerly/server/_internal/observability";
import { type CommitInput, type CommitResult, Writer } from "@baerly/server/_internal/testing";
import { runWithContext } from "@baerly/server/observability";
import { foldLogEntriesOnto } from "../../packages/server/src/log-walk.ts";
import { abortingStorage, type FaultTarget } from "./aborting-storage.ts";

/** Collection every schedule writes to. */
export const TREE_MODEL_COLLECTION = "items";

/** Collection prefix: `current.json`, `log/` and tree nodes live under it. */
export const TREE_MODEL_PREFIX = `app/tree-model/tenant/t/manifests/${TREE_MODEL_COLLECTION}`;

/** The collection head. */
export const TREE_MODEL_CURRENT_JSON_KEY = `${TREE_MODEL_PREFIX}/current.json`;

// ---------------------------------------------------------------------
// Transition alphabet
// ---------------------------------------------------------------------

/** What a system must provide beyond commit and cold read. */
export type TreeCapability = "fold" | "gc" | "warm-read";

/** Every capability, for checking a schedule's shape on its own. */
export const ALL_TREE_CAPABILITIES: ReadonlySet<TreeCapability> = new Set([
  "fold",
  "gc",
  "warm-read",
]);

/**
 * Where a step's storage traffic is cut.
 *
 * - `before`: the `nth` matching op throws an `AbortError` before it
 *   reaches the bucket, and the process dies (see the file header).
 * - `after`: the `nth` matching op applies, then throws a retryable
 *   `NetworkError` in place of its response (a lost acknowledgement).
 *
 * `nth` is 1-based and counts only ops matching `target` (every op when
 * omitted), including the adapter-retry attempts.
 */
export interface TreeCrashPoint {
  readonly boundary: "before" | "after";
  readonly nth: number;
  readonly target?: FaultTarget;
}

/**
 * One `Writer.commit`. The executor builds the post-image
 * `{ _id: docId, value, rev }` and sets `origin` to the same `rev`
 * ({@link treeMutationToken}), so every log entry and every row names the
 * step that wrote it. Values are numbers: the tree fold refuses JSON
 * `null`, so schedules never emit it.
 */
export type TreeCommitTransition =
  | {
      readonly kind: "commit";
      readonly op: "I" | "U";
      readonly docId: string;
      readonly value: number;
      readonly crash?: TreeCrashPoint;
    }
  | {
      readonly kind: "commit";
      readonly op: "D";
      readonly docId: string;
      readonly crash?: TreeCrashPoint;
    };

/** One write-tick fold: capture the head, fold the log prefix, publish. */
export interface TreeFoldTransition {
  readonly kind: "fold";
  readonly crash?: TreeCrashPoint;
}

/**
 * The first half of a fold: capture the head and plan, without publishing.
 * The prepared fold lives in the process; a later {@link TreeFoldPublishTransition}
 * publishes it. A commit or another fold between the two is how a schedule
 * races two folds.
 */
export interface TreeFoldPrepareTransition {
  readonly kind: "fold-prepare";
}

/**
 * Publish the fold prepared at step `of`. If the process died since, the
 * prepared fold died with it and the step is skipped.
 */
export interface TreeFoldPublishTransition {
  readonly kind: "fold-publish";
  readonly of: number;
}

/** One GC tick: its state reads and writes, deletes, log retirement. */
export interface TreeGcTransition {
  readonly kind: "gc";
  readonly crash?: TreeCrashPoint;
}

/**
 * Re-run step `of`, a fold or GC step with a crash point, with no crash.
 * Skipped when that crash point never fired.
 */
export interface TreeRetryTransition {
  readonly kind: "retry";
  readonly of: number;
}

/**
 * Read every row. `cold` opens a fresh reader; `warm` reuses the process's
 * reader, so it may serve from its cache.
 */
export interface TreeReadTransition {
  readonly kind: "read";
  readonly mode: "cold" | "warm";
}

export type TreeTransition =
  | TreeCommitTransition
  | TreeFoldTransition
  | TreeFoldPrepareTransition
  | TreeFoldPublishTransition
  | TreeGcTransition
  | TreeRetryTransition
  | TreeReadTransition;

/** The capability `transition` needs, or `undefined` for commit and cold read. */
export const requiredCapability = (
  transition: TreeTransition,
  steps: readonly TreeTransition[] = [],
): TreeCapability | undefined => {
  switch (transition.kind) {
    case "commit": {
      return undefined;
    }
    case "fold":
    case "fold-prepare":
    case "fold-publish": {
      return "fold";
    }
    case "gc": {
      return "gc";
    }
    case "read": {
      return transition.mode === "warm" ? "warm-read" : undefined;
    }
    case "retry": {
      const target = steps[transition.of];
      return target === undefined ? undefined : requiredCapability(target, steps);
    }
  }
};

/** The `rev` and `origin` a commit at step `index` writes. */
export const treeMutationToken = (index: number): string => `step-${index}`;

/** The crash point `transition` carries, if any. */
export const crashOf = (transition: TreeTransition): TreeCrashPoint | undefined =>
  "crash" in transition ? transition.crash : undefined;

/**
 * Why `transitions` cannot run on a system with `capabilities`: one line per
 * problem, empty when it can.
 */
export const scheduleProblems = (
  transitions: readonly TreeTransition[],
  capabilities: ReadonlySet<TreeCapability>,
): string[] => {
  const problems: string[] = [];
  const published = new Set<number>();
  for (const [index, transition] of transitions.entries()) {
    if (transition.kind === "retry") {
      const target = transitions[transition.of];
      if (
        transition.of >= index ||
        target === undefined ||
        (target.kind !== "fold" && target.kind !== "gc") ||
        target.crash === undefined
      ) {
        problems.push(
          `step ${index} retries step ${transition.of}, which is not an earlier fold or GC step with a crash point`,
        );
      }
    }
    if (transition.kind === "fold-publish") {
      if (
        transition.of >= index ||
        transitions[transition.of]?.kind !== "fold-prepare" ||
        published.has(transition.of)
      ) {
        problems.push(
          `step ${index} publishes step ${transition.of}, which is not an earlier, unpublished fold-prepare step`,
        );
      }
      published.add(transition.of);
    }
    const needed = requiredCapability(transition, transitions);
    if (needed !== undefined && !capabilities.has(needed)) {
      problems.push(`step ${index} (${transition.kind}) needs the ${needed} capability`);
    }
  }
  return problems;
};

// ---------------------------------------------------------------------
// System under test
// ---------------------------------------------------------------------

/** What a system under test sees. */
export interface TreeWorld {
  readonly collection: string;
  readonly prefix: string;
  readonly currentJsonKey: string;
  /** Adapter retry over the process's death guard, fault injection and the bucket. */
  readonly storage: Storage;
}

/** Rows a reader observes, keyed by `_id`. */
export type TreeRows = ReadonlyMap<string, DocumentData>;

/** A reader that may keep state between reads. */
export interface TreeReader {
  read(): Promise<TreeRows>;
}

/** What one fold publish did. `cas-lost` is a value, not an error. */
export type TreeFoldResult =
  | { readonly kind: "published"; readonly foldedSeq: number; readonly root: string | null }
  | { readonly kind: "cas-lost" }
  | { readonly kind: "nothing-to-fold" };

/** A fold that has captured the head and planned, and has not published. */
export interface TreePreparedFold {
  publish(): Promise<TreeFoldResult>;
}

/** What one GC tick did. */
export interface TreeGcResult {
  /** Keys the tick deleted, nodes and retired log slots alike. */
  readonly deleted: readonly string[];
}

/** The system under test, as one process sees it. */
export interface TreeSystem {
  readonly name: string;
  commit(world: TreeWorld, input: CommitInput): Promise<CommitResult>;
  readCold(world: TreeWorld): Promise<TreeRows>;
  readonly openWarmReader?: (world: TreeWorld) => TreeReader;
  readonly fold?: { prepare(world: TreeWorld): Promise<TreePreparedFold> };
  readonly gc?: { tick(world: TreeWorld): Promise<TreeGcResult> };
}

/**
 * Builds the system for a new process. The executor calls it at the start
 * of a run and again after every process death. Mutants are factories too:
 * a function from a factory to a factory that injects one defect.
 */
export type TreeSystemFactory = () => TreeSystem;

/** The capabilities `system` provides. */
export const capabilitiesOf = (system: TreeSystem): ReadonlySet<TreeCapability> => {
  const caps = new Set<TreeCapability>();
  if (system.fold !== undefined) {
    caps.add("fold");
  }
  if (system.gc !== undefined) {
    caps.add("gc");
  }
  if (system.openWarmReader !== undefined) {
    caps.add("warm-read");
  }
  return caps;
};

// ---------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------

/** Key → object bytes, in `list` order. */
export type TreeBucketImage = ReadonlyMap<string, Uint8Array>;

/** A storage write that took effect in the bucket. */
export type TreeAppliedOp =
  | { readonly op: "put"; readonly key: string; readonly body: Uint8Array }
  | {
      readonly op: "delete";
      readonly key: string;
      /** Whether the key held an object when the delete reached the bucket. */
      readonly existed: boolean;
    };

/**
 * What a step returned.
 *
 * - `refused`: a commit failed with a code the `Writer` documents as
 *   "nothing was committed".
 * - `crashed`: the process died during the step.
 * - `failed`: any other error. A commit's fate is unknown.
 * - `skipped`: a retry whose crash point never fired, or a publish whose
 *   prepared fold died with its process. Nothing ran.
 */
export type TreeStepOutcome =
  | { readonly kind: "acknowledged"; readonly entry: LogEntry }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "crashed" }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "prepared" }
  | { readonly kind: "folded"; readonly result: TreeFoldResult }
  | { readonly kind: "collected"; readonly result: TreeGcResult }
  | { readonly kind: "read"; readonly mode: "cold" | "warm"; readonly rows: TreeRows }
  | { readonly kind: "skipped"; readonly reason: string };

export interface TreeStep {
  readonly index: number;
  readonly transition: TreeTransition;
  readonly outcome: TreeStepOutcome;
  /** Whether the step's crash point fired. */
  readonly crashFired: boolean;
  /** Whether the process died during the step. */
  readonly died: boolean;
  /** Storage ops of any kind, reads included, that reached the bucket. */
  readonly reached: number;
  /** Writes that took effect during the step, in order. */
  readonly applied: readonly TreeAppliedOp[];
  /** The bucket after the step. */
  readonly image: TreeBucketImage;
}

export interface TreeRun {
  readonly system: string;
  readonly capabilities: ReadonlySet<TreeCapability>;
  readonly collection: string;
  readonly prefix: string;
  readonly steps: readonly TreeStep[];
  /** A cold read after the last step, on the process alive then. */
  readonly finalRead: TreeFinalRead;
}

/** The closing cold read: its rows, or the code it failed with. */
export type TreeFinalRead =
  | { readonly kind: "read"; readonly rows: TreeRows }
  | { readonly kind: "failed"; readonly code: string };

/**
 * Codes `Writer.commit` documents as "nothing was committed". Any other
 * failure leaves the commit's fate unknown.
 */
export const COMMIT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "InvalidConfig",
  "AlreadyExists",
  "WriteConflict",
  "CapacityExceeded",
  "MaintenancePending",
]);

// ---------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------

/** One process: a system instance, its storage view and its in-memory state. */
interface TreeProcess {
  readonly system: TreeSystem;
  readonly world: TreeWorld;
  readonly isDead: () => boolean;
  warm: TreeReader | undefined;
  readonly prepared: Map<number, TreePreparedFold>;
}

/** Run `transitions` against a fresh bucket, one at a time. */
export const runTreeSchedule = async (
  makeSystem: TreeSystemFactory,
  transitions: readonly TreeTransition[],
): Promise<TreeRun> => {
  const first = makeSystem();
  const capabilities = capabilitiesOf(first);
  const problems = scheduleProblems(transitions, capabilities);
  if (problems.length > 0) {
    throw new Error(
      `tree executor: system ${JSON.stringify(first.name)} cannot run this schedule: ${problems.join("; ")}`,
    );
  }

  const bucket = new MemoryStorage();
  let applied: TreeAppliedOp[] = [];
  let reached = 0;
  const faults = abortingStorage(
    tapStorage(bucket, {
      reached: () => {
        reached += 1;
      },
      applied: (op) => applied.push(op),
    }),
  );
  const startProcess = (system: TreeSystem): TreeProcess => {
    const guard = deathGuard(faults.storage);
    return {
      system,
      world: {
        collection: TREE_MODEL_COLLECTION,
        prefix: TREE_MODEL_PREFIX,
        currentJsonKey: TREE_MODEL_CURRENT_JSON_KEY,
        storage: adapterRetry(guard.storage),
      },
      isDead: guard.isDead,
      warm: undefined,
      prepared: new Map(),
    };
  };

  let process = startProcess(first);
  const steps: TreeStep[] = [];
  for (const [index, transition] of transitions.entries()) {
    applied = [];
    reached = 0;
    const crash = crashOf(transition);
    faults.resetCount();
    if (crash?.boundary === "before") {
      faults.armAt(crash.nth, crash.target);
    } else if (crash?.boundary === "after") {
      faults.armPostApplyAt(crash.nth, crash.target);
    }
    const firedBefore = faults.faultsFired();
    let outcome: TreeStepOutcome;
    try {
      outcome = await inMaintenanceDisabledContext(() =>
        runStep(process, transition, index, steps),
      );
    } catch (error) {
      outcome = classifyFailure(error, transition);
    }
    faults.armAt(undefined);
    faults.armPostApplyAt(undefined);
    const crashFired = faults.faultsFired() > firedBefore;
    const died = process.isDead();
    if (died) {
      outcome = { kind: "crashed" };
      process = startProcess(makeSystem());
    }
    const image = await captureImage(bucket);
    assertTreeHead(image, TREE_MODEL_PREFIX, index);
    steps.push({ index, transition, outcome, crashFired, died, reached, applied, image });
  }

  let finalRead: TreeFinalRead;
  try {
    finalRead = {
      kind: "read",
      rows: snapshotRows(
        await inMaintenanceDisabledContext(() => process.system.readCold(process.world)),
      ),
    };
  } catch (error) {
    finalRead = { kind: "failed", code: errorCode(error) };
  }
  return {
    system: first.name,
    capabilities,
    collection: TREE_MODEL_COLLECTION,
    prefix: TREE_MODEL_PREFIX,
    steps,
    finalRead,
  };
};

const inMaintenanceDisabledContext = <T>(fn: () => Promise<T>): Promise<T> =>
  Promise.resolve(
    runWithContext(createObservabilityContext({ maintenance: { disabled: true } }), fn),
  );

/** Preserve observations even when a reader reuses its cache and document objects. */
const snapshotRows = (rows: TreeRows): TreeRows => structuredClone(new Map(rows));

const runStep = async (
  process: TreeProcess,
  transition: TreeTransition,
  index: number,
  steps: readonly TreeStep[],
): Promise<TreeStepOutcome> => {
  const { system, world } = process;
  switch (transition.kind) {
    case "commit": {
      const token = treeMutationToken(index);
      const input: CommitInput =
        transition.op === "D"
          ? { op: "D", collection: world.collection, docId: transition.docId, origin: token }
          : {
              op: transition.op,
              collection: world.collection,
              docId: transition.docId,
              body: { _id: transition.docId, value: transition.value, rev: token },
              origin: token,
            };
      const result = await system.commit(world, input);
      return { kind: "acknowledged", entry: result.entry };
    }
    case "fold": {
      const prepared = await system.fold!.prepare(world);
      return { kind: "folded", result: await prepared.publish() };
    }
    case "fold-prepare": {
      process.prepared.set(index, await system.fold!.prepare(world));
      return { kind: "prepared" };
    }
    case "fold-publish": {
      const prepared = process.prepared.get(transition.of);
      if (prepared === undefined) {
        return { kind: "skipped", reason: `the fold prepared at step ${transition.of} died` };
      }
      process.prepared.delete(transition.of);
      return { kind: "folded", result: await prepared.publish() };
    }
    case "gc": {
      return { kind: "collected", result: await system.gc!.tick(world) };
    }
    case "retry": {
      const target = steps[transition.of]!;
      if (!target.crashFired) {
        return { kind: "skipped", reason: `step ${transition.of}'s crash point never fired` };
      }
      const { crash: _crash, ...uncrashed } = target.transition as
        | TreeFoldTransition
        | TreeGcTransition;
      return runStep(process, uncrashed, index, steps);
    }
    case "read": {
      if (transition.mode === "warm") {
        process.warm ??= system.openWarmReader!(world);
        return { kind: "read", mode: "warm", rows: snapshotRows(await process.warm.read()) };
      }
      return { kind: "read", mode: "cold", rows: snapshotRows(await system.readCold(world)) };
    }
  }
};

const classifyFailure = (error: unknown, transition: TreeTransition): TreeStepOutcome => {
  if (error instanceof Error && error.message.startsWith("tree executor:")) {
    throw error;
  }
  const code = errorCode(error);
  if (transition.kind === "commit" && COMMIT_REFUSAL_CODES.has(code)) {
    return { kind: "refused", code };
  }
  return { kind: "failed", code };
};

const errorCode = (error: unknown): string => {
  if (error instanceof BaerlyError) {
    return error.code;
  }
  return error instanceof Error ? error.name : String(error);
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

const deathError = (): Error => {
  const error = new Error("AbortError (the process died at an injected crash)");
  error.name = "AbortError";
  return error;
};

/**
 * One process's view of `inner`. The first `AbortError` out of `inner` (the
 * injected `before` crash) kills the process: from then on every op throws
 * without calling `inner`, so nothing more of this process reaches the
 * bucket.
 */
const deathGuard = (inner: Storage): { storage: Storage; isDead: () => boolean } => {
  let dead = false;
  const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
    if (dead) {
      throw deathError();
    }
    try {
      return await call();
    } catch (error) {
      if (isAbortError(error)) {
        dead = true;
      }
      throw error;
    }
  };
  return {
    isDead: () => dead,
    storage: {
      get: (key, opts) => guarded(() => inner.get(key, opts)),
      put: (key, body, opts) => guarded(() => inner.put(key, body, opts)),
      delete: (key, opts) => guarded(() => inner.delete(key, opts)),
      list: (prefix, opts) => {
        if (dead) {
          throw deathError();
        }
        try {
          return inner.list(prefix, opts);
        } catch (error) {
          if (isAbortError(error)) {
            dead = true;
          }
          throw error;
        }
      },
    },
  };
};

/** Wrap `inner` in the adapters' per-request retry, with no backoff sleep. */
const adapterRetry = (inner: Storage): Storage => {
  const sleep = async (): Promise<void> => {};
  return {
    get: (key, opts) => retryStorageCall(() => inner.get(key, opts), { pool: "internal", sleep }),
    put: (key, body, opts) =>
      retryStorageCall(() => inner.put(key, body, opts), {
        pool: "internal",
        sleep,
        conditionalCreate: opts?.ifNoneMatch === "*",
        compareAndSwap: opts?.ifMatch !== undefined && opts.ifNoneMatch !== "*",
      }),
    delete: (key, opts) =>
      retryStorageCall(() => inner.delete(key, opts), { pool: "internal", sleep }),
    list: (prefix, opts) => inner.list(prefix, opts),
  };
};

/** Count every op that reaches `inner`, and report every write it accepted. */
const tapStorage = (
  inner: Storage,
  record: { reached: () => void; applied: (op: TreeAppliedOp) => void },
): Storage => ({
  get: (key, opts) => {
    record.reached();
    return inner.get(key, opts);
  },
  put: async (key, body, opts) => {
    record.reached();
    const result = await inner.put(key, body, opts);
    record.applied({ op: "put", key, body: body.slice() });
    return result;
  },
  delete: async (key, opts) => {
    record.reached();
    const existed = (await inner.get(key)) !== null;
    await inner.delete(key, opts);
    record.applied({ op: "delete", key, existed });
  },
  list: (prefix, opts) => {
    record.reached();
    return inner.list(prefix, opts);
  },
});

const captureImage = async (bucket: Storage): Promise<TreeBucketImage> => {
  const image = new Map<string, Uint8Array>();
  for await (const { key } of bucket.list("")) {
    const got = await bucket.get(key);
    if (got !== null) {
      image.set(key, got.body.slice());
    }
  }
  return image;
};

// ---------------------------------------------------------------------
// Reading a run
// ---------------------------------------------------------------------

/** The head fields a tree checker reads. */
export interface TreeHead {
  readonly snapshot: unknown;
  readonly log_seq_start: number;
  readonly proto_tree?: { readonly root: string | null; readonly attempt: string };
}

/** The head in `image`, or `null` before the first commit. */
export const headOf = (image: TreeBucketImage, prefix: string): TreeHead | null => {
  const bytes = image.get(`${prefix}/current.json`);
  return bytes === undefined ? null : decodeJsonBytes<TreeHead>(bytes);
};

/** The head's root, `null` when there is none. */
export const rootOf = (head: TreeHead | null): string | null => head?.proto_tree?.root ?? null;

const assertTreeHead = (image: TreeBucketImage, prefix: string, index: number): void => {
  const head = headOf(image, prefix);
  if (head !== null && head.snapshot !== null) {
    throw new Error(
      `tree executor: step ${index} left snapshot ${JSON.stringify(head.snapshot)} on the tree head`,
    );
  }
  for (const key of image.keys()) {
    if (key.startsWith(`${prefix}/snapshot/`)) {
      throw new Error(`tree executor: step ${index} wrote monolithic snapshot key ${key}`);
    }
  }
};

const LOG_KEY = /\/log\/(0|[1-9]\d*)\.json$/;

/** The seq of a `<prefix>/log/<seq>.json` key, or `undefined`. */
export const logSeqOf = (prefix: string, key: string): number | undefined => {
  if (!key.startsWith(`${prefix}/log/`)) {
    return undefined;
  }
  const match = LOG_KEY.exec(key);
  return match === null ? undefined : Number(match[1]);
};

/**
 * Every log entry that landed in steps `0..throughStep`, keyed by the seq
 * in its key. Retiring a slot later does not remove it: this is the durable
 * history, not the bucket's current log. The entry's own `seq` field is not
 * checked here.
 */
export const durableLog = (
  run: TreeRun,
  throughStep = run.steps.length - 1,
): ReadonlyMap<number, LogEntry> => {
  const entries = new Map<number, LogEntry>();
  for (const step of run.steps.slice(0, throughStep + 1)) {
    for (const op of step.applied) {
      const seq = logSeqOf(run.prefix, op.key);
      if (op.op === "put" && seq !== undefined) {
        entries.set(seq, decodeJsonBytes<LogEntry>(op.body));
      }
    }
  }
  return entries;
};

/** The first seq at or above 0 with no entry in `log`. */
export const denseTail = (log: ReadonlyMap<number, LogEntry>): number => {
  let tail = 0;
  while (log.has(tail)) {
    tail += 1;
  }
  return tail;
};

// ---------------------------------------------------------------------
// The system that exists today
// ---------------------------------------------------------------------

/**
 * The real `Writer` and a cold reader over the unfolded log: probe the tail
 * from the head's `log_seq_start` and fold it with `foldLogEntriesOnto`,
 * the production read-path fold. It has no fold, GC or warm reader, so it
 * can read only a bucket nothing has folded.
 */
export const logPathSystem: TreeSystemFactory = () => ({
  name: "log-path",
  commit: (world, input) =>
    new Writer({ storage: world.storage, currentJsonKey: world.currentJsonKey }).commit(input),
  readCold: (world) => readUnfoldedLog(world, 0),
});

/** Read the unfolded log, leaving out its newest `drop` entries. */
const readUnfoldedLog = async (world: TreeWorld, drop: number): Promise<TreeRows> => {
  const head = await readCurrentJson(world.storage, world.currentJsonKey);
  const rows = new Map<string, DocumentData>();
  if (head === null) {
    return rows;
  }
  if (head.json.log_seq_start !== 0) {
    throw new Error(
      `log-path reader: the head has folded through seq ${head.json.log_seq_start}; reading the base needs the tree reader`,
    );
  }
  const { entries } = await probeTailFrom(world.storage, world.prefix, 0);
  foldLogEntriesOnto(rows, entries.slice(0, entries.length - drop), {
    collection: world.collection,
  });
  return rows;
};

const isRefusal = (error: unknown): boolean =>
  error instanceof BaerlyError && COMMIT_REFUSAL_CODES.has(error.code);

/**
 * Single-defect variants of {@link logPathSystem}, one per defect the log
 * path alone can show. Each maps a factory to a factory. State a mutant
 * keeps lives outside the process, so it survives a process death, as a
 * durable outbox or a client's resend queue would.
 *
 * - `ack-without-create`: when a live process sees a commit refused or
 *   failed, report it committed at the current tail anyway. On the log
 *   path only refusals reach it: a `before` crash kills the process, so
 *   its fabricated ack never leaves, and a single `after` fault is healed
 *   by adapter retry and create adoption. So it shows a writer that
 *   acknowledges a commit it refused; it does not show acknowledging an
 *   unresolved create after a lost response, which needs a fault that
 *   leaves a live commit's fate unknown.
 * - `resend-crashed-commit`: record each commit in an outbox before
 *   sending it, clear it on acknowledgement or refusal, and send whatever
 *   is left before the next commit, as a writer that resends a create
 *   instead of resolving its fate would. A dead process clears nothing.
 * - `double-commit`: send every commit twice and acknowledge the first.
 * - `resend-acknowledged-write`: after each acknowledged commit, send the
 *   previously acknowledged update again, as a writer that replays a stale
 *   outbox entry would.
 * - `cold-read-skips-newest-entry`: the cold reader leaves out the newest
 *   unfolded entry.
 */
export const LOG_PATH_MUTANTS = {
  "ack-without-create":
    (make: TreeSystemFactory): TreeSystemFactory =>
    () => {
      const system = make();
      return {
        ...system,
        name: `${system.name}+ack-without-create`,
        commit: async (world, input) => {
          try {
            return await system.commit(world, input);
          } catch {
            const seq = await findLogTail(world.storage, world.prefix, 0);
            const entry: LogEntry = {
              lsn: `fabricated_${seq}`,
              commit_ts: new Date(0).toISOString(),
              op: input.op,
              collection: input.collection,
              doc_id: input.docId,
              seq,
              ...(input.body !== undefined && { after: input.body }),
              ...(input.origin !== undefined && { origin: input.origin }),
            } as LogEntry;
            return { entry, currentEtag: "" };
          }
        },
      };
    },
  "resend-crashed-commit": (make: TreeSystemFactory): TreeSystemFactory => {
    let pending: CommitInput | undefined;
    return () => {
      const system = make();
      return {
        ...system,
        name: `${system.name}+resend-crashed-commit`,
        commit: async (world, input) => {
          if (pending !== undefined) {
            const resend = pending;
            pending = undefined;
            await system.commit(world, resend);
          }
          pending = input;
          try {
            const result = await system.commit(world, input);
            pending = undefined;
            return result;
          } catch (error) {
            if (isRefusal(error)) {
              pending = undefined;
            }
            throw error;
          }
        },
      };
    };
  },
  "double-commit":
    (make: TreeSystemFactory): TreeSystemFactory =>
    () => {
      const system = make();
      return {
        ...system,
        name: `${system.name}+double-commit`,
        commit: async (world, input) => {
          const result = await system.commit(world, input);
          await system.commit(world, input);
          return result;
        },
      };
    },
  "resend-acknowledged-write": (make: TreeSystemFactory): TreeSystemFactory => {
    let previous: CommitInput | undefined;
    return () => {
      const system = make();
      return {
        ...system,
        name: `${system.name}+resend-acknowledged-write`,
        commit: async (world, input) => {
          const result = await system.commit(world, input);
          if (previous !== undefined) {
            await system.commit(world, previous);
          }
          if (input.op === "U") {
            previous = input;
          }
          return result;
        },
      };
    };
  },
  "cold-read-skips-newest-entry":
    (make: TreeSystemFactory): TreeSystemFactory =>
    () => {
      const system = make();
      return {
        ...system,
        name: `${system.name}+cold-read-skips-newest-entry`,
        readCold: (world) => readUnfoldedLog(world, 1),
      };
    },
} as const satisfies Record<string, (make: TreeSystemFactory) => TreeSystemFactory>;

export type LogPathMutant = keyof typeof LOG_PATH_MUTANTS;

// ---------------------------------------------------------------------
// Deterministic schedule generation
// ---------------------------------------------------------------------

/** Bounds for {@link treeScheduleArbitrary}. */
export interface TreeScheduleBounds {
  /** Transitions the schedule may use beyond commit and cold read. */
  readonly capabilities: ReadonlySet<TreeCapability>;
  /** `_id`s commits draw from. Small sets make overwrites and deletes collide. */
  readonly docIds: readonly string[];
  readonly maxLength: number;
  /** Largest `nth` a crash point may target. */
  readonly maxCrashOp: number;
}

/** Generator-only placeholder: publish the oldest unpublished prepare. */
const PUBLISH_OLDEST = { kind: "fold-publish", of: -1 } as const;

/**
 * Schedules over the alphabet `bounds.capabilities` allows. fast-check makes
 * generation reproducible from its seed and shrinks a failure to a short
 * schedule. Every fold or GC step with a crash point is followed by its
 * retry, which the executor skips when the crash never fired, and every
 * prepared fold is published, at a generated point or at the end, so a
 * schedule never ends mid-recovery by accident.
 */
export const treeScheduleArbitrary = (
  bounds: TreeScheduleBounds,
): fc.Arbitrary<readonly TreeTransition[]> => {
  const crash = fc.option(
    fc.record(
      {
        boundary: fc.constantFrom("before" as const, "after" as const),
        nth: fc.integer({ min: 1, max: bounds.maxCrashOp }),
      },
      { requiredKeys: ["boundary", "nth"] },
    ),
    { nil: undefined, freq: 3 },
  );
  const docId = fc.constantFrom(...bounds.docIds);
  const withCrash = <T extends object>(base: T, point: TreeCrashPoint | undefined): T =>
    point === undefined ? base : { ...base, crash: point };

  const choices: fc.Arbitrary<TreeTransition>[] = [
    fc
      .tuple(fc.constantFrom("I" as const, "U" as const), docId, fc.integer(), crash)
      .map(([op, id, value, point]) =>
        withCrash<TreeTransition>({ kind: "commit", op, docId: id, value }, point),
      ),
    fc
      .tuple(docId, crash)
      .map(([id, point]) =>
        withCrash<TreeTransition>({ kind: "commit", op: "D", docId: id }, point),
      ),
    fc.constant<TreeTransition>({ kind: "read", mode: "cold" }),
  ];
  if (bounds.capabilities.has("warm-read")) {
    choices.push(fc.constant<TreeTransition>({ kind: "read", mode: "warm" }));
  }
  if (bounds.capabilities.has("fold")) {
    choices.push(crash.map((point) => withCrash<TreeTransition>({ kind: "fold" }, point)));
    choices.push(fc.constant<TreeTransition>({ kind: "fold-prepare" }));
    choices.push(fc.constant<TreeTransition>(PUBLISH_OLDEST));
  }
  if (bounds.capabilities.has("gc")) {
    choices.push(crash.map((point) => withCrash<TreeTransition>({ kind: "gc" }, point)));
  }

  return fc.array(fc.oneof(...choices), { maxLength: bounds.maxLength }).map((transitions) => {
    const out: TreeTransition[] = [];
    const unpublished: number[] = [];
    for (const transition of transitions) {
      if (transition === PUBLISH_OLDEST) {
        const of = unpublished.shift();
        if (of !== undefined) {
          out.push({ kind: "fold-publish", of });
        }
        continue;
      }
      out.push(transition);
      if (transition.kind === "fold-prepare") {
        unpublished.push(out.length - 1);
      }
      if ((transition.kind === "fold" || transition.kind === "gc") && transition.crash) {
        out.push({ kind: "retry", of: out.length - 1 });
      }
    }
    for (const of of unpublished) {
      out.push({ kind: "fold-publish", of });
    }
    return out;
  });
};

/** A crash target that matches only the `log/<seq>` create. */
export const logCreateTarget = (prefix: string = TREE_MODEL_PREFIX): FaultTarget => ({
  prefix: `${prefix}/log/`,
  ops: ["put"],
});

/** The log key for `seq` under `prefix`. */
export const treeLogKey = (seq: number, prefix: string = TREE_MODEL_PREFIX): string =>
  logObjectKey(prefix, seq);
