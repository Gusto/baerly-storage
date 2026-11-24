/**
 * The eight safety properties of the tree model, checked over a
 * {@link TreeRun} from `tests/fixtures/tree-executor.ts`; the structural
 * checks that say whether a set of runs exercised them; and the mutation
 * schedules: a schedule plus a single defect that must turn its property
 * red.
 *
 * Each property gives a three-way verdict ({@link TreePropertyStatus}): it
 * holds, it is violated, or the run never reached the situation it
 * constrains. A run that does not exercise a property is not a failure, so
 * every evaluable property runs on every run and a schedule is judged only
 * by what it reaches. Whether runs reach enough is a separate question,
 * answered by {@link checkTreeStructure} over a set of runs, as the
 * structural properties do in `tests/model/multilevel/property-suite.ts`.
 *
 * Expected rows always come from the logical oracle
 * (`tests/fixtures/tree-oracle-logical.ts`): `foldLogical` over every log
 * entry that landed, which is what a reader at the tail must observe
 * whatever has been folded. Physical claims come from the run's bucket
 * images. Claims about which nodes a root reaches, and how many nodes the
 * canonical tree for a row set has, come from a {@link TreeStructureOracle},
 * which the physical tree oracle supplies; a property that needs one is not
 * evaluated without it.
 *
 * A property is evaluated only on a run whose system provides the
 * capabilities it {@link TreeProperty.requires} (fold, GC, warm read). The
 * log path alone provides none of them, so today the two commit properties
 * and the read property run. A property becomes live when a system supplies
 * what it needs, and its mutation schedules then have to go red.
 *
 * Test-only.
 */
import { isDeepStrictEqual } from "node:util";
import { BaerlyError, decodeJsonBytes, type DocumentData, type LogEntry } from "@baerly/protocol";
import { treeNodeKeyPrefix } from "../../packages/server/src/tree/key.ts";
import {
  crashOf,
  denseTail,
  durableLog,
  headOf,
  logCreateTarget,
  logSeqOf,
  rootOf,
  TREE_MODEL_CURRENT_JSON_KEY,
  TREE_MODEL_PREFIX,
  treeLogKey,
  treeMutationToken,
  type TreeBucketImage,
  type TreeCapability,
  type TreeFoldResult,
  type TreeRows,
  type TreeRun,
  type TreeStep,
  type TreeTransition,
} from "./tree-executor.ts";
import { foldLogical } from "./tree-oracle-logical.ts";

export const TREE_PROPERTY_NAMES = [
  "acknowledged-never-lost",
  "unacknowledged-never-visible",
  "cold-and-warm-equal-reference",
  "publication-monotone-no-partial-run",
  "lost-cas-preserves-winner",
  "reclamation-preserves-reachable",
  "recovery-idempotent",
  "object-count-bounded",
] as const;

export type TreePropertyName = (typeof TREE_PROPERTY_NAMES)[number];

/**
 * - `holds`: the run reached what the property constrains, and it held.
 * - `violated`: some failure was found. A violation counts whether or not
 *   the run also reached the property's subject.
 * - `not-exercised`: no failure, and the run never reached the subject.
 */
export type TreePropertyStatus = "holds" | "violated" | "not-exercised";

/** One property's verdict on one run. */
export interface TreePropertyCheck {
  readonly name: TreePropertyName;
  readonly status: TreePropertyStatus;
  /** Whether the run reached what the property constrains. */
  readonly exercised: boolean;
  /** What the check looked at, for the failure message. */
  readonly evidence: readonly string[];
  readonly failures: readonly string[];
}

/** Which nodes a root reaches in a bucket image, and how big a canonical tree is. */
export interface TreeStructureOracle {
  /**
   * Every key reachable from `root` in `image`, `root` included, and every
   * key some reachable node references that `image` lacks.
   */
  reachable(
    image: TreeBucketImage,
    prefix: string,
    root: string,
  ): { readonly keys: ReadonlySet<string>; readonly missing: readonly string[] };
  /** Fixed-name records the tree keeps beside its nodes, such as the GC state. */
  bookkeepingKeys(prefix: string): readonly string[];
  /**
   * Nodes in the canonical tree for `rows`, root included: 0 for no rows.
   * The tree layout makes the canonical tree a function of the row set.
   */
  canonicalNodeCount(rows: TreeRows): number;
}

/** Oracles a property may need beyond the logical one. */
export interface TreeModelOracles {
  readonly structure?: TreeStructureOracle;
}

export interface TreeProperty {
  readonly name: TreePropertyName;
  /** Capabilities the run's system must all provide. */
  readonly requires: readonly TreeCapability[];
  /** When set, the system must provide at least one of these too. */
  readonly requiresOneOf?: readonly TreeCapability[];
  /** Whether the check needs {@link TreeModelOracles.structure}. */
  readonly needsStructure: boolean;
  readonly check: (run: TreeRun, oracles: TreeModelOracles) => TreePropertyCheck;
}

// ---------------------------------------------------------------------
// Shared reading of a run
// ---------------------------------------------------------------------

/**
 * The oracle's rows over every entry that landed in steps `0..throughStep`,
 * folded to the dense tail or to `targetSeq`. A landed entry the oracle
 * cannot fold, such as one whose `seq` disagrees with its key, comes back
 * as a failure string, since the system under test wrote it.
 */
export const oracleRows = (
  run: TreeRun,
  throughStep = run.steps.length - 1,
  targetSeq?: number,
): { readonly rows: TreeRows } | { readonly failure: string } => {
  const log = durableLog(run, throughStep);
  for (const [seq, entry] of log) {
    if (entry.seq !== seq) {
      return { failure: `log/${seq}.json holds an entry for seq ${String(entry.seq)}` };
    }
  }
  try {
    return {
      rows: foldLogical({
        collection: run.collection,
        base: new Map(),
        baseSeq: 0,
        entries: [...log.values()],
        targetSeq: targetSeq ?? denseTail(log),
      }).rows,
    };
  } catch (error) {
    const code = error instanceof BaerlyError ? error.code : "Error";
    return {
      failure: `the oracle cannot fold the landed log: ${code}: ${(error as Error).message}`,
    };
  }
};

const verdict = (
  name: TreePropertyName,
  exercised: boolean,
  evidence: readonly string[],
  failures: readonly string[],
): TreePropertyCheck => {
  let status: TreePropertyStatus = "not-exercised";
  if (failures.length > 0) {
    status = "violated";
  } else if (exercised) {
    status = "holds";
  }
  return { name, status, exercised, evidence, failures };
};

const EMPTY_IMAGE: TreeBucketImage = new Map();

const lastImage = (run: TreeRun): TreeBucketImage => run.steps.at(-1)?.image ?? EMPTY_IMAGE;

/** The bucket as step `index` found it. */
const imageBefore = (run: TreeRun, index: number): TreeBucketImage =>
  run.steps[index - 1]?.image ?? EMPTY_IMAGE;

const headBytes = (image: TreeBucketImage, prefix: string): Uint8Array | undefined =>
  image.get(`${prefix}/current.json`);

const rowValue = (rows: TreeRows, id: string): string => {
  const row = rows.get(id);
  return row === undefined ? "absent" : JSON.stringify(row);
};

/** Each `_id` whose rows differ, as `id:expected=…:observed=…`. */
const rowDifferences = (expected: TreeRows, observed: TreeRows): string[] => {
  const ids = new Set([...expected.keys(), ...observed.keys()]);
  return [...ids]
    .filter((id) => !isDeepStrictEqual(expected.get(id), observed.get(id)))
    .toSorted()
    .map((id) => `${id}:expected=${rowValue(expected, id)}:observed=${rowValue(observed, id)}`);
};

/** Failures of the closing read against the oracle over the whole run. */
const closingReadFailures = (run: TreeRun): string[] => {
  if (run.finalRead.kind === "failed") {
    return [`closing read failed with ${run.finalRead.code}`];
  }
  const expected = oracleRows(run);
  if ("failure" in expected) {
    return [expected.failure];
  }
  return rowDifferences(expected.rows, run.finalRead.rows).map(
    (difference) => `closing read:${difference}`,
  );
};

const commitSteps = (run: TreeRun): readonly TreeStep[] =>
  run.steps.filter((step) => step.transition.kind === "commit");

const landedLogCreate = (run: TreeRun, step: TreeStep): boolean =>
  step.applied.some((op) => op.op === "put" && logSeqOf(run.prefix, op.key) !== undefined);

/** JSON round trip, so an entry compares equal to its stored form. */
const asStored = (entry: LogEntry): LogEntry => JSON.parse(JSON.stringify(entry)) as LogEntry;

/** The transition a step ran: a retry runs the transition it retries. */
const effectiveTransition = (run: TreeRun, step: TreeStep): TreeTransition | undefined =>
  step.transition.kind === "retry" ? run.steps[step.transition.of]?.transition : step.transition;

/** Whether the step may publish a root: a fold, a fold publish, or a retried fold. */
const isFoldStep = (run: TreeRun, step: TreeStep): boolean => {
  const kind = effectiveTransition(run, step)?.kind;
  return kind === "fold" || kind === "fold-publish";
};

const isGcStep = (run: TreeRun, step: TreeStep): boolean =>
  effectiveTransition(run, step)?.kind === "gc";

/** The step that captured the head a fold step publishes against. */
const prepareIndexOf = (step: TreeStep): number =>
  step.transition.kind === "fold-publish" ? step.transition.of : step.index;

/** The dense log tail when step `index` started. */
const tailBefore = (run: TreeRun, index: number): number => denseTail(durableLog(run, index - 1));

const publishedRoot = (result: TreeFoldResult): string | null | undefined =>
  result.kind === "published" ? result.root : undefined;

// ---------------------------------------------------------------------
// The eight properties
// ---------------------------------------------------------------------

/**
 * Every acknowledged commit landed as exactly the entry it reported, is
 * still in the bucket while unfolded, and the closing read shows the
 * oracle's row for every `_id` an acknowledged commit wrote. Exercised by
 * an acknowledged commit.
 */
const acknowledgedNeverLost = (run: TreeRun): TreePropertyCheck => {
  const log = durableLog(run);
  const image = lastImage(run);
  const floor = headOf(image, run.prefix)?.log_seq_start ?? 0;
  const evidence: string[] = [];
  const failures: string[] = [];
  const ids = new Set<string>();
  for (const step of commitSteps(run)) {
    if (step.outcome.kind !== "acknowledged") {
      continue;
    }
    const entry = asStored(step.outcome.entry);
    evidence.push(`acknowledged=step-${step.index}@seq-${entry.seq}`);
    ids.add(entry.doc_id);
    if (!isDeepStrictEqual(log.get(entry.seq), entry)) {
      failures.push(
        `step-${step.index}:seq-${entry.seq}:acknowledged but no matching create landed`,
      );
    }
    const stored = image.get(treeLogKey(entry.seq, run.prefix));
    if (
      entry.seq >= floor &&
      (stored === undefined || !isDeepStrictEqual(decodeJsonBytes<LogEntry>(stored), entry))
    ) {
      failures.push(`step-${step.index}:seq-${entry.seq}:missing from the unfolded log`);
    }
  }
  if (ids.size > 0 && failures.length === 0) {
    if (run.finalRead.kind === "failed") {
      failures.push(`closing read failed with ${run.finalRead.code}`);
    } else {
      const expected = oracleRows(run);
      if ("failure" in expected) {
        failures.push(expected.failure);
      } else {
        for (const id of [...ids].toSorted()) {
          if (!isDeepStrictEqual(expected.rows.get(id), run.finalRead.rows.get(id))) {
            failures.push(
              `${id}:expected=${rowValue(expected.rows, id)}:observed=${rowValue(run.finalRead.rows, id)}`,
            );
          }
        }
      }
    }
  }
  return verdict("acknowledged-never-lost", ids.size > 0, evidence, failures);
};

/**
 * No write becomes visible except as its own step's commit.
 *
 * - Every log entry that lands carries the token of the commit step whose
 *   applied ops contain it, and each token lands at most once, so a
 *   duplicate, a resend or a phantom entry is a violation even when its
 *   row looks right.
 * - A commit that was not acknowledged and whose create never landed in
 *   its own step (refused, or crashed or failed before the create applied)
 *   never appears later: no log entry carries its token, and no read shows
 *   a row with its `rev`. A refusal whose create landed is a violation
 *   itself.
 *
 * Exercised by such a commit that reached the bucket with at least one op,
 * so a commit refused before any I/O does not count.
 */
const unacknowledgedNeverVisible = (run: TreeRun): TreePropertyCheck => {
  const evidence: string[] = [];
  const failures: string[] = [];
  const hidden = new Set<string>();
  let exercised = false;
  for (const step of commitSteps(run)) {
    const { kind } = step.outcome;
    if (kind === "acknowledged") {
      continue;
    }
    const landed = landedLogCreate(run, step);
    if (kind === "refused" && landed) {
      failures.push(`step-${step.index}:refused but its create landed`);
    }
    if (!landed) {
      evidence.push(`unacknowledged=step-${step.index}:${kind}:reached=${step.reached}`);
      hidden.add(treeMutationToken(step.index));
      exercised ||= step.reached > 0;
    }
  }
  const landedAt = new Map<string, number>();
  for (const step of run.steps) {
    const own = step.transition.kind === "commit" ? treeMutationToken(step.index) : undefined;
    for (const op of step.applied) {
      const seq = logSeqOf(run.prefix, op.key);
      if (op.op !== "put" || seq === undefined) {
        continue;
      }
      const { origin } = decodeJsonBytes<LogEntry>(op.body);
      if (origin !== own) {
        failures.push(
          `step-${step.index}:seq-${seq}:carries origin ${origin ?? "none"}, not ${own ?? "a commit's"}`,
        );
      }
      if (origin === undefined) {
        continue;
      }
      const earlier = landedAt.get(origin);
      if (earlier === undefined) {
        landedAt.set(origin, seq);
      } else {
        failures.push(`${origin}:landed twice, at seq-${earlier} and seq-${seq}`);
      }
      if (hidden.has(origin)) {
        failures.push(`seq-${seq}:holds unacknowledged ${origin}`);
      }
    }
  }
  const reads: [string, TreeRows][] = run.steps.flatMap((step) =>
    step.outcome.kind === "read"
      ? [[`step-${step.index}`, step.outcome.rows] as [string, TreeRows]]
      : [],
  );
  if (run.finalRead.kind === "read") {
    reads.push(["closing read", run.finalRead.rows]);
  }
  for (const [where, rows] of reads) {
    for (const row of rows.values()) {
      const rev = (row as DocumentData)["rev"];
      if (typeof rev === "string" && hidden.has(rev)) {
        failures.push(`${where}:shows unacknowledged ${rev}`);
      }
    }
  }
  return verdict("unacknowledged-never-visible", exercised, evidence, failures);
};

/**
 * Every read and the closing read equal the oracle over the entries landed
 * so far. Cold reads need no capability, so this runs on every system; a
 * system with a warm reader has its warm reads checked the same way, and
 * the `warm-and-cold-reads-both-run` structural check requires both modes
 * on such a system. Exercised by a read step.
 */
const coldAndWarmEqualReference = (run: TreeRun): TreePropertyCheck => {
  const evidence: string[] = [];
  const failures: string[] = [];
  for (const step of run.steps) {
    if (step.transition.kind !== "read") {
      continue;
    }
    evidence.push(`read=step-${step.index}:${step.transition.mode}`);
    if (step.outcome.kind !== "read") {
      failures.push(`step-${step.index}:read ended ${step.outcome.kind}`);
      continue;
    }
    const expected = oracleRows(run, step.index);
    if ("failure" in expected) {
      failures.push(`step-${step.index}:${expected.failure}`);
      continue;
    }
    for (const difference of rowDifferences(expected.rows, step.outcome.rows)) {
      failures.push(`step-${step.index}:${step.transition.mode}:${difference}`);
    }
  }
  failures.push(...closingReadFailures(run));
  return verdict("cold-and-warm-equal-reference", evidence.length > 0, evidence, failures);
};

/**
 * The folded seq never moves back; the root changes only in a fold step;
 * and after every step the head's root reaches no missing node, so no
 * partly written publication is ever reachable. Exercised by a root
 * change.
 */
const publicationMonotoneNoPartialRun = (
  run: TreeRun,
  oracles: TreeModelOracles,
): TreePropertyCheck => {
  const structure = oracles.structure!;
  const evidence: string[] = [];
  const failures: string[] = [];
  let floor = 0;
  let root: string | null = null;
  for (const step of run.steps) {
    const head = headOf(step.image, run.prefix);
    const nextFloor = head?.log_seq_start ?? 0;
    const nextRoot = rootOf(head);
    if (nextFloor < floor) {
      failures.push(`step-${step.index}:folded seq moved back from ${floor} to ${nextFloor}`);
    }
    if (nextRoot !== root) {
      evidence.push(`root=step-${step.index}:${nextRoot}`);
      if (!isFoldStep(run, step)) {
        failures.push(`step-${step.index}:${step.transition.kind} changed the root`);
      }
    }
    if (nextRoot !== null) {
      for (const key of structure.reachable(step.image, run.prefix, nextRoot).missing) {
        failures.push(`step-${step.index}:root ${nextRoot} reaches missing ${key}`);
      }
    }
    floor = nextFloor;
    root = nextRoot;
  }
  return verdict("publication-monotone-no-partial-run", evidence.length > 0, evidence, failures);
};

/**
 * A fold publish whose captured head was replaced before it published,
 * by another fold, a GC tick or anything else, does not publish and leaves
 * the head exactly as it found it, even if it fails or crashes, so the
 * replacement survives. The head's root then reaches no
 * missing node, and the closing read equals the oracle. Every such publish
 * is checked.
 *
 * Exercised only by a race an overwrite would show in the head: the
 * publish had something to fold, and a step other than a fold replaced
 * the captured head (a GC tick's log retirement, say) or a fold prepared
 * over a different log tail did, so the two publications differ.
 */
const lostCasPreservesWinner = (run: TreeRun, oracles: TreeModelOracles): TreePropertyCheck => {
  const structure = oracles.structure!;
  const evidence: string[] = [];
  const failures: string[] = [];
  let exercised = false;
  const changedHead = (step: TreeStep): boolean =>
    !isDeepStrictEqual(
      headBytes(step.image, run.prefix),
      headBytes(imageBefore(run, step.index), run.prefix),
    );
  for (const step of run.steps) {
    if (step.transition.kind !== "fold-publish" || step.outcome.kind === "skipped") {
      continue;
    }
    const prepare = step.transition.of;
    const captured = headBytes(imageBefore(run, prepare), run.prefix);
    const current = headBytes(imageBefore(run, step.index), run.prefix);
    if (isDeepStrictEqual(captured, current)) {
      continue;
    }
    const replacers = run.steps.slice(prepare + 1, step.index).filter(changedHead);
    const decisive = replacers.some(
      (replacer) =>
        !isFoldStep(run, replacer) ||
        tailBefore(run, prepareIndexOf(replacer)) !== tailBefore(run, prepare),
    );
    // A fold with nothing to fold writes no head, so it cannot show a CAS.
    exercised ||=
      decisive &&
      (step.outcome.kind === "folded"
        ? step.outcome.result.kind !== "nothing-to-fold"
        : step.reached > 0);
    const by = replacers.map(({ index }) => `step-${index}`).join(",");
    evidence.push(
      `race=step-${step.index}:prepared=step-${prepare}:replaced-by=${by}${decisive ? "" : ":same-tail"}`,
    );
    if (step.outcome.kind === "folded" && step.outcome.result.kind === "published") {
      failures.push(`step-${step.index}:published over a head ${by} replaced`);
    }
    if (!isDeepStrictEqual(headBytes(step.image, run.prefix), current)) {
      failures.push(`step-${step.index}:changed the head ${by} left`);
    }
    const root = rootOf(headOf(step.image, run.prefix));
    if (root !== null) {
      for (const key of structure.reachable(step.image, run.prefix, root).missing) {
        failures.push(`step-${step.index}:root ${root} reaches missing ${key}`);
      }
    }
  }
  if (evidence.length > 0) {
    failures.push(...closingReadFailures(run));
  }
  return verdict("lost-cas-preserves-winner", exercised, evidence, failures);
};

/**
 * A GC step deletes no key reachable from the head it started from, the
 * head's root reaches no missing node afterwards, and it retires only log
 * slots below the folded seq. Only deletes of keys that held an object
 * count: deleting an absent key neither exercises nor violates this.
 * Exercised by a GC step that deleted an object.
 */
const reclamationPreservesReachable = (
  run: TreeRun,
  oracles: TreeModelOracles,
): TreePropertyCheck => {
  const structure = oracles.structure!;
  const evidence: string[] = [];
  const failures: string[] = [];
  for (const step of run.steps) {
    if (!isGcStep(run, step)) {
      continue;
    }
    const before = imageBefore(run, step.index);
    const beforeRoot = rootOf(headOf(before, run.prefix));
    const live =
      beforeRoot === null
        ? new Set<string>()
        : structure.reachable(before, run.prefix, beforeRoot).keys;
    const head = headOf(step.image, run.prefix);
    const deleted = step.applied.flatMap((op) =>
      op.op === "delete" && op.existed ? [op.key] : [],
    );
    if (deleted.length > 0) {
      evidence.push(`gc=step-${step.index}:deleted=${deleted.length}`);
    }
    for (const key of deleted) {
      if (live.has(key)) {
        failures.push(`step-${step.index}:deleted reachable ${key}`);
      }
      const seq = logSeqOf(run.prefix, key);
      if (seq !== undefined && seq >= (head?.log_seq_start ?? 0)) {
        failures.push(`step-${step.index}:retired unfolded log slot ${seq}`);
      }
    }
    const root = rootOf(head);
    if (root !== null) {
      for (const key of structure.reachable(step.image, run.prefix, root).missing) {
        failures.push(`step-${step.index}:root ${root} reaches missing ${key}`);
      }
    }
  }
  return verdict("reclamation-preserves-reachable", evidence.length > 0, evidence, failures);
};

/**
 * A retry of a crashed fold or GC step completes (a fold does not lose its
 * CAS, since nothing raced it), a retried fold publishes a root the crashed
 * attempt never wrote (each attempt has a fresh identity), and the closing
 * read equals the oracle. Exercised by a retry that ran; a retry of a crash
 * point that never fired is skipped and does not count.
 */
const recoveryIdempotent = (run: TreeRun): TreePropertyCheck => {
  const evidence: string[] = [];
  const failures: string[] = [];
  for (const step of run.steps) {
    if (step.transition.kind !== "retry" || step.outcome.kind === "skipped") {
      continue;
    }
    const crashed = run.steps[step.transition.of]!;
    evidence.push(`retry=step-${step.index}:of=step-${crashed.index}`);
    const { outcome } = step;
    if (outcome.kind === "folded") {
      if (outcome.result.kind === "cas-lost") {
        failures.push(`step-${step.index}:retried fold lost its CAS`);
      }
      const root = publishedRoot(outcome.result);
      if (
        root !== undefined &&
        root !== null &&
        crashed.applied.some((op) => op.op === "put" && op.key === root)
      ) {
        failures.push(
          `step-${step.index}:published ${root}, which crashed step-${crashed.index} wrote`,
        );
      }
    } else if (outcome.kind !== "collected") {
      failures.push(`step-${step.index}:retry ended ${outcome.kind}`);
    }
  }
  if (evidence.length > 0) {
    failures.push(...closingReadFailures(run));
  }
  return verdict("recovery-idempotent", evidence.length > 0, evidence, failures);
};

/**
 * Once everything committed is folded and then collected, the bucket holds
 * only the head, tree bookkeeping records and nodes the root reaches, and
 * the root reaches no more nodes than the canonical tree for the folded
 * rows has. The second bound comes from the structure oracle's
 * {@link TreeStructureOracle.canonicalNodeCount}, not from a row or byte
 * estimate, so a redundant reachable node is caught as surely as an
 * unreachable leftover. Together they bound the object count by the live
 * rows, not by the writes that produced them.
 *
 * Exercised when, after the last commit, a fold published or found nothing
 * to fold, a GC tick then completed, and the head's folded seq is the log
 * tail.
 */
const objectCountBounded = (run: TreeRun, oracles: TreeModelOracles): TreePropertyCheck => {
  const structure = oracles.structure!;
  const failures: string[] = [];
  const lastCommit = run.steps.findLastIndex((step) => step.transition.kind === "commit");
  const lastFold = run.steps.findLastIndex(
    (step) =>
      isFoldStep(run, step) &&
      step.outcome.kind === "folded" &&
      step.outcome.result.kind !== "cas-lost",
  );
  const lastGc = run.steps.findLastIndex(
    (step) => isGcStep(run, step) && step.outcome.kind === "collected",
  );
  const image = lastImage(run);
  const head = headOf(image, run.prefix);
  const floor = head?.log_seq_start ?? 0;
  const exercised =
    lastCommit < lastFold && lastFold < lastGc && floor === denseTail(durableLog(run));
  const evidence = [`objects=${image.size}`, `folded-through=${floor}`];
  if (!exercised) {
    return verdict("object-count-bounded", false, evidence, failures);
  }
  const root = rootOf(head);
  const allowed = new Set([`${run.prefix}/current.json`, ...structure.bookkeepingKeys(run.prefix)]);
  const reachable =
    root === null ? new Set<string>() : structure.reachable(image, run.prefix, root).keys;
  for (const key of reachable) {
    allowed.add(key);
  }
  for (const key of image.keys()) {
    const seq = logSeqOf(run.prefix, key);
    if (!allowed.has(key) && (seq === undefined || seq < floor)) {
      failures.push(`unbounded residue ${key}`);
    }
  }
  const folded = oracleRows(run, run.steps.length - 1, floor);
  if ("failure" in folded) {
    failures.push(folded.failure);
  } else {
    const canonical = structure.canonicalNodeCount(folded.rows);
    evidence.push(`reachable=${reachable.size}`, `canonical=${canonical}`);
    if (reachable.size > canonical) {
      failures.push(
        `the root reaches ${reachable.size} nodes; the canonical tree for ${folded.rows.size} rows has ${canonical}`,
      );
    }
  }
  return verdict("object-count-bounded", true, evidence, failures);
};

/** The eight properties, in {@link TREE_PROPERTY_NAMES} order. */
export const TREE_PROPERTIES: readonly TreeProperty[] = [
  {
    name: "acknowledged-never-lost",
    requires: [],
    needsStructure: false,
    check: acknowledgedNeverLost,
  },
  {
    name: "unacknowledged-never-visible",
    requires: [],
    needsStructure: false,
    check: unacknowledgedNeverVisible,
  },
  {
    name: "cold-and-warm-equal-reference",
    requires: [],
    needsStructure: false,
    check: coldAndWarmEqualReference,
  },
  {
    name: "publication-monotone-no-partial-run",
    requires: ["fold"],
    needsStructure: true,
    check: publicationMonotoneNoPartialRun,
  },
  {
    name: "lost-cas-preserves-winner",
    requires: ["fold"],
    needsStructure: true,
    check: lostCasPreservesWinner,
  },
  {
    name: "reclamation-preserves-reachable",
    requires: ["gc"],
    needsStructure: true,
    check: reclamationPreservesReachable,
  },
  {
    name: "recovery-idempotent",
    requires: [],
    requiresOneOf: ["fold", "gc"],
    needsStructure: false,
    check: recoveryIdempotent,
  },
  {
    name: "object-count-bounded",
    requires: ["fold", "gc"],
    needsStructure: true,
    check: objectCountBounded,
  },
];

/** The property named `name`. */
export const treeProperty = (name: TreePropertyName): TreeProperty =>
  TREE_PROPERTIES.find((property) => property.name === name)!;

/** Whether `property` can be evaluated with these capabilities and oracles. */
export const isEvaluable = (
  property: TreeProperty,
  capabilities: ReadonlySet<TreeCapability>,
  oracles: TreeModelOracles,
): boolean =>
  property.requires.every((cap) => capabilities.has(cap)) &&
  (property.requiresOneOf === undefined ||
    property.requiresOneOf.some((cap) => capabilities.has(cap))) &&
  (!property.needsStructure || oracles.structure !== undefined);

/** Check every property `run` and `oracles` can evaluate. */
export const checkTreeProperties = (
  run: TreeRun,
  oracles: TreeModelOracles = {},
): readonly TreePropertyCheck[] =>
  TREE_PROPERTIES.filter((property) => isEvaluable(property, run.capabilities, oracles)).map(
    (property) => property.check(run, oracles),
  );

// ---------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------

export const TREE_STRUCTURAL_CHECK_NAMES = [
  "every-evaluable-property-is-exercised",
  "every-crash-boundary-fires",
  "warm-and-cold-reads-both-run",
  "publications-both-win-and-lose-cas",
] as const;

export type TreeStructuralCheckName = (typeof TREE_STRUCTURAL_CHECK_NAMES)[number];

/** Whether a set of runs reached one kind of state. */
export interface TreeStructuralCheck {
  readonly name: TreeStructuralCheckName;
  readonly ok: boolean;
  readonly evidence: readonly string[];
}

const STRUCTURAL_REQUIRES: {
  readonly [Name in TreeStructuralCheckName]: readonly TreeCapability[];
} = {
  "every-evaluable-property-is-exercised": [],
  "every-crash-boundary-fires": [],
  "warm-and-cold-reads-both-run": ["warm-read"],
  "publications-both-win-and-lose-cas": ["fold"],
};

const setsEqual = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

const STRUCTURAL_CHECKS: {
  readonly [Name in TreeStructuralCheckName]: (
    runs: readonly TreeRun[],
    oracles: TreeModelOracles,
  ) => { readonly ok: boolean; readonly evidence: readonly string[] };
} = {
  "every-evaluable-property-is-exercised": (runs, oracles) => {
    const exercised = new Set<TreePropertyName>();
    for (const run of runs) {
      for (const check of checkTreeProperties(run, oracles)) {
        if (check.exercised) {
          exercised.add(check.name);
        }
      }
    }
    const expected = TREE_PROPERTIES.filter((property) =>
      isEvaluable(property, runs[0]!.capabilities, oracles),
    ).map(({ name }) => name);
    const missing = expected.filter((name) => !exercised.has(name));
    return {
      ok: missing.length === 0,
      evidence: [
        ...[...exercised].toSorted().map((name) => `exercised=${name}`),
        ...missing.map((name) => `missing=${name}`),
      ],
    };
  },
  "every-crash-boundary-fires": (runs) => {
    const { capabilities } = runs[0]!;
    const kinds = ["commit", ...(["fold", "gc"] as const).filter((kind) => capabilities.has(kind))];
    const expected = new Set(
      kinds.flatMap((kind) => ["before", "after"].map((boundary) => `${kind}/${boundary}`)),
    );
    const fired = new Set<string>();
    for (const run of runs) {
      for (const step of run.steps) {
        const crash = crashOf(step.transition);
        if (crash !== undefined && step.crashFired) {
          fired.add(`${step.transition.kind}/${crash.boundary}`);
        }
      }
    }
    return {
      ok: setsEqual(fired, expected),
      evidence: [
        ...[...fired].toSorted().map((id) => `fired=${id}`),
        ...[...expected].filter((id) => !fired.has(id)).map((id) => `missing=${id}`),
      ],
    };
  },
  "warm-and-cold-reads-both-run": (runs) => {
    const modes = new Set<string>();
    for (const run of runs) {
      for (const step of run.steps) {
        if (step.outcome.kind === "read") {
          modes.add(step.outcome.mode);
        }
      }
    }
    return {
      ok: setsEqual(modes, new Set(["cold", "warm"])),
      evidence: [...modes].toSorted().map((mode) => `read=${mode}`),
    };
  },
  "publications-both-win-and-lose-cas": (runs) => {
    const results = new Set<string>();
    for (const run of runs) {
      for (const step of run.steps) {
        if (step.outcome.kind === "folded" && step.outcome.result.kind !== "nothing-to-fold") {
          results.add(step.outcome.result.kind);
        }
      }
    }
    return {
      ok: setsEqual(results, new Set(["published", "cas-lost"])),
      evidence: [...results].toSorted().map((result) => `publish=${result}`),
    };
  },
};

/**
 * The structural checks that apply to the system `runs` came from: what
 * the runs, taken together, reached. A safety result over runs that fail
 * one of these is vacuous for the property it starves. All runs must come
 * from systems with the same capabilities; mixing them throws.
 */
export const checkTreeStructure = (
  runs: readonly TreeRun[],
  oracles: TreeModelOracles = {},
): readonly TreeStructuralCheck[] => {
  if (runs.length === 0) {
    return TREE_STRUCTURAL_CHECK_NAMES.map((name) => ({ name, ok: false, evidence: ["no runs"] }));
  }
  const { capabilities } = runs[0]!;
  for (const run of runs) {
    if (!setsEqual(run.capabilities, capabilities)) {
      throw new Error(
        `checkTreeStructure: run of ${JSON.stringify(run.system)} has capabilities [${[...run.capabilities].join(",")}], not [${[...capabilities].join(",")}]`,
      );
    }
  }
  return TREE_STRUCTURAL_CHECK_NAMES.filter((name) =>
    STRUCTURAL_REQUIRES[name].every((cap) => capabilities.has(cap)),
  ).map((name) => {
    const { ok, evidence } = STRUCTURAL_CHECKS[name](runs, oracles);
    return { name, ok, evidence };
  });
};

// ---------------------------------------------------------------------
// Mutation schedules
// ---------------------------------------------------------------------

/**
 * Where a mutant attaches. `system` wraps a whole system factory; the
 * others replace one step of the tree implementation through its internal
 * `steps` override.
 */
export type TreeMutantSeam = "system" | "publish-steps" | "read-steps" | "gc-steps";

/**
 * A schedule and a single defect that must turn `property` red on it. The
 * unmutated run must exercise `property` and violate nothing; the mutated
 * run must exercise and violate `property`, and may violate only the
 * properties in `collateral` besides.
 */
export interface TreeMutationSchedule {
  readonly property: TreePropertyName;
  readonly mutant: {
    readonly name: string;
    readonly seam: TreeMutantSeam;
    readonly defect: string;
  };
  /** Properties the defect may also break: the ones that read what it corrupts. */
  readonly collateral: readonly TreePropertyName[];
  readonly schedule: readonly TreeTransition[];
}

/** The prefix tree nodes are stored under. */
const NODE_PREFIX = treeNodeKeyPrefix(TREE_MODEL_PREFIX);

const commit = (op: "I" | "U", docId: string, value: number): TreeTransition => ({
  kind: "commit",
  op,
  docId,
  value,
});

/**
 * An insert the `Writer` refuses before any I/O (`_id` may not start with
 * `_`).
 */
export const TREE_REFUSED_COMMIT: TreeTransition = commit("I", "_refused", 0);

/**
 * A commit whose `log/<seq>` create aborts before it reaches the bucket,
 * after the commit has read the head and probed the tail.
 */
const crashedCommit = (docId: string, value: number): TreeTransition => ({
  kind: "commit",
  op: "I",
  docId,
  value,
  crash: { boundary: "before", nth: 1, target: logCreateTarget() },
});

/** A fold that has written its nodes and dies before its head CAS. */
const foldCrashedBeforeHeadCas: TreeTransition = {
  kind: "fold",
  crash: {
    boundary: "before",
    nth: 1,
    target: { prefix: TREE_MODEL_CURRENT_JSON_KEY, ops: ["put"] },
  },
};

const coldRead: TreeTransition = { kind: "read", mode: "cold" };

/** At least one schedule per property, in {@link TREE_PROPERTY_NAMES} order. */
export const TREE_MUTATION_SCHEDULES: readonly TreeMutationSchedule[] = [
  {
    property: "acknowledged-never-lost",
    mutant: {
      name: "ack-without-create",
      seam: "system",
      defect: "acknowledges a commit that was refused or failed",
    },
    collateral: [],
    schedule: [
      commit("I", "a", 1),
      TREE_REFUSED_COMMIT,
      crashedCommit("b", 2),
      commit("U", "a", 3),
      coldRead,
    ],
  },
  {
    property: "unacknowledged-never-visible",
    mutant: {
      name: "resend-crashed-commit",
      seam: "system",
      defect: "resends a failed commit before the next one",
    },
    collateral: [],
    schedule: [
      commit("I", "a", 1),
      TREE_REFUSED_COMMIT,
      crashedCommit("b", 2),
      commit("I", "c", 3),
      coldRead,
    ],
  },
  {
    property: "unacknowledged-never-visible",
    mutant: {
      name: "double-commit",
      seam: "system",
      defect: "commits every input twice",
    },
    collateral: [],
    schedule: [commit("I", "a", 1), crashedCommit("b", 2), commit("U", "a", 3), coldRead],
  },
  {
    property: "unacknowledged-never-visible",
    mutant: {
      name: "resend-acknowledged-write",
      seam: "system",
      defect: "re-sends an earlier acknowledged update after a later commit",
    },
    collateral: [],
    schedule: [
      commit("I", "a", 1),
      commit("U", "a", 2),
      crashedCommit("b", 3),
      commit("U", "a", 4),
      coldRead,
    ],
  },
  {
    property: "cold-and-warm-equal-reference",
    mutant: {
      name: "cold-read-skips-newest-entry",
      seam: "system",
      defect: "the cold reader leaves out the newest unfolded entry",
    },
    collateral: [],
    // The closing read skips only the delete of an absent `_id`, which
    // changes no row, so only the intermediate read can show the defect.
    schedule: [
      commit("I", "a", 1),
      commit("I", "b", 2),
      coldRead,
      { kind: "commit", op: "D", docId: "z" },
    ],
  },
  {
    property: "cold-and-warm-equal-reference",
    mutant: {
      name: "warm-reader-keeps-first-root",
      seam: "read-steps",
      defect: "the warm reader never re-reads the head after its first read",
    },
    collateral: [],
    schedule: [
      commit("I", "a", 1),
      commit("I", "b", 2),
      { kind: "fold" },
      { kind: "read", mode: "warm" },
      commit("U", "a", 3),
      { kind: "commit", op: "D", docId: "b" },
      { kind: "fold" },
      { kind: "gc" },
      { kind: "gc" },
      { kind: "read", mode: "warm" },
      coldRead,
    ],
  },
  {
    property: "publication-monotone-no-partial-run",
    mutant: {
      name: "head-cas-before-node-puts",
      seam: "publish-steps",
      defect: "CASes the head before writing the nodes it references",
    },
    // The partly written root is what the closing read walks.
    collateral: ["acknowledged-never-lost", "cold-and-warm-equal-reference"],
    schedule: [
      commit("I", "a", 1),
      { kind: "fold" },
      commit("I", "b", 2),
      { kind: "fold", crash: { boundary: "before", nth: 1, target: { prefix: NODE_PREFIX } } },
    ],
  },
  {
    property: "lost-cas-preserves-winner",
    mutant: {
      name: "head-put-ignores-cas",
      seam: "publish-steps",
      defect: "writes the head without If-Match",
    },
    // The overwrite puts the loser's lower folded seq back on the head.
    collateral: ["publication-monotone-no-partial-run"],
    schedule: [
      commit("I", "a", 1),
      commit("I", "b", 2),
      { kind: "fold-prepare" },
      commit("I", "c", 3),
      { kind: "fold" },
      { kind: "fold-publish", of: 2 },
    ],
  },
  {
    property: "lost-cas-preserves-winner",
    mutant: {
      name: "head-put-ignores-cas",
      seam: "publish-steps",
      defect: "writes the head without If-Match",
    },
    // A GC tick writes the head (its log retirement) between the prepare
    // and the publish; the commit before the prepare gives the fold
    // something to publish. An overwrite puts back a head the GC tick
    // already judged, so nodes it collected as unreachable may become the
    // root's.
    collateral: [
      "acknowledged-never-lost",
      "cold-and-warm-equal-reference",
      "publication-monotone-no-partial-run",
    ],
    schedule: [
      commit("I", "a", 1),
      { kind: "fold" },
      commit("I", "b", 2),
      { kind: "fold-prepare" },
      { kind: "gc" },
      { kind: "fold-publish", of: 3 },
    ],
  },
  {
    property: "reclamation-preserves-reachable",
    mutant: {
      name: "gc-ignores-live-root",
      seam: "gc-steps",
      defect: "treats every listed node as unreachable",
    },
    // Deleted live nodes leave the head's root reaching missing nodes,
    // which the closing read walks.
    collateral: [
      "acknowledged-never-lost",
      "cold-and-warm-equal-reference",
      "publication-monotone-no-partial-run",
    ],
    schedule: [
      commit("I", "a", 1),
      { kind: "fold" },
      commit("U", "a", 2),
      { kind: "fold" },
      { kind: "gc" },
      { kind: "gc" },
    ],
  },
  {
    property: "recovery-idempotent",
    mutant: {
      name: "resume-reuses-crashed-attempt-identity",
      seam: "publish-steps",
      defect: "a resumed fold publishes under the crashed attempt's identity",
    },
    collateral: [],
    schedule: [
      commit("I", "a", 1),
      commit("I", "b", 2),
      foldCrashedBeforeHeadCas,
      { kind: "retry", of: 2 },
    ],
  },
  {
    property: "object-count-bounded",
    mutant: {
      name: "gc-never-sweeps-orphans",
      seam: "gc-steps",
      defect: "deletes nothing a crashed or superseded publication left",
    },
    collateral: [],
    schedule: [
      commit("I", "a", 1),
      commit("I", "b", 2),
      foldCrashedBeforeHeadCas,
      { kind: "retry", of: 2 },
      commit("U", "a", 3),
      { kind: "fold" },
      { kind: "gc" },
      { kind: "gc" },
    ],
  },
];
