import { describe, test, expect } from "vitest";
import { mulberry32 } from "../load-harness/generators/rng.ts";
import type { BootstrapOptions, OlsQrInput } from "./statistics.ts";
import {
  BOOTSTRAP_PRNG,
  bootstrapPercentile,
  bootstrapPercentileReplicates,
  clopperPearsonZeroFailureUpper,
  madEstimate,
  madFromMedian,
  olsQr,
  pairedRatioBootstrap,
  pairedRatioBootstrapReplicates,
  PRNG_TEST_VECTOR,
  quantileEstimate,
  quantileNearestRank,
  quantileR7,
  STATISTICS_ALGORITHMS,
  STATISTICS_TEST_VECTORS,
  stratifiedPairedDifferenceBootstrap,
  stratifiedPairedDifferenceBootstrapReplicates,
  WILSON_Z_BY_CONFIDENCE,
  wilsonOneSidedUpper,
} from "./statistics.ts";

/**
 * Repo convention (docs/contributing/conventions/tests.md §"Asserting on
 * errors"): assert on the `code` discriminant, never the message. Vitest's
 * `toThrowError` does not reliably accept an asymmetric matcher, so catch and
 * `toMatchObject` instead.
 */
const expectInputError = (fn: () => unknown): void => {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toMatchObject({ code: "StatisticsInput" });
};

describe("tag constants", () => {
  test("the nine algorithm tags are exact and ordered", () => {
    expect(STATISTICS_ALGORITHMS).toEqual([
      "quantile-nearest-rank-v1",
      "quantile-r7-v1",
      "mad-from-median-v1",
      "bootstrap-percentile-v1",
      "paired-ratio-bootstrap-v1",
      "stratified-paired-difference-bootstrap-v1",
      "clopper-pearson-zero-failure-upper-v1",
      "wilson-one-sided-upper-v1",
      "ols-qr-v1",
    ]);
  });

  test("the PRNG tag is mulberry32-v1", () => {
    expect(BOOTSTRAP_PRNG).toBe("mulberry32-v1");
  });
});

describe("quantile-nearest-rank-v1", () => {
  // Nearest rank = one-indexed ceil(q*n) over the ascending sort, clamped to [1,n].
  // n=4: q=0.25 -> ceil(1)=1 -> 1; q=0.5 -> ceil(2)=2 -> 2; q=0.95 -> ceil(3.8)=4 -> 4.
  //
  // The numbers come from STATISTICS_TEST_VECTORS, never inline. That is what
  // makes the contract hash tamper-evident — changing an expected value has to
  // change the hashed constant, because there is nowhere else to change it. Do
  // not "simplify" this back to literals.
  const V = STATISTICS_TEST_VECTORS["quantile-nearest-rank-v1"];

  test("pinned vector [1,2,3,4]", () => {
    for (const { q, value } of V.expected) {
      expect(quantileNearestRank(V.values, q)).toBe(value);
    }
  });

  test("sorts a copy and never mutates the input", () => {
    const input = Object.freeze([4, 1, 3, 2]);
    expect(quantileNearestRank(input, 0.5)).toBe(2);
    expect(input).toEqual([4, 1, 3, 2]);
  });

  test("rejects an empty sample, a nonfinite value, and an out-of-range q", () => {
    expectInputError(() => quantileNearestRank([], 0.5));
    expectInputError(() => quantileNearestRank([1, Number.NaN], 0.5));
    expectInputError(() => quantileNearestRank([1, Number.POSITIVE_INFINITY], 0.5));
    expectInputError(() => quantileNearestRank([1, 2], 1.5));
    expectInputError(() => quantileNearestRank([1, 2], -0.1));
  });
});

describe("quantile-r7-v1", () => {
  // R-7: h=(n-1)q, interpolate. n=4 over [0,10,20,30]:
  // q=0.25 -> h=0.75 -> 0 + 0.75*10 = 7.5
  // q=0.5  -> h=1.5  -> 10 + 0.5*10 = 15
  // q=0.95 -> h=2.85 -> 20 + 0.85*10 = 28.5 (28.499999999999996 in IEEE-754)
  const V = STATISTICS_TEST_VECTORS["quantile-r7-v1"];

  test("pinned vector [0,10,20,30]", () => {
    for (const { q, value, exact } of V.expected) {
      const actual = quantileR7(V.values, q);
      if (exact) {
        expect(actual).toBe(value);
      } else {
        expect(actual).toBeCloseTo(value, 12);
      }
    }
  });

  test("a single-element sample returns that element at every q", () => {
    expect(quantileR7([42], 0)).toBe(42);
    expect(quantileR7([42], 0.5)).toBe(42);
    expect(quantileR7([42], 1)).toBe(42);
  });

  test("R-7 at q=0.5 IS the ordinary median for odd and even n", () => {
    expect(quantileR7([1, 2, 8], 0.5)).toBe(2);
    expect(quantileR7([1, 3, 5, 7], 0.5)).toBe(4); // (3+5)/2
  });
});

describe("mad-from-median-v1", () => {
  // [1,1,2,2,4,6,9] -> median 2; |deviations| = [1,1,0,0,2,4,7] -> median 1.
  const V = STATISTICS_TEST_VECTORS["mad-from-median-v1"];

  test("pinned vector", () => {
    expect(madFromMedian(V.values)).toBe(V.mad);
  });

  // [1,3,5,7] -> median 4; |deviations| = [3,1,1,3] -> median (1+3)/2 = 2.
  test("even-length sample uses the mean of the two central values twice", () => {
    expect(madFromMedian([1, 3, 5, 7])).toBe(2);
  });

  test("an all-identical sample has zero dispersion", () => {
    expect(madFromMedian([5, 5, 5])).toBe(0);
  });
});

describe("tagged summaries", () => {
  test("quantileEstimate carries the tag, q, and sample size", () => {
    expect(quantileEstimate([1, 2, 3, 4], 0.95, "quantile-nearest-rank-v1")).toEqual({
      algorithm: "quantile-nearest-rank-v1",
      q: 0.95,
      value: 4,
      sample_size: 4,
    });
    expect(quantileEstimate([0, 10, 20, 30], 0.25, "quantile-r7-v1")).toEqual({
      algorithm: "quantile-r7-v1",
      q: 0.25,
      value: 7.5,
      sample_size: 4,
    });
  });

  test("madEstimate carries the tag, median, and sample size", () => {
    const V = STATISTICS_TEST_VECTORS["mad-from-median-v1"];
    expect(madEstimate(V.values)).toEqual({
      algorithm: "mad-from-median-v1",
      median: V.median,
      mad: V.mad,
      sample_size: V.values.length,
    });
  });
});

describe("mulberry32-v1 binding", () => {
  test("the canonical generator still produces the pinned sequence", () => {
    const rng = mulberry32(PRNG_TEST_VECTOR.seed);
    expect(PRNG_TEST_VECTOR.draws.map(() => rng())).toEqual([...PRNG_TEST_VECTOR.draws]);
  });

  test("the pinned PRNG tag matches the one every bootstrap records", () => {
    expect(PRNG_TEST_VECTOR.prng).toBe(BOOTSTRAP_PRNG);
  });
});

describe("bootstrap-percentile-v1", () => {
  // values [1,2,8], seed 0, 8 resamples, statistic = R-7 median.
  // Draw index = floor(rng()*3) from ONE mulberry32(0) consumed continuously.
  const V = STATISTICS_TEST_VECTORS["bootstrap-percentile-v1"];
  const VALUES = V.values;
  const OPTIONS = V.options;
  const MEDIAN = V.statistic;

  test("pinned replicate medians", () => {
    expect(bootstrapPercentileReplicates(VALUES, MEDIAN, OPTIONS)).toEqual([...V.replicates]);
  });

  // sorted replicates = [1,1,1,1,2,2,2,8]; confidence 0.75 -> R-7 at q=0.125 and q=0.875.
  // lower: h = 7*0.125 = 0.875 -> 1 + 0.875*(1-1) = 1
  // upper: h = 7*0.875 = 6.125 -> 2 + 0.125*(8-2) = 2.75
  test("pinned point, interval, and full metadata", () => {
    expect(bootstrapPercentile(VALUES, MEDIAN, OPTIONS)).toEqual({
      algorithm: "bootstrap-percentile-v1",
      prng: "mulberry32-v1",
      point: V.point,
      interval: { ...V.interval },
      seed: OPTIONS.seed,
      resamples: OPTIONS.resamples,
      inclusion_unit: OPTIONS.inclusion_unit,
      statistic: { ...MEDIAN },
    });
  });

  test("point is the statistic on the ORIGINAL sample, not a replicate summary", () => {
    // The mean of the pinned replicates is 2.25; the original-sample median is 2.
    // Asserted from the vector so the distinction cannot silently collapse.
    const replicateMean = V.replicates.reduce((a, b) => a + b, 0) / V.replicates.length;
    expect(replicateMean).not.toBe(V.point);
    expect(bootstrapPercentile(VALUES, MEDIAN, OPTIONS).point).toBe(V.point);
  });

  test("same seed reproduces exactly", () => {
    expect(bootstrapPercentile(VALUES, MEDIAN, OPTIONS)).toEqual(
      bootstrapPercentile(VALUES, MEDIAN, OPTIONS),
    );
  });

  test("a different seed draws a different replicate sequence", () => {
    // Seed 1 over the same sample. NOTE: at this tiny resample count seed 1
    // happens to produce the SAME interval [1, 2.75] as seed 0 — the seed
    // shows up in the replicate ORDER, not the interval. Asserting interval
    // divergence here would be a false test; assert the replicates.
    expect(bootstrapPercentileReplicates(VALUES, MEDIAN, { ...OPTIONS, seed: 1 })).toEqual([
      ...V.replicates_at_seed_1,
    ]);
    expect([...V.replicates_at_seed_1]).not.toEqual([...V.replicates]);
  });

  test("the mean statistic is selectable and recorded", () => {
    const r = bootstrapPercentile(VALUES, { algorithm: "mean-v1" }, OPTIONS);
    expect(r.statistic).toEqual({ algorithm: "mean-v1" });
    expect(r.point).toBeCloseTo(11 / 3, 12);
  });

  test("rejects a missing q on a quantile statistic and a present q on the mean", () => {
    expectInputError(() => bootstrapPercentile(VALUES, { algorithm: "quantile-r7-v1" }, OPTIONS));
    expectInputError(() => bootstrapPercentile(VALUES, { algorithm: "mean-v1", q: 0.5 }, OPTIONS));
  });

  test("rejects every out-of-contract bootstrap option", () => {
    const bad: BootstrapOptions[] = [
      { ...OPTIONS, seed: -1 },
      { ...OPTIONS, seed: 1.5 },
      { ...OPTIONS, seed: 4_294_967_296 },
      { ...OPTIONS, resamples: 0 },
      { ...OPTIONS, resamples: 2.5 },
      { ...OPTIONS, confidence: 0 },
      { ...OPTIONS, confidence: 1 },
      { ...OPTIONS, inclusion_unit: "   " },
    ];
    for (const options of bad) {
      expectInputError(() => bootstrapPercentile(VALUES, MEDIAN, options));
    }
  });

  test("does not mutate the caller's sample", () => {
    const input = Object.freeze([8, 1, 2]);
    bootstrapPercentile(input, MEDIAN, OPTIONS);
    expect(input).toEqual([8, 1, 2]);
  });
});

describe("paired-ratio-bootstrap-v1", () => {
  // Pairs (baseline, candidate): (2,1), (4,3), (8,4).
  // Per-pair ratios candidate/baseline = [0.5, 0.75, 0.5]; median = 0.5.
  const V = STATISTICS_TEST_VECTORS["paired-ratio-bootstrap-v1"];
  const PAIRS = V.pairs;
  const OPTIONS = V.options;

  test("pinned replicate medians", () => {
    expect(pairedRatioBootstrapReplicates(PAIRS, OPTIONS)).toEqual([...V.replicates]);
  });

  // sorted replicates = [0.5,0.5,0.5,0.5,0.5,0.75,0.75,0.75]
  // lower: h = 7*0.125 = 0.875 -> 0.5;  upper: h = 7*0.875 = 6.125 -> 0.75 + 0.125*(0.75-0.75) = 0.75
  test("pinned point, interval, and full metadata", () => {
    expect(pairedRatioBootstrap(PAIRS, OPTIONS)).toEqual({
      algorithm: "paired-ratio-bootstrap-v1",
      prng: "mulberry32-v1",
      point: V.point,
      interval: { ...V.interval },
      seed: OPTIONS.seed,
      resamples: OPTIONS.resamples,
      inclusion_unit: OPTIONS.inclusion_unit,
    });
  });

  test("same seed reproduces exactly", () => {
    expect(pairedRatioBootstrap(PAIRS, OPTIONS)).toEqual(pairedRatioBootstrap(PAIRS, OPTIONS));
  });

  test("rejects a nonpositive baseline, a duplicate pair id, and a nonfinite arm", () => {
    expectInputError(() =>
      pairedRatioBootstrap([{ pair_id: "p1", baseline: 0, candidate: 1 }], OPTIONS),
    );
    expectInputError(() =>
      pairedRatioBootstrap([{ pair_id: "p1", baseline: -2, candidate: 1 }], OPTIONS),
    );
    expectInputError(() =>
      pairedRatioBootstrap(
        [
          { pair_id: "dup", baseline: 2, candidate: 1 },
          { pair_id: "dup", baseline: 4, candidate: 3 },
        ],
        OPTIONS,
      ),
    );
    expectInputError(() =>
      pairedRatioBootstrap([{ pair_id: "p1", baseline: 2, candidate: Number.NaN }], OPTIONS),
    );
    expectInputError(() =>
      pairedRatioBootstrap([{ pair_id: "  ", baseline: 2, candidate: 1 }], OPTIONS),
    );
    expectInputError(() => pairedRatioBootstrap([], OPTIONS));
  });
});

describe("stratified-paired-difference-bootstrap-v1", () => {
  // Stratum "a" differences [1,3]; stratum "b" differences [10,14].
  // Point = mean over all four differences = (1+3+10+14)/4 = 7.
  const V = STATISTICS_TEST_VECTORS["stratified-paired-difference-bootstrap-v1"];
  const PAIRS = V.pairs;
  const OPTIONS = V.options;

  test("pinned replicate mean differences", () => {
    expect(stratifiedPairedDifferenceBootstrapReplicates(PAIRS, OPTIONS)).toEqual([
      ...V.replicates,
    ]);
  });

  // sorted replicates = [6,7,7,7,7,7.5,8,8]
  // lower: h = 7*0.125 = 0.875 -> 6 + 0.875*(7-6) = 6.875
  // upper: h = 7*0.875 = 6.125 -> 8 + 0.125*(8-8) = 8
  test("pinned point, interval, and full metadata", () => {
    expect(stratifiedPairedDifferenceBootstrap(PAIRS, OPTIONS)).toEqual({
      algorithm: "stratified-paired-difference-bootstrap-v1",
      prng: "mulberry32-v1",
      point: V.point,
      interval: { ...V.interval },
      seed: OPTIONS.seed,
      resamples: OPTIONS.resamples,
      inclusion_unit: OPTIONS.inclusion_unit,
    });
  });

  test("point is the original-sample mean, not the replicate mean", () => {
    // The mean of the pinned replicates is 7.1875; the original-sample mean is 7.
    const replicateMean = V.replicates.reduce((a, b) => a + b, 0) / V.replicates.length;
    expect(replicateMean).not.toBe(V.point);
    expect(stratifiedPairedDifferenceBootstrap(PAIRS, OPTIONS).point).toBe(V.point);
  });

  test("each stratum keeps its original count in every replicate", () => {
    // Stratum "b" alone can never contribute a value below 10, so no replicate
    // mean can fall below (1+1+10+10)/4 = 5.5 — proof strata were not pooled.
    const replicates = stratifiedPairedDifferenceBootstrapReplicates(PAIRS, OPTIONS);
    for (const r of replicates) {
      expect(r).toBeGreaterThanOrEqual(V.replicate_floor_if_strata_preserved);
    }
  });

  test("rejects an empty stratum label", () => {
    expectInputError(() =>
      stratifiedPairedDifferenceBootstrap(
        [{ pair_id: "x", stratum: "  ", baseline: 0, candidate: 1 }],
        OPTIONS,
      ),
    );
  });

  test("a zero or negative baseline is allowed for differences", () => {
    const r = stratifiedPairedDifferenceBootstrap(
      [
        { pair_id: "n1", stratum: "s", baseline: -5, candidate: -1 },
        { pair_id: "n2", stratum: "s", baseline: -5, candidate: -3 },
      ],
      OPTIONS,
    );
    expect(r.point).toBe(3); // differences [4, 2] -> mean 3
  });
});

describe("clopper-pearson-zero-failure-upper-v1", () => {
  // 1 - (1 - 0.95)^(1/100) = 1 - 0.05^0.01. Hand-checkable against any calculator.
  const V = STATISTICS_TEST_VECTORS["clopper-pearson-zero-failure-upper-v1"];

  test("pinned vector n=100, confidence 0.95", () => {
    const r = clopperPearsonZeroFailureUpper(V.attempts, V.confidence);
    expect(r.algorithm).toBe("clopper-pearson-zero-failure-upper-v1");
    expect(r.upper).toBeCloseTo(V.upper, 15);
    expect(r.failures).toBe(0);
    expect(r.attempts).toBe(V.attempts);
    expect(r.confidence).toBe(V.confidence);
  });

  test("the bound tightens as attempts grow", () => {
    expect(clopperPearsonZeroFailureUpper(1000, 0.95).upper).toBeLessThan(
      clopperPearsonZeroFailureUpper(100, 0.95).upper,
    );
  });

  test("rejects attempts below one and confidence outside (0,1)", () => {
    expectInputError(() => clopperPearsonZeroFailureUpper(0, 0.95));
    expectInputError(() => clopperPearsonZeroFailureUpper(10.5, 0.95));
    expectInputError(() => clopperPearsonZeroFailureUpper(100, 1));
    expectInputError(() => clopperPearsonZeroFailureUpper(100, 0));
  });
});

describe("wilson-one-sided-upper-v1", () => {
  // p = 3/100 = 0.03, n = 100, z = 1.6448536269514722 (the standard-normal 95th percentile).
  // (p + z^2/(2n) + z*sqrt(p(1-p)/n + z^2/(4n^2))) / (1 + z^2/n)
  const V = STATISTICS_TEST_VECTORS["wilson-one-sided-upper-v1"];

  test("pinned vector 3 failures in 100", () => {
    const r = wilsonOneSidedUpper(V.failures, V.attempts, {
      confidence: V.confidence,
      z: V.z,
    });
    expect(r.algorithm).toBe("wilson-one-sided-upper-v1");
    expect(r.upper).toBeCloseTo(V.upper, 15);
    expect(r.failures).toBe(V.failures);
    expect(r.attempts).toBe(V.attempts);
    expect(r.confidence).toBe(V.confidence);
    expect(r.z).toBe(V.z);
  });

  test("the pinned z IS the table's z for the pinned confidence", () => {
    expect(V.z).toBe(WILSON_Z_BY_CONFIDENCE[0.95]);
  });

  test("the caller's z is recorded verbatim and never derived from confidence", () => {
    // The module does no deriving — it reads the z it was handed. Proven with a
    // CONSISTENT pair from the table, so no lying record is minted along the way.
    const r = wilsonOneSidedUpper(V.failures, V.attempts, {
      confidence: 0.99,
      z: WILSON_Z_BY_CONFIDENCE[0.99],
    });
    expect(r.z).toBe(WILSON_Z_BY_CONFIDENCE[0.99]);
    expect(r.confidence).toBe(0.99);
    expect(r.upper).toBeGreaterThan(V.upper); // a wider confidence gives a looser bound
  });

  test("rejects a (confidence, z) pair that cannot both be true", () => {
    expectInputError(() => wilsonOneSidedUpper(3, 100, { confidence: 0.95, z: 2 }));
    // A confidence with no table row is rejected rather than silently trusted.
    expectInputError(() =>
      wilsonOneSidedUpper(3, 100, { confidence: 0.9123, z: 1.6448536269514722 }),
    );
  });

  test("a z one ulp from the table still passes — the match is toleranced, not exact", () => {
    const nudged = WILSON_Z_BY_CONFIDENCE[0.95] * (1 + Number.EPSILON);
    const r = wilsonOneSidedUpper(3, 100, { confidence: 0.95, z: nudged });
    expect(r.z).toBe(nudged);
  });

  test("rejects failures outside [0, attempts], attempts below one, and a nonpositive z", () => {
    const z = WILSON_Z_BY_CONFIDENCE[0.95];
    expectInputError(() => wilsonOneSidedUpper(-1, 100, { confidence: 0.95, z }));
    expectInputError(() => wilsonOneSidedUpper(101, 100, { confidence: 0.95, z }));
    expectInputError(() => wilsonOneSidedUpper(1.5, 100, { confidence: 0.95, z }));
    expectInputError(() => wilsonOneSidedUpper(0, 0, { confidence: 0.95, z }));
    expectInputError(() => wilsonOneSidedUpper(3, 100, { confidence: 0.95, z: 0 }));
    expectInputError(() =>
      wilsonOneSidedUpper(3, 100, { confidence: 0.95, z: Number.POSITIVE_INFINITY }),
    );
  });
});

describe("ols-qr-v1", () => {
  const V = STATISTICS_TEST_VECTORS["ols-qr-v1"];

  test("exact-fit vector: y = 1 + 1*calls + 0.5*mib", () => {
    const r = olsQr({ columns: V.columns, rows: V.rows });
    expect(r.algorithm).toBe("ols-qr-v1");
    expect(r.columns).toEqual([...V.columns]);
    expect(r.rank).toBe(V.rank);
    // Householder returns 0.9999999999999996 / 1.0000000000000002 / 0.5 — compare with tolerance.
    for (const [j, expected] of V.coefficients.entries()) {
      expect(r.coefficients[j]).toBeCloseTo(expected, 12);
    }
    for (const e of r.residuals) {
      expect(Math.abs(e)).toBeLessThan(1e-12);
    }
    expect(r.residual_sum_squares).toBeLessThan(1e-12);
    expect(r.root_mean_square_error).toBeLessThan(1e-12);
    expect(r.r_squared).toBeCloseTo(V.r_squared, 12);
    expect(r.intercept_present).toBe(V.intercept_present);
  });

  test("a well-conditioned design reports a small condition estimate", () => {
    const r = olsQr({ columns: V.columns, rows: V.rows });
    expect(r.condition_estimate).toBeGreaterThanOrEqual(1);
    expect(r.condition_estimate).toBeLessThan(100);
  });

  test("a NEARLY collinear design passes the rank gate but reports a huge condition estimate", () => {
    // This is the case the rank gate cannot see, and the reason
    // `condition_estimate` exists. It is also the shape of Plan J's own design
    // matrix, where rows and bytes co-vary.
    //
    // The perturbation ALTERNATES on purpose. Writing `bytes = calls*(1+1e-9)`
    // would make the column exactly proportional to `calls`, so its component
    // orthogonal to span{intercept, calls} is zero in exact arithmetic — the
    // design would be exactly singular and `olsQr` would correctly THROW,
    // testing the opposite of what is intended here. An alternating jitter
    // leaves a genuine ~1e-9 orthogonal component: full rank by any tolerance
    // (which sits near 4e-15 for this matrix), numerically hopeless in practice.
    const r = olsQr({
      columns: ["intercept", "calls", "bytes"],
      rows: [
        { x: [1, 1, 1 + 1e-9], y: 2 },
        { x: [1, 2, 2 - 1e-9], y: 3 },
        { x: [1, 3, 3 + 1e-9], y: 5 },
        { x: [1, 4, 4 - 1e-9], y: 6 },
      ],
    });
    expect(r.rank).toBe(3); // full rank — the gate is satisfied
    expect(r.condition_estimate).toBeGreaterThan(1e6); // and yet
  });

  test("intercept_present is detected from the data, not from a column name", () => {
    // Named "one", not "intercept" — still an intercept.
    const named = olsQr({
      columns: ["one", "x"],
      rows: [
        { x: [1, 1], y: 1 },
        { x: [1, 2], y: 3 },
      ],
    });
    expect(named.intercept_present).toBe(true);

    // Named "intercept" but not constant — NOT an intercept.
    const lying = olsQr({
      columns: ["intercept", "x"],
      rows: [
        { x: [2, 1], y: 1 },
        { x: [1, 2], y: 3 },
      ],
    });
    expect(lying.intercept_present).toBe(false);
  });

  test("no emitted number is negative zero", () => {
    // Lane D's canonical JSON REJECTS -0. The reachable path is an exactly zero
    // coefficient over a negative Householder pivot — which the noisy vector
    // below produces, since its true intercept is exactly 0.
    const r = olsQr({
      columns: ["intercept", "x"],
      rows: [
        { x: [1, 1], y: 1 },
        { x: [1, 2], y: 3 },
        { x: [1, 3], y: 2 },
        { x: [1, 4], y: 5 },
      ],
    });
    for (const v of [...r.coefficients, ...r.residuals]) {
      expect(Object.is(v, -0)).toBe(false);
    }
  });

  test("noisy vector with hand-computed simple-regression diagnostics", () => {
    // x = [1,2,3,4], y = [1,3,2,5]. x̄ = 2.5, ȳ = 2.75.
    // Sxy = (-1.5)(-1.75)+(-0.5)(0.25)+(0.5)(-0.75)+(1.5)(2.25) = 5.5
    // Sxx = 2.25+0.25+0.25+2.25 = 5   -> slope = 1.1, intercept = 2.75 - 1.1*2.5 = 0
    // fitted = [1.1, 2.2, 3.3, 4.4]   -> residuals = [-0.1, 0.8, -1.3, 0.6]
    // RSS = 0.01+0.64+1.69+0.36 = 2.7 -> RMSE = sqrt(2.7/4) = 0.8215838362577491
    // TSS = 3.0625+0.0625+0.5625+5.0625 = 8.75 -> R² = 1 - 2.7/8.75 = 0.6914285714285714
    const r = olsQr({
      columns: ["intercept", "x"],
      rows: [
        { x: [1, 1], y: 1 },
        { x: [1, 2], y: 3 },
        { x: [1, 3], y: 2 },
        { x: [1, 4], y: 5 },
      ],
    });
    expect(r.rank).toBe(2);
    expect(r.coefficients[0]).toBeCloseTo(0, 12);
    expect(r.coefficients[1]).toBeCloseTo(1.1, 12);
    expect(r.residuals[0]).toBeCloseTo(-0.1, 12);
    expect(r.residuals[1]).toBeCloseTo(0.8, 12);
    expect(r.residuals[2]).toBeCloseTo(-1.3, 12);
    expect(r.residuals[3]).toBeCloseTo(0.6, 12);
    expect(r.residual_sum_squares).toBeCloseTo(2.7, 12);
    expect(r.root_mean_square_error).toBeCloseTo(0.8215838362577491, 12);
    expect(r.r_squared).toBeCloseTo(0.6914285714285714, 12);
  });

  test("constant response with an exact fit reports R² = 1", () => {
    const r = olsQr({
      columns: ["intercept"],
      rows: [
        { x: [1], y: 5 },
        { x: [1], y: 5 },
        { x: [1], y: 5 },
      ],
    });
    expect(r.coefficients[0]).toBeCloseTo(5, 12);
    expect(r.residual_sum_squares).toBeLessThan(1e-12);
    expect(r.r_squared).toBe(1);
  });

  test("constant response with a nonzero RSS reports R² = 0", () => {
    // No intercept column: OLS slope = (1*5 + 2*5)/(1+4) = 3.
    // fitted = [3, 6] -> residuals = [2, -1] -> RSS = 5, RMSE = sqrt(2.5).
    const r = olsQr({
      columns: ["x"],
      rows: [
        { x: [1], y: 5 },
        { x: [2], y: 5 },
      ],
    });
    expect(r.coefficients[0]).toBeCloseTo(3, 12);
    expect(r.residuals[0]).toBeCloseTo(2, 12);
    expect(r.residuals[1]).toBeCloseTo(-1, 12);
    expect(r.residual_sum_squares).toBeCloseTo(5, 12);
    expect(r.root_mean_square_error).toBeCloseTo(1.5811388300841898, 12);
    expect(r.r_squared).toBe(0);
    // And the flag that tells a reader NOT to quote that 0: `r_squared` is the
    // centered definition, which is not interpretable without a constant column.
    expect(r.intercept_present).toBe(false);
  });

  test("a duplicated design column throws the tagged singular error", () => {
    let thrown: unknown;
    try {
      olsQr({
        columns: ["intercept", "calls", "calls_copy"],
        rows: [
          { x: [1, 1, 1], y: 2 },
          { x: [1, 2, 2], y: 3 },
          { x: [1, 3, 3], y: 5 },
          { x: [1, 4, 4], y: 6 },
        ],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown).toMatchObject({
      code: "SingularDesign",
      algorithm: "ols-qr-v1",
      rank: 2,
      columns: ["intercept", "calls", "calls_copy"],
    });
  });

  test("rejects malformed designs", () => {
    const bad: OlsQrInput[] = [
      { columns: [], rows: [{ x: [], y: 1 }] },
      {
        columns: ["a", "a"],
        rows: [
          { x: [1, 1], y: 1 },
          { x: [2, 2], y: 2 },
        ],
      },
      { columns: [" "], rows: [{ x: [1], y: 1 }] },
      { columns: ["a", "b"], rows: [{ x: [1, 2], y: 1 }] }, // fewer rows than columns
      { columns: ["a"], rows: [{ x: [1, 2], y: 1 }] }, // wrong row width
      { columns: ["a"], rows: [{ x: [Number.POSITIVE_INFINITY], y: 1 }] },
      { columns: ["a"], rows: [{ x: [1], y: Number.NaN }] },
      { columns: ["a"], rows: [] },
    ];
    for (const input of bad) {
      expectInputError(() => olsQr(input));
    }
  });
});
