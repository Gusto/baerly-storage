/**
 * Algorithm-tagged statistics for the fold-program measurement foundation.
 *
 * Every summary this module returns carries its algorithm tag and every
 * parameter that determined the number, so a study cannot emit an untagged
 * `p95` or `confidence_interval`.
 *
 * This module supplies ALGORITHMS ONLY. Sample counts, retry rules,
 * thresholds, scenario catalogs, and candidate-admission policy are
 * study-owned and always arrive as caller parameters.
 *
 * Pure: no I/O, no clock read, no dependency. The one import is the
 * repository's single canonical PRNG. Do not add a second PRNG here.
 */

import { mulberry32 } from "../load-harness/generators/rng.ts";

/** Coordination design §4.7. Order is normative: the contract descriptor hashes this array. */
export const STATISTICS_ALGORITHMS = [
  "quantile-nearest-rank-v1",
  "quantile-r7-v1",
  "mad-from-median-v1",
  "bootstrap-percentile-v1",
  "paired-ratio-bootstrap-v1",
  "stratified-paired-difference-bootstrap-v1",
  "clopper-pearson-zero-failure-upper-v1",
  "wilson-one-sided-upper-v1",
  "ols-qr-v1",
] as const;

export type StatisticsAlgorithm = (typeof STATISTICS_ALGORITHMS)[number];

/** The one PRNG every resampling algorithm here uses. */
export const BOOTSTRAP_PRNG = "mulberry32-v1" as const;

/**
 * Statistic selectors a caller may bootstrap. These are NOT algorithm tags —
 * they name which summary the bootstrap resamples, and they are recorded
 * alongside the algorithm tag in the result.
 */
export const BOOTSTRAP_STATISTICS = [
  "mean-v1",
  "quantile-nearest-rank-v1",
  "quantile-r7-v1",
] as const;

export type BootstrapStatisticTag = (typeof BOOTSTRAP_STATISTICS)[number];

/**
 * The only `(confidence, z)` pairs `wilson-one-sided-upper-v1` accepts.
 *
 * The module never DERIVES z from confidence — a normal-quantile routine would
 * be an untagged tenth algorithm. But recording a confidence that did not
 * determine the number is exactly the untagged-summary failure §4.7 exists to
 * prevent, so an inconsistent pair is rejected instead. This is a table of
 * mathematical facts, not a study policy: it chooses no sample count, no
 * threshold, and no confidence FOR the caller — it only refuses a pair that
 * cannot both be true.
 *
 * Values are the one-sided standard-normal quantiles z_(1-alpha), i.e.
 * `qnorm(confidence)`. Adding a row is a contract change; adding one is the
 * sanctioned escape hatch if a study needs a confidence not listed here.
 */
export const WILSON_Z_BY_CONFIDENCE = {
  0.9: 1.2815515655446004,
  0.95: 1.6448536269514722,
  0.975: 1.959963984540054,
  0.99: 2.3263478740408408,
  0.995: 2.5758293035489004,
} as const;

/**
 * Invalid input to a statistics primitive. Assert on `code`, never on
 * `message` (repo test convention:
 * docs/contributing/conventions/tests.md §"Asserting on errors").
 */
export class StatisticsInputError extends Error {
  readonly code = "StatisticsInput" as const;
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`bench/measurement/statistics: invalid ${field} — ${detail}`);
    this.name = "StatisticsInputError";
    this.field = field;
  }
}

const MAX_UINT32 = 4_294_967_295;

/**
 * Collapse `-0` to `0` on every number this module emits.
 *
 * Lane D's canonical JSON REJECTS `-0` rather than normalizing it
 * (`canonical-json.ts`: reason `negative-zero`), and these result objects are
 * serialized into hashed evidence records. The reachable path is ordinary
 * arithmetic, not a pathological input: an exactly zero OLS coefficient divided
 * by a Householder pivot yields `-0` whenever that pivot is negative, which it
 * routinely is. Normalizing here means no caller has to know.
 *
 * Apply at every point where a result object is CONSTRUCTED — not inside the
 * numeric kernels, where an intermediate `-0` is harmless and stripping it
 * would just cost cycles.
 */
const normalizeZero = (value: number): number => (Object.is(value, -0) ? 0 : value);

const assertFiniteSample = (values: readonly number[], field: string): void => {
  if (values.length === 0) {
    throw new StatisticsInputError(field, "sample is empty");
  }
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new StatisticsInputError(field, `nonfinite value ${String(v)}`);
    }
  }
};

const assertProbability = (q: number, field: string): void => {
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new StatisticsInputError(field, `must be within [0,1]; got ${String(q)}`);
  }
};

export interface BootstrapOptions {
  readonly seed: number;
  readonly resamples: number;
  readonly confidence: number;
  readonly inclusion_unit: string;
}

const assertBootstrapOptions = (options: BootstrapOptions): void => {
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > MAX_UINT32) {
    throw new StatisticsInputError("seed", `must be a uint32; got ${String(options.seed)}`);
  }
  if (!Number.isInteger(options.resamples) || options.resamples < 1) {
    throw new StatisticsInputError(
      "resamples",
      `must be a positive integer; got ${String(options.resamples)}`,
    );
  }
  if (!Number.isFinite(options.confidence) || options.confidence <= 0 || options.confidence >= 1) {
    throw new StatisticsInputError(
      "confidence",
      `must be within (0,1); got ${String(options.confidence)}`,
    );
  }
  if (typeof options.inclusion_unit !== "string" || options.inclusion_unit.trim() === "") {
    throw new StatisticsInputError("inclusion_unit", "must be a nonempty string");
  }
};

/**
 * The pinned numeric vectors, one per algorithm tag.
 *
 * The measurement contract descriptor (parent plan Task 8) hashes THIS OBJECT,
 * not the module's source bytes: a behavior-preserving refactor must not churn
 * `measurement_contract_hash`, while a changed expected value must — and does,
 * because `statistics.test.ts` asserts against these values and nothing else.
 *
 * Changing any number here is a contract change. Bump that entry's trailing
 * `/vN` and treat it as such; it is not a rename.
 */
export const STATISTICS_TEST_VECTORS = {
  "quantile-nearest-rank-v1": {
    id: "nearest-rank/1-2-3-4/q00-q25-q30-q50-q95-q100/v1",
    values: [1, 2, 3, 4],
    // One-indexed ceil(q*n) over the ascending sort, clamped to [1,n].
    //
    // q=0.3 is the row that pins CEIL specifically. At every other q here
    // `q*n` is already an integer or rounds up anyway (0, 1, 2, 3.8, 4), so
    // `Math.round` computes the same five answers and the defining operation
    // went unpinned. At q=0.3, `q*n` is 1.2: ceil gives rank 2 (value 2),
    // round gives rank 1 (value 1).
    expected: [
      { q: 0, value: 1 },
      { q: 0.25, value: 1 },
      { q: 0.3, value: 2 },
      { q: 0.5, value: 2 },
      { q: 0.95, value: 4 },
      { q: 1, value: 4 },
    ],
  },
  "quantile-r7-v1": {
    id: "r7/0-10-20-30/q00-q25-q50-q95-q100/v1",
    values: [0, 10, 20, 30],
    // `exact: false` means assert with toBeCloseTo(value, 12): the true IEEE-754
    // result at q=0.95 is 28.499999999999996, and `toBe(28.5)` would be red on a
    // correct implementation.
    expected: [
      { q: 0, value: 0, exact: true },
      { q: 0.25, value: 7.5, exact: true },
      { q: 0.5, value: 15, exact: true },
      { q: 0.95, value: 28.5, exact: false },
      { q: 1, value: 30, exact: true },
    ],
  },
  "mad-from-median-v1": {
    id: "mad/1-1-2-2-4-6-9/v1",
    values: [1, 1, 2, 2, 4, 6, 9],
    median: 2,
    mad: 1,
  },
  "bootstrap-percentile-v1": {
    id: "bootstrap/1-2-8/median/seed0/r8/c075/v1",
    values: [1, 2, 8],
    statistic: { algorithm: "quantile-r7-v1", q: 0.5 },
    options: { seed: 0, resamples: 8, confidence: 0.75, inclusion_unit: "sample" },
    replicates: [1, 2, 2, 1, 8, 2, 1, 1],
    point: 2,
    interval: { lower: 1, upper: 2.75, confidence: 0.75 },
    // Same sample and options at seed 1 — proves the seed changes the draw
    // ORDER. At this resample count seed 1 yields the SAME interval, so
    // asserting interval divergence would be a false test.
    replicates_at_seed_1: [2, 8, 2, 2, 1, 1, 2, 1],
    // The nearest-rank selector is a legal `BOOTSTRAP_STATISTICS` member and a
    // distinct dispatch branch, and it had no test.
    //
    // q=0.25, NOT q=0.5. Over a 3-element resample the two quantile
    // definitions coincide at the median — `ceil(0.5*3)=2` and `h=(3-1)*0.5=1`
    // both select `sorted[1]` — so a q=0.5 vector is satisfied by either
    // dispatch and would pin nothing. At q=0.25 they genuinely diverge, and
    // the R-7 replicates are carried alongside so the test can assert that.
    nearest_rank: {
      statistic: { algorithm: "quantile-nearest-rank-v1", q: 0.25 },
      replicates: [1, 1, 2, 1, 2, 2, 1, 1],
      r7_replicates_at_same_q: [1, 1.5, 2, 1, 5, 2, 1, 1],
      point: 1,
      interval: { lower: 1, upper: 2, confidence: 0.75 },
    },
  },
  "paired-ratio-bootstrap-v1": {
    id: "paired-ratio/2-1_4-3_8-4/seed7/r8/c075/v1",
    pairs: [
      { pair_id: "p1", baseline: 2, candidate: 1 },
      { pair_id: "p2", baseline: 4, candidate: 3 },
      { pair_id: "p3", baseline: 8, candidate: 4 },
    ],
    options: { seed: 7, resamples: 8, confidence: 0.75, inclusion_unit: "complete-pair" },
    replicates: [0.5, 0.75, 0.75, 0.5, 0.5, 0.75, 0.5, 0.5],
    point: 0.5,
    interval: { lower: 0.5, upper: 0.75, confidence: 0.75 },
  },
  "stratified-paired-difference-bootstrap-v1": {
    id: "stratified-diff/a_1-3_b_10-14/seed9/r8/c075/v1",
    pairs: [
      { pair_id: "a1", stratum: "a", baseline: 0, candidate: 1 },
      { pair_id: "a2", stratum: "a", baseline: 0, candidate: 3 },
      { pair_id: "b1", stratum: "b", baseline: 0, candidate: 10 },
      { pair_id: "b2", stratum: "b", baseline: 0, candidate: 14 },
    ],
    options: {
      seed: 9,
      resamples: 8,
      confidence: 0.75,
      inclusion_unit: "complete-pair-within-stratum",
    },
    replicates: [7, 7.5, 8, 7, 8, 7, 7, 6],
    point: 7,
    interval: { lower: 6.875, upper: 8, confidence: 0.75 },
    // Stratum "b" alone can never contribute below 10, so no replicate mean can
    // fall under (1+1+10+10)/4 — proof the strata were not pooled.
    replicate_floor_if_strata_preserved: 5.5,
  },
  "clopper-pearson-zero-failure-upper-v1": {
    id: "clopper-pearson/n100/c095/v1",
    attempts: 100,
    confidence: 0.95,
    upper: 0.029513049607039925,
  },
  "wilson-one-sided-upper-v1": {
    id: "wilson/f3-n100/c095/z1_6448536269514722/v1",
    failures: 3,
    attempts: 100,
    confidence: 0.95,
    z: 1.6448536269514722,
    upper: 0.07271034328690394,
  },
  "ols-qr-v1": {
    id: "ols-qr/intercept-calls-mib/4x3-exact-fit/v1",
    columns: ["intercept", "calls", "mib"],
    rows: [
      { x: [1, 1, 1], y: 2.5 },
      { x: [1, 2, 2], y: 4 },
      { x: [1, 4, 4], y: 7 },
      { x: [1, 4, 8], y: 9 },
    ],
    // y = 1 + 1*calls + 0.5*mib. Householder returns 0.9999999999999996 /
    // 1.0000000000000002 / 0.5 — every coefficient asserts with toBeCloseTo(_, 12).
    coefficients: [1, 1, 0.5],
    rank: 3,
    intercept_present: true,
    r_squared: 1,
    // Over the COLUMN-EQUILIBRATED diagonal, so this is a pure number: rescaling
    // any column's units leaves it bit-identical. Pinned exactly — it is the
    // only near-collinearity signal the algorithm emits, and a study is expected
    // to preregister a bar against it.
    condition_estimate: 3.2008648384906406,
  },
  // The index signature is load-bearing. `satisfies` runs an excess-property
  // check against a bare `{ readonly id: string }`, which rejects every vector's
  // own data. Admitting the data via `unknown` keeps both properties the clause
  // exists for: a missing algorithm is a COMPILE error, and every entry must
  // carry an `id`. `as const` — not `satisfies` — is what preserves the literal
  // types, so widening the constraint here costs nothing at any use site.
} as const satisfies Record<
  StatisticsAlgorithm,
  { readonly id: string; readonly [field: string]: unknown }
>;

/**
 * The PRNG vector. Separate from `STATISTICS_TEST_VECTORS` because
 * `mulberry32-v1` is not a `StatisticsAlgorithm`, but the descriptor must hash
 * it too: this sequence determines every bootstrap number in the program.
 */
export const PRNG_TEST_VECTOR = {
  id: "mulberry32/seed0/first-5/v1",
  prng: BOOTSTRAP_PRNG,
  seed: 0,
  draws: [
    0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111,
    0.46732782293111086,
  ],
} as const;

const ascending = (values: readonly number[]): number[] => [...values].toSorted((a, b) => a - b);

/** `quantile-nearest-rank-v1`: one-indexed `ceil(q*n)` over the ascending sort, clamped to [1,n]. */
export const quantileNearestRank = (values: readonly number[], q: number): number => {
  assertFiniteSample(values, "values");
  assertProbability(q, "q");
  const sorted = ascending(values);
  const n = sorted.length;
  const rank = Math.min(n, Math.max(1, Math.ceil(q * n)));
  return sorted[rank - 1]!;
};

/** `quantile-r7-v1`: `h=(n-1)q`, linear interpolation between `floor(h)` and `ceil(h)`. */
export const quantileR7 = (values: readonly number[], q: number): number => {
  assertFiniteSample(values, "values");
  assertProbability(q, "q");
  const sorted = ascending(values);
  const n = sorted.length;
  if (n === 1) {
    return sorted[0]!;
  }
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const loValue = sorted[lo]!;
  return loValue + (h - lo) * (sorted[hi]! - loValue);
};

/**
 * The ordinary median, defined as `quantileR7(values, 0.5)`. For even n,
 * `h=(n-1)/2` interpolates exactly halfway between the two central values.
 *
 * The two spellings agree in exact arithmetic but NOT bit-for-bit in IEEE-754:
 * `(a+b)/2` and `a + 0.5*(b-a)` differ in the last ulp for roughly 9% of random
 * even-n pairs. That is precisely why there is deliberately no second median
 * implementation here — one definition, so the question never arises.
 */
const median = (values: readonly number[]): number => quantileR7(values, 0.5);

const mean = (values: readonly number[]): number => {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total / values.length;
};

/** `mad-from-median-v1`: the ordinary median of absolute deviations from the ordinary median. */
export const madFromMedian = (values: readonly number[]): number => {
  assertFiniteSample(values, "values");
  const centre = median(values);
  return median(values.map((v) => Math.abs(v - centre)));
};

export interface QuantileEstimate {
  readonly algorithm: "quantile-nearest-rank-v1" | "quantile-r7-v1";
  readonly q: number;
  readonly value: number;
  readonly sample_size: number;
}

/** Tagged wrapper. Use this — not the bare quantile functions — when emitting evidence. */
export const quantileEstimate = (
  values: readonly number[],
  q: number,
  algorithm: "quantile-nearest-rank-v1" | "quantile-r7-v1",
): QuantileEstimate => ({
  algorithm,
  q: normalizeZero(q),
  value: normalizeZero(
    algorithm === "quantile-nearest-rank-v1"
      ? quantileNearestRank(values, q)
      : quantileR7(values, q),
  ),
  sample_size: values.length,
});

export interface DispersionEstimate {
  readonly algorithm: "mad-from-median-v1";
  readonly median: number;
  readonly mad: number;
  readonly sample_size: number;
}

/** Tagged wrapper. Use this — not `madFromMedian` — when emitting evidence. */
export const madEstimate = (values: readonly number[]): DispersionEstimate => {
  assertFiniteSample(values, "values");
  return {
    algorithm: "mad-from-median-v1",
    median: normalizeZero(median(values)),
    mad: normalizeZero(madFromMedian(values)),
    sample_size: values.length,
  };
};

export interface IntervalEstimate {
  readonly lower: number;
  readonly upper: number;
  readonly confidence: number;
}

export interface BootstrapStatisticSelector {
  readonly algorithm: BootstrapStatisticTag;
  /** Required for a quantile algorithm; must be absent for `mean-v1`. */
  readonly q?: number;
}

export interface BootstrapResult<
  Algorithm extends
    | "bootstrap-percentile-v1"
    | "paired-ratio-bootstrap-v1"
    | "stratified-paired-difference-bootstrap-v1",
> {
  readonly algorithm: Algorithm;
  readonly prng: "mulberry32-v1";
  /** The statistic applied to the ORIGINAL sample, not a replicate summary. */
  readonly point: number;
  readonly interval: IntervalEstimate;
  readonly seed: number;
  readonly resamples: number;
  readonly inclusion_unit: string;
  /** Which summary was resampled. Present only for `bootstrap-percentile-v1`. */
  readonly statistic?: BootstrapStatisticSelector;
}

/** The one percentile-interval rule every bootstrap here uses: R-7 over replicate statistics. */
const percentileInterval = (
  replicates: readonly number[],
  confidence: number,
): IntervalEstimate => {
  const alpha = (1 - confidence) / 2;
  return {
    lower: normalizeZero(quantileR7(replicates, alpha)),
    upper: normalizeZero(quantileR7(replicates, 1 - alpha)),
    confidence: normalizeZero(confidence),
  };
};

/**
 * The one resample-draw rule. `rng` is a single `mulberry32(seed)` generator
 * consumed continuously across every replicate, in replicate order.
 */
const drawWithReplacement = <T>(source: readonly T[], rng: () => number): T[] => {
  const n = source.length;
  const drawn: T[] = [];
  for (let i = 0; i < n; i++) {
    drawn.push(source[Math.floor(rng() * n)]!);
  }
  return drawn;
};

/**
 * Copy the caller's selector, normalizing its `q`.
 *
 * Closes two defects at once. Echoing the caller's object BY REFERENCE lets a
 * later mutation retroactively edit an already-emitted evidence record; and
 * `assertProbability` accepts `-0` (`-0 < 0` is false), so a `q` of `-0` would
 * otherwise ride into a serializer that rejects it.
 *
 * `q` is omitted rather than set to `undefined` when absent: canonical JSON
 * rejects an explicit `undefined` as surely as it rejects `-0`.
 */
const normalizeSelector = (statistic: BootstrapStatisticSelector): BootstrapStatisticSelector =>
  statistic.q === undefined
    ? { algorithm: statistic.algorithm }
    : { algorithm: statistic.algorithm, q: normalizeZero(statistic.q) };

const assertStatisticSelector = (statistic: BootstrapStatisticSelector): void => {
  if (!(BOOTSTRAP_STATISTICS as readonly string[]).includes(statistic.algorithm)) {
    throw new StatisticsInputError("statistic.algorithm", `unknown ${statistic.algorithm}`);
  }
  if (statistic.algorithm === "mean-v1") {
    if (statistic.q !== undefined) {
      throw new StatisticsInputError("statistic.q", "must be absent for mean-v1");
    }
    return;
  }
  if (statistic.q === undefined) {
    throw new StatisticsInputError("statistic.q", `required for ${statistic.algorithm}`);
  }
  assertProbability(statistic.q, "statistic.q");
};

const applyStatistic = (
  values: readonly number[],
  statistic: BootstrapStatisticSelector,
): number => {
  if (statistic.algorithm === "mean-v1") {
    return mean(values);
  }
  if (statistic.algorithm === "quantile-nearest-rank-v1") {
    return quantileNearestRank(values, statistic.q!);
  }
  return quantileR7(values, statistic.q!);
};

/** The pinned replicate statistics of `bootstrap-percentile-v1`, in draw order. */
export const bootstrapPercentileReplicates = (
  values: readonly number[],
  statistic: BootstrapStatisticSelector,
  options: BootstrapOptions,
): readonly number[] => {
  assertFiniteSample(values, "values");
  assertStatisticSelector(statistic);
  assertBootstrapOptions(options);
  const rng = mulberry32(options.seed);
  const replicates: number[] = [];
  for (let r = 0; r < options.resamples; r++) {
    replicates.push(applyStatistic(drawWithReplacement(values, rng), statistic));
  }
  return replicates;
};

/**
 * `bootstrap-percentile-v1` with `mulberry32-v1`. `point` is the statistic on
 * the ORIGINAL sample; the interval is the R-7 percentile interval over the
 * replicate statistics.
 */
export const bootstrapPercentile = (
  values: readonly number[],
  statistic: BootstrapStatisticSelector,
  options: BootstrapOptions,
): BootstrapResult<"bootstrap-percentile-v1"> => {
  const replicates = bootstrapPercentileReplicates(values, statistic, options);
  return {
    algorithm: "bootstrap-percentile-v1",
    prng: BOOTSTRAP_PRNG,
    point: normalizeZero(applyStatistic(values, statistic)),
    interval: percentileInterval(replicates, options.confidence),
    seed: normalizeZero(options.seed),
    resamples: normalizeZero(options.resamples),
    inclusion_unit: options.inclusion_unit,
    statistic: normalizeSelector(statistic),
  };
};

export interface PairedValue {
  readonly pair_id: string;
  readonly baseline: number;
  readonly candidate: number;
}

export interface StratifiedPair extends PairedValue {
  readonly stratum: string;
}

const assertPairs = (pairs: readonly PairedValue[]): void => {
  if (pairs.length === 0) {
    throw new StatisticsInputError("pairs", "no complete pairs supplied");
  }
  const seen = new Set<string>();
  for (const p of pairs) {
    if (typeof p.pair_id !== "string" || p.pair_id.trim() === "") {
      throw new StatisticsInputError("pair_id", "must be a nonempty string");
    }
    if (seen.has(p.pair_id)) {
      throw new StatisticsInputError("pair_id", `duplicate ${p.pair_id}`);
    }
    seen.add(p.pair_id);
    if (typeof p.baseline !== "number" || !Number.isFinite(p.baseline)) {
      throw new StatisticsInputError("baseline", `pair ${p.pair_id} has no finite baseline arm`);
    }
    if (typeof p.candidate !== "number" || !Number.isFinite(p.candidate)) {
      throw new StatisticsInputError("candidate", `pair ${p.pair_id} has no finite candidate arm`);
    }
  }
};

const perPairRatios = (pairs: readonly PairedValue[]): number[] =>
  pairs.map((p) => {
    if (p.baseline <= 0) {
      throw new StatisticsInputError(
        "baseline",
        `pair ${p.pair_id} baseline must be > 0 for a ratio; got ${String(p.baseline)}`,
      );
    }
    return p.candidate / p.baseline;
  });

/** The pinned replicate medians of `paired-ratio-bootstrap-v1`, in draw order. */
export const pairedRatioBootstrapReplicates = (
  pairs: readonly PairedValue[],
  options: BootstrapOptions,
): readonly number[] => {
  assertPairs(pairs);
  assertBootstrapOptions(options);
  const ratios = perPairRatios(pairs);
  const rng = mulberry32(options.seed);
  const replicates: number[] = [];
  for (let r = 0; r < options.resamples; r++) {
    replicates.push(median(drawWithReplacement(ratios, rng)));
  }
  return replicates;
};

/** `paired-ratio-bootstrap-v1`: resamples complete pairs; summarizes the median of per-pair ratios. */
export const pairedRatioBootstrap = (
  pairs: readonly PairedValue[],
  options: BootstrapOptions,
): BootstrapResult<"paired-ratio-bootstrap-v1"> => {
  const replicates = pairedRatioBootstrapReplicates(pairs, options);
  return {
    algorithm: "paired-ratio-bootstrap-v1",
    prng: BOOTSTRAP_PRNG,
    point: normalizeZero(median(perPairRatios(pairs))),
    interval: percentileInterval(replicates, options.confidence),
    seed: normalizeZero(options.seed),
    resamples: normalizeZero(options.resamples),
    inclusion_unit: options.inclusion_unit,
  };
};

/** Groups differences by stratum in FIRST-APPEARANCE order — the draw order is normative. */
const groupStrata = (pairs: readonly StratifiedPair[]): number[][] => {
  const order: string[] = [];
  const byStratum = new Map<string, number[]>();
  for (const p of pairs) {
    if (typeof p.stratum !== "string" || p.stratum.trim() === "") {
      throw new StatisticsInputError("stratum", `pair ${p.pair_id} has no stratum label`);
    }
    let bucket = byStratum.get(p.stratum);
    if (bucket === undefined) {
      bucket = [];
      byStratum.set(p.stratum, bucket);
      order.push(p.stratum);
    }
    bucket.push(p.candidate - p.baseline);
  }
  return order.map((s) => byStratum.get(s)!);
};

/** The pinned replicate mean differences of the stratified bootstrap, in draw order. */
export const stratifiedPairedDifferenceBootstrapReplicates = (
  pairs: readonly StratifiedPair[],
  options: BootstrapOptions,
): readonly number[] => {
  assertPairs(pairs);
  assertBootstrapOptions(options);
  const strata = groupStrata(pairs);
  const rng = mulberry32(options.seed);
  const replicates: number[] = [];
  for (let r = 0; r < options.resamples; r++) {
    const drawn: number[] = [];
    for (const stratum of strata) {
      drawn.push(...drawWithReplacement(stratum, rng));
    }
    replicates.push(mean(drawn));
  }
  return replicates;
};

/**
 * `stratified-paired-difference-bootstrap-v1`: resamples complete pairs within
 * each declared stratum, preserving every stratum's original count.
 */
export const stratifiedPairedDifferenceBootstrap = (
  pairs: readonly StratifiedPair[],
  options: BootstrapOptions,
): BootstrapResult<"stratified-paired-difference-bootstrap-v1"> => {
  const replicates = stratifiedPairedDifferenceBootstrapReplicates(pairs, options);
  return {
    algorithm: "stratified-paired-difference-bootstrap-v1",
    prng: BOOTSTRAP_PRNG,
    point: normalizeZero(mean(pairs.map((p) => p.candidate - p.baseline))),
    interval: percentileInterval(replicates, options.confidence),
    seed: normalizeZero(options.seed),
    resamples: normalizeZero(options.resamples),
    inclusion_unit: options.inclusion_unit,
  };
};

export interface ClopperPearsonZeroFailureResult {
  readonly algorithm: "clopper-pearson-zero-failure-upper-v1";
  readonly upper: number;
  readonly failures: 0;
  readonly attempts: number;
  readonly confidence: number;
}

const assertAttempts = (attempts: number): void => {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new StatisticsInputError("attempts", `must be an integer >= 1; got ${String(attempts)}`);
  }
};

const assertConfidence = (confidence: number): void => {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new StatisticsInputError("confidence", `must be within (0,1); got ${String(confidence)}`);
  }
};

/** `clopper-pearson-zero-failure-upper-v1`: the exact one-sided bound at zero observed failures. */
export const clopperPearsonZeroFailureUpper = (
  attempts: number,
  confidence: number,
): ClopperPearsonZeroFailureResult => {
  assertAttempts(attempts);
  assertConfidence(confidence);
  return {
    algorithm: "clopper-pearson-zero-failure-upper-v1",
    // `-expm1(log1p(-c)/n)`, not the algebraically equal
    // `1 - (1-c)**(1/n)`. The latter subtracts two nearly equal numbers: the
    // bound falls as 1/n, so at n=1e6 it loses 1.3e-11 relative and at n=1e12
    // it loses 5.8e-6 — while `expm1`/`log1p` are exactly the pair built for
    // this regime. Below n≈1e4 the two agree to within an ulp.
    upper: normalizeZero(-Math.expm1(Math.log1p(-confidence) / attempts)),
    failures: 0,
    attempts: normalizeZero(attempts),
    confidence: normalizeZero(confidence),
  };
};

export interface WilsonOneSidedUpperResult {
  readonly algorithm: "wilson-one-sided-upper-v1";
  readonly upper: number;
  readonly failures: number;
  readonly attempts: number;
  readonly confidence: number;
  readonly z: number;
}

/**
 * `wilson-one-sided-upper-v1`. The caller supplies z; this function never
 * DERIVES it from `confidence`, but it does REJECT a pair that cannot both be
 * true, and records both.
 *
 * The three options were: derive z (an untagged tenth algorithm), record an
 * unchecked pair (which lets a study emit `confidence: 0.95` over a number
 * computed at z = 2 — the exact failure §4.7 exists to prevent), or validate.
 * Only validation is neither.
 */
export const wilsonOneSidedUpper = (
  failures: number,
  attempts: number,
  options: { readonly confidence: number; readonly z: number },
): WilsonOneSidedUpperResult => {
  assertAttempts(attempts);
  assertConfidence(options.confidence);
  if (!Number.isInteger(failures) || failures < 0 || failures > attempts) {
    throw new StatisticsInputError(
      "failures",
      `must be an integer within [0, ${attempts}]; got ${String(failures)}`,
    );
  }
  if (!Number.isFinite(options.z) || options.z <= 0) {
    throw new StatisticsInputError("z", `must be finite and > 0; got ${String(options.z)}`);
  }
  // The (confidence, z) consistency gate. Toleranced, not exact: a study that
  // computed its z from a different library may land an ulp away, and rejecting
  // that would be a usability trap. 1e-12 is still four orders tighter than the
  // gap between any two adjacent table rows, so z=2 at confidence=0.95 fails.
  const expectedZ = (WILSON_Z_BY_CONFIDENCE as Record<number, number | undefined>)[
    options.confidence
  ];
  if (expectedZ === undefined) {
    throw new StatisticsInputError(
      "confidence",
      `no z is pinned for ${String(options.confidence)}; add a WILSON_Z_BY_CONFIDENCE row (a contract change) rather than passing an unchecked pair`,
    );
  }
  if (Math.abs(options.z - expectedZ) > 1e-12) {
    throw new StatisticsInputError(
      "z",
      `z ${String(options.z)} does not match confidence ${String(options.confidence)} (expected ~${String(expectedZ)}); recording both would emit a confidence that did not determine the number`,
    );
  }
  const n = attempts;
  const z = options.z;
  const p = failures / n;
  const upper =
    (p + (z * z) / (2 * n) + z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) /
    (1 + (z * z) / n);
  return {
    algorithm: "wilson-one-sided-upper-v1",
    // Clamped because this is a probability. At p̂ = 1 the limit is exactly 1
    // analytically — numerator and denominator both collapse to 1 + z²/n — but
    // the float evaluation overshoots for 501 of the first 2000 attempt counts
    // (n = 11 gives 1.0000000000000002). An all-failures scenario is ordinary
    // in a bench study, and a bound above 1 is not a probability.
    upper: normalizeZero(Math.min(1, upper)),
    // `failures` is normalized for the same reason `seed` is: `-0` clears
    // `Number.isInteger(f) && f >= 0` untouched, and `failures: -count` at
    // count 0 is ordinary arithmetic, not a pathological input.
    failures: normalizeZero(failures),
    attempts: normalizeZero(attempts),
    confidence: normalizeZero(options.confidence),
    z: normalizeZero(z),
  };
};

/** Rank-deficient OLS design. `ols-qr-v1` records singularity as a failure, never as coefficients. */
export class SingularDesignError extends Error {
  readonly code = "SingularDesign" as const;
  readonly algorithm = "ols-qr-v1" as const;
  readonly columns: readonly string[];
  readonly rank: number;
  constructor(columns: readonly string[], rank: number) {
    super(
      `bench/measurement/statistics: singular design — rank ${rank} < ${columns.length} columns`,
    );
    this.name = "SingularDesignError";
    this.columns = columns;
    this.rank = rank;
  }
}

export interface OlsQrInput {
  readonly columns: readonly string[];
  readonly rows: readonly {
    readonly x: readonly number[];
    readonly y: number;
  }[];
}

export interface OlsQrResult {
  readonly algorithm: "ols-qr-v1";
  readonly columns: readonly string[];
  readonly coefficients: readonly number[];
  readonly rank: number;
  readonly residuals: readonly number[];
  readonly residual_sum_squares: number;
  readonly root_mean_square_error: number;
  /**
   * The CENTERED R². Only interpretable when `intercept_present` is true — on a
   * model with no constant column the centered definition can go negative and
   * invites misreading. Check `intercept_present` before quoting it.
   */
  readonly r_squared: number;
  /**
   * `max / min` over the COLUMN-EQUILIBRATED QR diagonal — each `|R_kk|`
   * divided by its own column's Euclidean norm. A cheap condition-number
   * estimate, and the ONLY signal this algorithm gives about NEAR collinearity.
   *
   * Equilibrating is what makes the number quotable. A raw
   * `max|R_kk| / min|R_kk|` scales with whatever units each column was measured
   * in — the same model in bytes and in MiB reported estimates four orders
   * apart — so no fixed bar could mean anything. Dividing each column by its
   * own norm removes that freedom, and by van der Sluis' theorem column
   * equilibration is within a factor of `sqrt(n)` of the best any diagonal
   * scaling can do, so the number is also near-optimal rather than merely
   * stable.
   *
   * The rank gate catches deficiency down to rounding. It still cannot
   * distinguish a well-conditioned design from a merely NEAR-singular one:
   * both pass `rank === columns.length` and both return coefficients, but the
   * near-singular one's coefficients are noise. Plan J's design matrix is
   * near-collinear by construction (rows and bytes both grow with snapshot
   * size), and it interprets these coefficients as physics, so the study MUST
   * preregister a bar on this number rather than trusting `rank` alone.
   *
   * `Number.POSITIVE_INFINITY` is unreachable here: a zero min-diagonal would
   * have thrown `SingularDesignError` first.
   */
  readonly condition_estimate: number;
  /**
   * True iff some design column is constant and nonzero across every row — i.e.
   * the model has an intercept. Detected from the data, not from a column name,
   * because a caller may spell it anything.
   */
  readonly intercept_present: boolean;
}

const assertOlsInput = (input: OlsQrInput): void => {
  const { columns, rows } = input;
  if (columns.length === 0) {
    throw new StatisticsInputError("columns", "at least one design column is required");
  }
  const seen = new Set<string>();
  for (const name of columns) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new StatisticsInputError("columns", "every column name must be nonempty");
    }
    if (seen.has(name)) {
      throw new StatisticsInputError("columns", `duplicate column name ${name}`);
    }
    seen.add(name);
  }
  if (rows.length === 0) {
    throw new StatisticsInputError("rows", "at least one row is required");
  }
  if (rows.length < columns.length) {
    throw new StatisticsInputError(
      "rows",
      `need at least ${columns.length} rows for ${columns.length} columns; got ${rows.length}`,
    );
  }
  for (const [i, row] of rows.entries()) {
    if (row.x.length !== columns.length) {
      throw new StatisticsInputError(
        "rows",
        `row ${i} has width ${row.x.length}, expected ${columns.length}`,
      );
    }
    for (const v of row.x) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new StatisticsInputError("rows", `row ${i} has a nonfinite design value`);
      }
    }
    if (typeof row.y !== "number" || !Number.isFinite(row.y)) {
      throw new StatisticsInputError("rows", `row ${i} has a nonfinite response`);
    }
  }
};

/**
 * `ols-qr-v1`: Householder QR on the augmented matrix [A | y]. No normal
 * equations, no column pivoting; back-substitution preserves the caller's
 * column order. Rank-deficient designs throw `SingularDesignError`.
 *
 * The rank gate is taken on the COLUMN-EQUILIBRATED diagonal, so it holds
 * whatever units the caller measured each column in, and does not depend on
 * the order the columns were listed in.
 *
 * WITHOUT PIVOTING THE GATE STILL SEES DEFICIENCY ONLY, NEVER DEGREE. A merely
 * NEAR-collinear design passes it and returns coefficients that are
 * numerically meaningless. `condition_estimate` on the result is the only
 * warning a caller gets; a caller that interprets these coefficients as
 * physics must check it.
 */
export const olsQr = (input: OlsQrInput): OlsQrResult => {
  assertOlsInput(input);
  const columns = [...input.columns];
  const m = input.rows.length;
  const n = columns.length;
  const a: number[][] = input.rows.map((r) => [...r.x]);
  const b: number[] = input.rows.map((r) => r.y);

  // Euclidean norm of every ORIGINAL design column, captured before the
  // factorization overwrites `a`. Both the rank gate and the condition estimate
  // divide by these, which is what makes them independent of the units a caller
  // happened to measure each column in.
  const columnNorms = columns.map((_, k) =>
    Math.sqrt(input.rows.reduce((acc, row) => acc + row.x[k]! * row.x[k]!, 0)),
  );

  for (let k = 0; k < n; k++) {
    let norm = 0;
    for (let i = k; i < m; i++) {
      norm += a[i]![k]! * a[i]![k]!;
    }
    norm = Math.sqrt(norm);
    if (norm === 0) {
      continue;
    }
    const alpha = a[k]![k]! > 0 ? -norm : norm;
    const v = Array.from<number>({ length: m }).fill(0);
    for (let i = k; i < m; i++) {
      v[i] = a[i]![k]!;
    }
    v[k] = v[k]! - alpha;
    let vNorm2 = 0;
    for (let i = k; i < m; i++) {
      vNorm2 += v[i]! * v[i]!;
    }
    if (vNorm2 === 0) {
      continue;
    }
    for (let j = k; j < n; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) {
        dot += v[i]! * a[i]![j]!;
      }
      const factor = (2 * dot) / vNorm2;
      for (let i = k; i < m; i++) {
        a[i]![j] = a[i]![j]! - factor * v[i]!;
      }
    }
    let dotB = 0;
    for (let i = k; i < m; i++) {
      dotB += v[i]! * b[i]!;
    }
    const factorB = (2 * dotB) / vNorm2;
    for (let i = k; i < m; i++) {
      b[i] = b[i]! - factorB * v[i]!;
    }
  }

  // Each |R_kk| divided by its own column's norm — the diagonal of the
  // COLUMN-EQUILIBRATED factorization. `R_kk` is the part of column k
  // orthogonal to columns 0..k-1, so this ratio is the sine of the angle
  // between column k and the span of its predecessors: dimensionless, in
  // [0,1], and 0 exactly when column k is a linear combination of them.
  //
  // Scaling by each column's OWN norm is what makes the gate correct. Against a
  // single global `max|R_kk|`, a dependent column merely LARGER than its
  // neighbours has a rounding residual bigger than a tolerance set by some
  // other column's scale, and passes as full rank — at a scale ratio as small
  // as 9, not 1e16. It also made the verdict depend on column ORDER and on the
  // units each column was measured in (the same model in MiB threw where the
  // one in bytes did not). A zero column has no direction, so it scores 0.
  const scaledDiagonal = columns.map((_, k) =>
    columnNorms[k] === 0 ? 0 : Math.abs(a[k]![k]!) / columnNorms[k]!,
  );
  // Dimensionless, because `scaledDiagonal` is. `max(m, n)` is the usual
  // dimension factor on accumulated rounding error in a Householder pass.
  const tolerance = Number.EPSILON * Math.max(m, n);
  let rank = 0;
  for (const d of scaledDiagonal) {
    if (d > tolerance) {
      rank++;
    }
  }
  if (rank < n) {
    throw new SingularDesignError(columns, rank);
  }
  // Past the rank gate every entry exceeds `tolerance`, so the minimum is
  // strictly positive and this can neither divide by zero nor return Infinity.
  // This is the ONLY near-collinearity signal `ols-qr-v1` produces: rank alone
  // cannot tell a well-conditioned design from a nearly singular one.
  const conditionEstimate = Math.max(...scaledDiagonal) / Math.min(...scaledDiagonal);

  const coefficients = Array.from<number>({ length: n }).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    let sum = b[k]!;
    for (let j = k + 1; j < n; j++) {
      sum -= a[k]![j]! * coefficients[j]!;
    }
    coefficients[k] = sum / a[k]![k]!;
  }

  const residuals = input.rows.map((row) => {
    let fitted = 0;
    for (let j = 0; j < n; j++) {
      fitted += row.x[j]! * coefficients[j]!;
    }
    return row.y - fitted;
  });
  const rss = residuals.reduce((acc, e) => acc + e * e, 0);
  const yBar = mean(input.rows.map((row) => row.y));
  const tss = input.rows.reduce((acc, row) => acc + (row.y - yBar) ** 2, 0);

  // A constant, nonzero column IS an intercept, whatever the caller named it.
  // Detected from the data because `columns` are free-form labels — Plan J
  // spells its "intercept" and "fixed", and a third study may spell it "one".
  const interceptPresent = columns.some((_, j) => {
    const first = input.rows[0]!.x[j]!;
    return first !== 0 && input.rows.every((row) => row.x[j] === first);
  });

  // oxlint's `no-nested-ternary` is repo policy. `bench/` is outside the
  // `pnpm verify` lint glob (`package.json` → `"lint": "oxlint tests packages"`),
  // so CI will not catch a violation here — but the lefthook pre-commit hook
  // lints staged files by extension, and these two files are kept clean under
  // `oxlint bench/`. Write it as if `verify` did cover it. Const-lift the
  // inner branch.
  const degenerateRSquared = rss === 0 ? 1 : 0;
  const rSquared = tss === 0 ? degenerateRSquared : 1 - rss / tss;

  return {
    algorithm: "ols-qr-v1",
    columns,
    coefficients: coefficients.map(normalizeZero),
    rank,
    residuals: residuals.map(normalizeZero),
    residual_sum_squares: normalizeZero(rss),
    root_mean_square_error: normalizeZero(Math.sqrt(rss / m)),
    r_squared: normalizeZero(rSquared),
    condition_estimate: conditionEstimate,
    intercept_present: interceptPresent,
  };
};
