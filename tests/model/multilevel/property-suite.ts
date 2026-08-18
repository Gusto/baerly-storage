import type * as fc from "fast-check";
import {
  canonicalModelCoverageScenarios,
  enumerateModelCrashSchedules,
  modelDerivedCrashScheduleSourceOperations,
  modelScenarioArbitrary,
  modelScenarioWithDroppedAppendArbitrary,
  type ModelScenario,
} from "./arbitraries.ts";
import {
  executeModelOperation,
  initialModelState,
  runModelSchedule,
  type ModelRun,
} from "./executor.ts";
import { checkModelSafetyProperty } from "./invariants.ts";
import { classifyModelRejectedArm, MODEL_REJECTED_ARMS } from "./rejected-arms.ts";
import {
  DEFAULT_MODEL_ASSUMPTIONS,
  validateModelFullSuiteAssumptions,
  type ModelWorkloadAssumptions,
} from "./types.ts";

/**
 * Escape hatch that discharges every prefix-skip rule at once. Read once, since
 * {@link modelSafetyCanChangeAtPrefix} runs per prefix per property.
 */
const MODEL_PREFIX_SKIP_DISABLED = process.env["MODEL_NO_PREFIX_SKIP"] === "1";

/**
 * Safety properties: evaluated over prefixes of each selected derived failure
 * schedule — every prefix for four of them, and the prefixes that can move the
 * subject for the rest, per {@link modelSafetyCanChangeAtPrefix}. These share
 * one expensive set of runs per scenario.
 */
export const MODEL_SAFETY_PROPERTY_NAMES = [
  "acknowledged-mutations-never-lost",
  "unacknowledged-mutations-never-visible",
  "cold-and-warm-equal-reference-replay",
  "publication-monotone-no-partial-run",
  "lost-cas-preserves-winning-lineage",
  "reclamation-preserves-reachable-objects",
  "recovery-idempotent-after-every-crash-point",
  "total-object-count-is-bounded",
] as const;

/**
 * Structural properties: assert the generator actually reaches the states the
 * safety properties constrain, without which the safety results are vacuous.
 */
export const MODEL_STRUCTURAL_PROPERTY_NAMES = [
  "every-durable-operation-is-a-crash-boundary",
  "every-publication-can-win-or-lose-cas",
  "tail-fold-and-base-merge-run-in-both-orders",
  "every-rejected-arm-is-exercised",
] as const;

export type ModelSafetyPropertyName = (typeof MODEL_SAFETY_PROPERTY_NAMES)[number];
export type ModelStructuralPropertyName = (typeof MODEL_STRUCTURAL_PROPERTY_NAMES)[number];

export const MODEL_PROPERTY_NAMES = [
  ...MODEL_SAFETY_PROPERTY_NAMES,
  ...MODEL_STRUCTURAL_PROPERTY_NAMES,
] as const;

export type ModelPropertyName = (typeof MODEL_PROPERTY_NAMES)[number];

/**
 * Membership test for the safety half. Derived from the declared list above so
 * that classification can never drift from a `slice(0, 8)` index repeated at
 * the call site.
 */
const MODEL_SAFETY_NAME_SET: ReadonlySet<ModelPropertyName> = new Set(MODEL_SAFETY_PROPERTY_NAMES);

export const isModelSafetyProperty = (name: ModelPropertyName): name is ModelSafetyPropertyName =>
  MODEL_SAFETY_NAME_SET.has(name);

export interface ModelPropertyCheck {
  readonly name: ModelPropertyName;
  readonly ok: boolean;
  readonly evidence: readonly string[];
}

export interface ModelPropertyDefinition {
  readonly name: ModelPropertyName;
  readonly arbitrary: fc.Arbitrary<ModelScenario>;
  readonly check: (scenario: ModelScenario) => ModelPropertyCheck;
}

function modelPropertyCheck(
  name: ModelPropertyName,
  ok: boolean,
  evidence: readonly string[],
): ModelPropertyCheck {
  return { name, ok, evidence };
}

function modelSetsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function modelCrashableEffectIds(runs: readonly ModelRun[]): ReadonlySet<string> {
  const effectIds = new Set<string>();
  for (const run of runs) {
    for (const transition of run.transitions) {
      const operation = transition.operation;
      for (const effectIndex of transition.durableEffects.keys()) {
        const wasDurable = transition.state.store.durableTrace.some(
          (entry) =>
            entry.operationId === operation.operationId &&
            entry.effectIndex === effectIndex &&
            (entry.outcome === "applied" || entry.outcome === "crashed-after"),
        );
        if (!wasDurable) {
          continue;
        }
        effectIds.add(`${operation.operationId}/${effectIndex}`);
      }
    }
  }
  return effectIds;
}

function checkModelCrashStructure(runs: readonly ModelRun[]): ModelPropertyCheck {
  const effectIds = modelCrashableEffectIds(runs);
  const boundaries = new Set(runs.flatMap(({ final }) => [...final.coverage.crashBoundaries]));
  const missing: string[] = [];
  for (const effectId of effectIds) {
    for (const boundary of ["before", "after"] as const) {
      const crashId = `${effectId}/${boundary}`;
      if (!boundaries.has(crashId)) {
        missing.push(`missing=${crashId}`);
      }
    }
  }
  return modelPropertyCheck(
    "every-durable-operation-is-a-crash-boundary",
    effectIds.size > 0 && missing.length === 0,
    [...[...effectIds].toSorted().map((effectId) => `durable-effect=${effectId}`), ...missing],
  );
}

function checkModelPublicationStructure(runs: readonly ModelRun[]): ModelPropertyCheck {
  const outcomes = new Set(runs.flatMap(({ final }) => [...final.coverage.publicationOutcomes]));
  const expected = new Set(["win", "lose"] as const);
  return modelPropertyCheck(
    "every-publication-can-win-or-lose-cas",
    modelSetsEqual(outcomes, expected),
    [...outcomes].toSorted().map((outcome) => `publication=${outcome}`),
  );
}

function checkModelMaintenanceStructure(runs: readonly ModelRun[]): ModelPropertyCheck {
  const orders = new Set(runs.flatMap(({ final }) => [...final.coverage.maintenanceOrders]));
  const expected = new Set(["tail-before-base", "base-before-tail"] as const);
  return modelPropertyCheck(
    "tail-fold-and-base-merge-run-in-both-orders",
    modelSetsEqual(orders, expected),
    [...orders].toSorted().map((order) => `maintenance-order=${order}`),
  );
}

function checkModelRejectedStructure(runs: readonly ModelRun[]): ModelPropertyCheck {
  const rejected = new Set<string>();
  const failures: string[] = [];
  const evidence: string[] = [];
  for (const run of runs) {
    let previous = run.initial;
    for (const transition of run.transitions) {
      const classification = classifyModelRejectedArm(previous, transition.operation);
      if (transition.outcome === "rejected") {
        const rejectionId = transition.rejectionId;
        if (rejectionId === null) {
          failures.push(`rejection-without-evidence=${transition.operation.operationId}`);
        } else if (!transition.state.coverage.rejectedArms.has(rejectionId)) {
          failures.push(
            `rejection-evidence-mismatch=${transition.operation.operationId}:${rejectionId}`,
          );
        } else if (classification === null) {
          failures.push(
            `unclassified-rejection=${transition.operation.operationId}:${rejectionId}`,
          );
        } else if (rejectionId !== classification) {
          failures.push(
            `rejection-id-mismatch=${transition.operation.operationId}:classified=${classification}:actual=${rejectionId}`,
          );
        } else {
          rejected.add(rejectionId);
          evidence.push(`rejected-arm=${rejectionId}:evidence=${rejectionId}`);
        }
      }
      previous = transition.state;
    }
  }
  const expected = new Set<string>(MODEL_REJECTED_ARMS);
  for (const rejection of expected) {
    if (!rejected.has(rejection)) {
      failures.push(`missing-rejected-arm=${rejection}`);
    }
  }
  for (const rejection of rejected) {
    if (!expected.has(rejection)) {
      failures.push(`unexpected-rejected-arm=${rejection}`);
    }
  }
  return modelPropertyCheck(
    "every-rejected-arm-is-exercised",
    modelSetsEqual(rejected, expected) && failures.length === 0,
    [...evidence.toSorted(), ...failures],
  );
}

/**
 * One check per structural property name. Keyed rather than an array so a caller
 * that wants a single property runs a single walk — `checkModelRejectedStructure`
 * alone re-derives reachability for every transition — and so the four names and
 * the four checks cannot drift apart without a compile error.
 */
const MODEL_STRUCTURAL_CHECKS: {
  readonly [Name in ModelStructuralPropertyName]: (runs: readonly ModelRun[]) => ModelPropertyCheck;
} = {
  "every-durable-operation-is-a-crash-boundary": checkModelCrashStructure,
  "every-publication-can-win-or-lose-cas": checkModelPublicationStructure,
  "tail-fold-and-base-merge-run-in-both-orders": checkModelMaintenanceStructure,
  "every-rejected-arm-is-exercised": checkModelRejectedStructure,
};

export const checkModelStructure = (runs: readonly ModelRun[]): readonly ModelPropertyCheck[] =>
  MODEL_STRUCTURAL_PROPERTY_NAMES.map((name) => MODEL_STRUCTURAL_CHECKS[name](runs));

function runModelScenario(scenario: ModelScenario): ModelRun {
  return runModelSchedule(initialModelState(scenario.assumptions), scenario.operations);
}

interface ModelRunTrieNode {
  readonly run: ModelRun;
  readonly children: Map<string, ModelRunTrieNode>;
}

function runModelScenariosWithSharedPrefixes(
  scenarios: readonly ModelScenario[],
): readonly ModelRun[] {
  const first = scenarios[0];
  if (first === undefined) {
    return [];
  }
  const initial = initialModelState(first.assumptions);
  const root: ModelRunTrieNode = {
    run: { initial, final: initial, transitions: [] },
    children: new Map(),
  };
  return scenarios.map((scenario) => {
    let node = root;
    for (const operation of scenario.operations) {
      const key = JSON.stringify(operation);
      let child = node.children.get(key);
      if (child === undefined) {
        const transition = executeModelOperation(node.run.final, operation);
        child = {
          run: {
            initial,
            final: transition.state,
            transitions: [...node.run.transitions, transition],
          },
          children: new Map(),
        };
        node.children.set(key, child);
      }
      node = child;
    }
    return node.run;
  });
}

function modelCrashEvidenceRuns(scenario: ModelScenario): readonly ModelRun[] {
  const boundarySchedules = enumerateModelCrashSchedules(scenario).map((schedule) => {
    const retryIndex = schedule.operations.findIndex(({ kind }) => kind === "retry");
    return {
      assumptions: schedule.assumptions,
      // Structural coverage is recorded by the crashed target. Its retry and unrelated suffix
      // cannot add evidence for this boundary, so do not replay them for the structure property.
      operations: schedule.operations.slice(0, retryIndex),
    };
  });
  return runModelScenariosWithSharedPrefixes(boundarySchedules);
}

const modelCanonicalRunCache = new WeakMap<
  ModelWorkloadAssumptions,
  { readonly source: readonly ModelRun[]; readonly crash: readonly ModelRun[] }
>();

function modelCanonicalRuns(
  assumptions: ModelWorkloadAssumptions,
  includeCrashSchedules: boolean,
): readonly ModelRun[] {
  let cached = modelCanonicalRunCache.get(assumptions);
  if (cached === undefined) {
    const scenarios = canonicalModelCoverageScenarios(assumptions);
    const source = scenarios.map(runModelScenario);
    cached = { source, crash: scenarios.flatMap(modelCrashEvidenceRuns) };
    modelCanonicalRunCache.set(assumptions, cached);
  }
  return includeCrashSchedules ? [...cached.source, ...cached.crash] : cached.source;
}

function modelStructuralRuns(
  scenario: ModelScenario,
  includeCrashSchedules: boolean,
): readonly ModelRun[] {
  const sourceRun = runModelScenario(scenario);
  const runs = [sourceRun, ...modelCanonicalRuns(scenario.assumptions, includeCrashSchedules)];
  if (includeCrashSchedules) {
    runs.push(...modelCrashEvidenceRuns(scenario));
  }
  return runs;
}

function modelRunPrefix(run: ModelRun, length: number): ModelRun {
  return {
    initial: run.initial,
    final: length === 0 ? run.initial : (run.transitions[length - 1]?.state ?? run.initial),
    transitions: run.transitions.slice(0, length),
  };
}

/**
 * Whether a prefix ending in this transition can change the named property, and
 * so whether the prefix has to be re-evaluated rather than inheriting the
 * preceding proof.
 *
 * Every rule here is a hand proof that nothing verifies, and a wrong one hides
 * a counterexample instead of reporting it. The four properties that fall
 * through to `default` are deliberately left exhaustive: their subjects are the
 * whole reconstructed view and the whole object set, which `reclaim`, `crash`,
 * and `reconstruct` — the very operations a skip rule would elide — are the
 * operations most able to move. A transient violation that later heals is a
 * real counterexample, and only prefix checking can see it, so buying wall
 * clock here would be buying it out of the result the study reports.
 *
 * The prefix counts each property actually reaches are pinned in
 * `properties.test.ts`, so narrowing this function shows up as coverage loss.
 * Set `MODEL_NO_PREFIX_SKIP=1` to discharge the hand proofs by checking every
 * prefix of every property; a run that stays green under it is evidence the
 * rules below skip nothing that mattered. Do that after changing one.
 */
function modelSafetyCanChangeAtPrefix(
  name: ModelPropertyName,
  run: ModelRun,
  length: number,
): boolean {
  if (MODEL_PREFIX_SKIP_DISABLED || length === 0 || length === run.transitions.length) {
    return true;
  }
  const transition = run.transitions[length - 1];
  const operation = transition?.operation;
  switch (name) {
    case "publication-monotone-no-partial-run": {
      return (
        operation?.kind === "publish-root" ||
        operation?.kind === "lose-publication-cas" ||
        operation?.kind === "retry"
      );
    }
    case "lost-cas-preserves-winning-lineage": {
      return (
        operation?.kind === "lose-publication-cas" ||
        (operation?.kind === "retry" && transition?.outcome === "cas-lost")
      );
    }
    case "reclamation-preserves-reachable-objects": {
      return operation?.kind === "reclaim";
    }
    case "recovery-idempotent-after-every-crash-point": {
      return operation?.kind === "retry";
    }
    default: {
      return true;
    }
  }
}

interface ModelSafetyPrefixResult {
  readonly check: ModelPropertyCheck;
  /**
   * Prefixes actually evaluated, not prefixes available. The two differ for the
   * properties {@link modelSafetyCanChangeAtPrefix} can skip, and the report
   * records this rather than the schedule length so a green study never claims
   * coverage it did not perform.
   */
  readonly checkedPrefixes: number;
}

function checkModelSafetyPrefixes(
  name: ModelPropertyName,
  scenario: ModelScenario,
  run: ModelRun,
  assumptions: ModelWorkloadAssumptions,
): ModelSafetyPrefixResult {
  const checkPrefix = (length: number, requireNamedEvidence: boolean): ModelPropertyCheck => {
    if (name === "total-object-count-is-bounded") {
      const maximum = scenario.assumptions.maxScheduleOperations;
      const derivedSourceOperations = modelDerivedCrashScheduleSourceOperations(scenario);
      const sourceOperations = derivedSourceOperations ?? length;
      if (sourceOperations > maximum) {
        return modelPropertyCheck(name, false, [
          `assumption-violation:sourceScheduleOperations=${sourceOperations} exceeds maxScheduleOperations=${maximum}`,
        ]);
      }
      if (derivedSourceOperations !== null && length > maximum + 2) {
        return modelPropertyCheck(name, false, [
          `assumption-violation:derivedScheduleOperations=${length} exceeds maxScheduleOperations+2=${maximum + 2}`,
        ]);
      }
    }
    return checkModelSafetyProperty(
      name,
      modelRunPrefix(run, length),
      assumptions,
      requireNamedEvidence,
    );
  };
  let checkedPrefixes = 1;
  let last = checkPrefix(0, false);
  if (!last.ok) {
    return {
      check: { ...last, evidence: last.evidence.map((entry) => `prefix=0:${entry}`) },
      checkedPrefixes,
    };
  }
  for (let length = 1; length <= run.transitions.length; length += 1) {
    // These invariants are monotone over immutable recorded transitions. Prefixes whose newly
    // appended operation cannot add their subject reuse the preceding successful proof.
    if (!modelSafetyCanChangeAtPrefix(name, run, length)) {
      continue;
    }
    checkedPrefixes += 1;
    const result = checkPrefix(length, length === run.transitions.length);
    last = result;
    if (!result.ok) {
      return {
        check: {
          ...result,
          evidence: result.evidence.map((entry) => `prefix=${length}:${entry}`),
        },
        checkedPrefixes,
      };
    }
  }
  return { check: last, checkedPrefixes };
}

interface ModelSafetyRun {
  readonly scenario: ModelScenario;
  readonly run: ModelRun;
}

function checkModelSafetyRuns(
  name: ModelPropertyName,
  runs: readonly ModelSafetyRun[],
): ModelPropertyCheck {
  const failures: string[] = [];
  const evidence = new Set<string>();
  for (const [index, { scenario, run }] of runs.entries()) {
    const { check: result, checkedPrefixes } = checkModelSafetyPrefixes(
      name,
      scenario,
      run,
      scenario.assumptions,
    );
    evidence.add(`schedule-length=${run.transitions.length}:checked-prefixes=${checkedPrefixes}`);
    if (index === 0) {
      for (const entry of result.evidence) {
        evidence.add(entry);
      }
    }
    if (!result.ok) {
      failures.push(
        ...result.evidence.map((entry) => (index === 0 ? entry : `schedule=${index}:${entry}`)),
      );
    }
  }
  return modelPropertyCheck(name, failures.length === 0, [...evidence, ...failures]);
}

function modelSafetyRuns(scenario: ModelScenario): readonly ModelSafetyRun[] {
  const scenarios = [scenario, ...enumerateModelCrashSchedules(scenario)];
  const runs = runModelScenariosWithSharedPrefixes(scenarios);
  return scenarios.map((runScenario, index) => ({
    scenario: runScenario,
    run: runs[index] as ModelRun,
  }));
}

function checkModelSafetySchedules(
  name: ModelPropertyName,
  scenario: ModelScenario,
): ModelPropertyCheck {
  return checkModelSafetyRuns(name, modelSafetyRuns(scenario));
}

const MODEL_SAFETY_CACHE_LIMIT = 10_000;

function checkOneModelProperty(
  name: ModelPropertyName,
  scenario: ModelScenario,
): ModelPropertyCheck {
  if (isModelSafetyProperty(name)) {
    return checkModelSafetySchedules(name, scenario);
  }
  const needsCrashSchedules = name === "every-durable-operation-is-a-crash-boundary";
  return MODEL_STRUCTURAL_CHECKS[name](modelStructuralRuns(scenario, needsCrashSchedules));
}

export const modelPropertyDefinitions = (
  assumptions: ModelWorkloadAssumptions = DEFAULT_MODEL_ASSUMPTIONS,
): readonly ModelPropertyDefinition[] => {
  validateModelFullSuiteAssumptions(assumptions);

  // All eight safety properties are checked against the same expensive set of
  // runs, but fast-check drives them as eight independent properties, so each
  // scenario arrives here up to eight separate times. The cache computes those
  // runs once per scenario.
  //
  // Two evictions, and they are not competing strategies:
  //
  //  - Consumption eviction is the entry's real lifetime. Once all eight
  //    safety properties have read it, nothing can ask for it again, so it is
  //    dropped immediately rather than waiting to age out.
  //  - The size cap is a leak backstop for the entries consumption eviction
  //    never reaches: fast-check shrinks and replays, so a scenario is not
  //    guaranteed to be visited by all eight properties.
  //
  // Removing either one is a bug: without the first the map grows to the cap
  // on every run, without the second it grows without bound.
  const cachedSafety = new Map<
    string,
    {
      readonly checks: ReadonlyMap<ModelPropertyName, ModelPropertyCheck>;
      readonly consumedNames: Set<ModelPropertyName>;
    }
  >();
  const check = (name: ModelPropertyName, scenario: ModelScenario): ModelPropertyCheck => {
    if (!isModelSafetyProperty(name)) {
      return checkOneModelProperty(name, scenario);
    }
    const key = JSON.stringify({
      derivedSourceOperations: modelDerivedCrashScheduleSourceOperations(scenario),
      scenario,
    });
    let cached = cachedSafety.get(key);
    if (cached === undefined) {
      const runs = modelSafetyRuns(scenario);
      cached = {
        checks: new Map(
          MODEL_SAFETY_PROPERTY_NAMES.map((safetyName) => [
            safetyName,
            checkModelSafetyRuns(safetyName, runs),
          ]),
        ),
        consumedNames: new Set(),
      };
      cachedSafety.set(key, cached);
      if (cachedSafety.size > MODEL_SAFETY_CACHE_LIMIT) {
        const oldestKey = cachedSafety.keys().next().value;
        if (oldestKey !== undefined) {
          cachedSafety.delete(oldestKey);
        }
      }
    }
    cached.consumedNames.add(name);
    const result = cached.checks.get(name);
    if (result === undefined) {
      throw new Error(`safety cache is missing a precomputed check for ${name}`);
    }
    if (cached.consumedNames.size === MODEL_SAFETY_PROPERTY_NAMES.length) {
      cachedSafety.delete(key);
    }
    return result;
  };

  return MODEL_PROPERTY_NAMES.map((name): ModelPropertyDefinition => ({
    name,
    arbitrary: isModelSafetyProperty(name)
      ? modelScenarioWithDroppedAppendArbitrary(assumptions)
      : modelScenarioArbitrary(assumptions),
    check: (scenario) => check(name, scenario),
  }));
};

export const MODEL_PROPERTIES: readonly ModelPropertyDefinition[] = modelPropertyDefinitions();
