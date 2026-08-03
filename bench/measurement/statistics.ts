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
    id: "nearest-rank/1-2-3-4/q00-q25-q50-q95-q100/v1",
    values: [1, 2, 3, 4],
    // One-indexed ceil(q*n) over the ascending sort, clamped to [1,n].
    expected: [
      { q: 0, value: 1 },
      { q: 0.25, value: 1 },
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
    upper: 0.029513049607039932,
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
 * The ordinary median. Provably identical to `quantileR7(values, 0.5)` for
 * every n — for even n, `h=(n-1)/2` interpolates exactly halfway between the
 * two central values. There is deliberately no second median implementation.
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
    confidence,
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
    seed: options.seed,
    resamples: options.resamples,
    inclusion_unit: options.inclusion_unit,
    statistic,
  };
};
