import { describe, test, expect } from "vitest";
import { mulberry32 } from "../load-harness/generators/rng.ts";
import {
  type BootstrapOptions,
  type OlsQrInput,
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
 *
 * `field` is REQUIRED. Asserting `code` alone only proves that some validation
 * fired, not the one under test — which is how the `z` finiteness guard came
 * to be fully deletable with this suite green: its two tests were being caught
 * by the downstream (confidence, z) consistency gate instead, and nothing
 * noticed. Naming the field makes each case pin the check it claims to.
 */
const expectInputError = (fn: () => unknown, field: string): void => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code: "StatisticsInput", field });
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

describe("sample ordering", () => {
  test("the sort is numeric, not lexicographic", () => {
    // Every other sample in this file — [1,2,3,4], [0,10,20,30], [1,2,8],
    // [1,1,2,2,4,6,9], every replicate array — happens to sort identically as
    // strings. So dropping the comparator from `ascending`'s `toSorted` left
    // the entire suite green while silently corrupting every quantile, median,
    // MAD, and bootstrap interval the module produces. This sample is the one
    // that separates them, and it is the shape of real latency data.
    const spread = [9, 12, 100, 250, 1500];
    expect([...spread].toSorted()).toEqual([100, 12, 1500, 250, 9]); // what a string sort does
    expect(quantileR7(spread, 0.5)).toBe(100);
    expect(quantileNearestRank(spread, 0.95)).toBe(1500);
    expect(madFromMedian(spread)).toBe(91);
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
    expectInputError(() => quantileNearestRank([], 0.5), "values");
    expectInputError(() => quantileNearestRank([1, Number.NaN], 0.5), "values");
    expectInputError(() => quantileNearestRank([1, Number.POSITIVE_INFINITY], 0.5), "values");
    expectInputError(() => quantileNearestRank([1, 2], 1.5), "q");
    expectInputError(() => quantileNearestRank([1, 2], -0.1), "q");
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
    // Sourced from the vectors, not inlined. Both samples and both (q, value)
    // pairs below have a home in STATISTICS_TEST_VECTORS, so writing them as
    // literals here would let the tagged wrapper drift away from the constant
    // the contract hash is taken over — one eroded test at a time.
    const NR = STATISTICS_TEST_VECTORS["quantile-nearest-rank-v1"];
    const nr = NR.expected[4]; // q = 0.95 -> 4
    expect(quantileEstimate(NR.values, nr.q, "quantile-nearest-rank-v1")).toEqual({
      algorithm: "quantile-nearest-rank-v1",
      q: nr.q,
      value: nr.value,
      sample_size: NR.values.length,
    });

    const R7 = STATISTICS_TEST_VECTORS["quantile-r7-v1"];
    const r7 = R7.expected[1]; // q = 0.25 -> 7.5
    expect(quantileEstimate(R7.values, r7.q, "quantile-r7-v1")).toEqual({
      algorithm: "quantile-r7-v1",
      q: r7.q,
      value: r7.value,
      sample_size: R7.values.length,
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

  test("the nearest-rank statistic is a distinct dispatch branch", () => {
    // `quantile-nearest-rank-v1` is publicly admitted by BOOTSTRAP_STATISTICS
    // but was never bootstrapped, so `applyStatistic`'s nearest-rank branch
    // could return anything. Pinned at q=0.25, where the two quantile
    // definitions genuinely disagree — at q=0.5 over a 3-element resample they
    // coincide, and the assertion would hold under either dispatch.
    const NR = V.nearest_rank;
    expect(bootstrapPercentileReplicates(VALUES, NR.statistic, OPTIONS)).toEqual([
      ...NR.replicates,
    ]);
    expect([...NR.replicates]).not.toEqual([...NR.r7_replicates_at_same_q]);
    expect(
      bootstrapPercentileReplicates(
        VALUES,
        { algorithm: "quantile-r7-v1", q: NR.statistic.q },
        OPTIONS,
      ),
    ).toEqual([...NR.r7_replicates_at_same_q]);

    const r = bootstrapPercentile(VALUES, NR.statistic, OPTIONS);
    expect(r.point).toBe(NR.point);
    expect(r.interval).toEqual({ ...NR.interval });
    expect(r.statistic).toEqual({ ...NR.statistic });
  });

  test("the mean statistic is selectable and recorded", () => {
    const r = bootstrapPercentile(VALUES, { algorithm: "mean-v1" }, OPTIONS);
    expect(r.statistic).toEqual({ algorithm: "mean-v1" });
    expect(r.point).toBeCloseTo(11 / 3, 12);
  });

  test("rejects a missing q on a quantile statistic and a present q on the mean", () => {
    expectInputError(
      () => bootstrapPercentile(VALUES, { algorithm: "quantile-r7-v1" }, OPTIONS),
      "statistic.q",
    );
    expectInputError(
      () => bootstrapPercentile(VALUES, { algorithm: "mean-v1", q: 0.5 }, OPTIONS),
      "statistic.q",
    );
  });

  test("rejects every out-of-contract bootstrap option", () => {
    const bad: { options: BootstrapOptions; field: string }[] = [
      { options: { ...OPTIONS, seed: -1 }, field: "seed" },
      { options: { ...OPTIONS, seed: 1.5 }, field: "seed" },
      { options: { ...OPTIONS, seed: 4_294_967_296 }, field: "seed" },
      { options: { ...OPTIONS, resamples: 0 }, field: "resamples" },
      { options: { ...OPTIONS, resamples: 2.5 }, field: "resamples" },
      { options: { ...OPTIONS, confidence: 0 }, field: "confidence" },
      { options: { ...OPTIONS, confidence: 1 }, field: "confidence" },
      { options: { ...OPTIONS, inclusion_unit: "   " }, field: "inclusion_unit" },
    ];
    for (const { options, field } of bad) {
      expectInputError(() => bootstrapPercentile(VALUES, MEDIAN, options), field);
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
    expectInputError(
      () => pairedRatioBootstrap([{ pair_id: "p1", baseline: 0, candidate: 1 }], OPTIONS),
      "baseline",
    );
    expectInputError(
      () => pairedRatioBootstrap([{ pair_id: "p1", baseline: -2, candidate: 1 }], OPTIONS),
      "baseline",
    );
    expectInputError(
      () =>
        pairedRatioBootstrap(
          [
            { pair_id: "dup", baseline: 2, candidate: 1 },
            { pair_id: "dup", baseline: 4, candidate: 3 },
          ],
          OPTIONS,
        ),
      "pair_id",
    );
    expectInputError(
      () => pairedRatioBootstrap([{ pair_id: "p1", baseline: 2, candidate: Number.NaN }], OPTIONS),
      "candidate",
    );
    expectInputError(
      () => pairedRatioBootstrap([{ pair_id: "  ", baseline: 2, candidate: 1 }], OPTIONS),
      "pair_id",
    );
    expectInputError(() => pairedRatioBootstrap([], OPTIONS), "pairs");
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
    //
    // The floor is RECOMPUTED from the pairs first. Asserted only with
    // `toBeGreaterThanOrEqual`, the pinned constant was free: setting it to 0
    // left this test green and vacuous.
    const byStratum = new Map<string, number[]>();
    for (const p of PAIRS) {
      const bucket = byStratum.get(p.stratum) ?? [];
      bucket.push(p.candidate - p.baseline);
      byStratum.set(p.stratum, bucket);
    }
    const floor =
      [...byStratum.values()].reduce((acc, d) => acc + Math.min(...d) * d.length, 0) / PAIRS.length;
    expect(V.replicate_floor_if_strata_preserved).toBe(floor);

    const replicates = stratifiedPairedDifferenceBootstrapReplicates(PAIRS, OPTIONS);
    for (const r of replicates) {
      expect(r).toBeGreaterThanOrEqual(V.replicate_floor_if_strata_preserved);
    }
    // And the floor is a real constraint on this fixture, not a number so low
    // that pooling would satisfy it too: pooling all four differences admits
    // replicate means as low as 1.
    expect(floor).toBeGreaterThan(Math.min(...PAIRS.map((p) => p.candidate - p.baseline)));
  });

  test("rejects an empty stratum label", () => {
    expectInputError(
      () =>
        stratifiedPairedDifferenceBootstrap(
          [{ pair_id: "x", stratum: "  ", baseline: 0, candidate: 1 }],
          OPTIONS,
        ),
      "stratum",
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
    // `toBe`, not `toBeCloseTo(_, 15)`: this is a deterministic double, and 15
    // decimal places is ~36 ulps of slack at this magnitude — enough to hide a
    // real change in how the bound is evaluated.
    expect(r.upper).toBe(V.upper);
    expect(r.failures).toBe(0);
    expect(r.attempts).toBe(V.attempts);
    expect(r.confidence).toBe(V.confidence);
  });

  test("the bound tightens as attempts grow", () => {
    expect(clopperPearsonZeroFailureUpper(1000, 0.95).upper).toBeLessThan(
      clopperPearsonZeroFailureUpper(100, 0.95).upper,
    );
  });

  test("the bound stays accurate at large attempt counts", () => {
    // The defining identity of the exact bound at zero failures is
    // (1 - p_U)^n = 1 - c. Evaluated as `1 - (1-c)**(1/n)` the subtraction
    // cancels catastrophically as the bound shrinks: 1.3e-11 relative error at
    // n=1e6, 5.8e-6 at n=1e12. Checked against the identity rather than
    // against a second formula, so this cannot pass by agreeing with itself.
    for (const attempts of [1e3, 1e6, 1e9, 1e12]) {
      const { upper } = clopperPearsonZeroFailureUpper(attempts, 0.95);
      // log-space, because (1-p)^1e12 underflows a direct evaluation.
      const residual = Math.abs(attempts * Math.log1p(-upper) - Math.log(0.05));
      expect(residual, `n=${attempts}`).toBeLessThan(1e-9);
    }
  });

  test("rejects attempts below one and confidence outside (0,1)", () => {
    expectInputError(() => clopperPearsonZeroFailureUpper(0, 0.95), "attempts");
    expectInputError(() => clopperPearsonZeroFailureUpper(10.5, 0.95), "attempts");
    expectInputError(() => clopperPearsonZeroFailureUpper(100, 1), "confidence");
    expectInputError(() => clopperPearsonZeroFailureUpper(100, 0), "confidence");
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
    expect(r.upper).toBe(V.upper); // deterministic double — see the Clopper-Pearson note
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
    expectInputError(() => wilsonOneSidedUpper(3, 100, { confidence: 0.95, z: 2 }), "z");
    // A confidence with no table row is rejected rather than silently trusted.
    expectInputError(
      () => wilsonOneSidedUpper(3, 100, { confidence: 0.9123, z: 1.6448536269514722 }),
      "confidence",
    );
  });

  test("a z one ulp from the table still passes — the match is toleranced, not exact", () => {
    const nudged = WILSON_Z_BY_CONFIDENCE[0.95] * (1 + Number.EPSILON);
    const r = wilsonOneSidedUpper(3, 100, { confidence: 0.95, z: nudged });
    expect(r.z).toBe(nudged);
  });

  test("an all-failures sample never emits a bound above 1", () => {
    // At p̂ = 1 the Wilson upper limit is exactly 1 analytically, but the float
    // evaluation overshoots for 501 of the first 2000 attempt counts — n = 11
    // gives 1.0000000000000002. A probability above 1 is not a probability.
    const z = WILSON_Z_BY_CONFIDENCE[0.95];
    for (let attempts = 1; attempts <= 2000; attempts++) {
      const { upper } = wilsonOneSidedUpper(attempts, attempts, { confidence: 0.95, z });
      expect(upper, `n=${attempts}`).toBeLessThanOrEqual(1);
    }
    expect(wilsonOneSidedUpper(11, 11, { confidence: 0.95, z }).upper).toBe(1);
  });

  test("rejects failures outside [0, attempts], attempts below one, and a nonpositive z", () => {
    const z = WILSON_Z_BY_CONFIDENCE[0.95];
    expectInputError(() => wilsonOneSidedUpper(-1, 100, { confidence: 0.95, z }), "failures");
    expectInputError(() => wilsonOneSidedUpper(101, 100, { confidence: 0.95, z }), "failures");
    expectInputError(() => wilsonOneSidedUpper(1.5, 100, { confidence: 0.95, z }), "failures");
    expectInputError(() => wilsonOneSidedUpper(0, 0, { confidence: 0.95, z }), "attempts");
    expectInputError(() => wilsonOneSidedUpper(3, 100, { confidence: 0.95, z: 0 }), "z");
    expectInputError(
      () => wilsonOneSidedUpper(3, 100, { confidence: 0.95, z: Number.POSITIVE_INFINITY }),
      "z",
    );
    // NaN is the case that only the finiteness guard can stop. `z: 0` and
    // `z: Infinity` above are both also caught downstream by the
    // (confidence, z) consistency gate, so deleting the guard entirely left
    // this suite green — while `Math.abs(NaN - expectedZ) > 1e-12` is false,
    // letting NaN through the gate and emitting `upper: NaN` into a record
    // the canonical serializer rejects.
    expectInputError(() => wilsonOneSidedUpper(3, 100, { confidence: 0.95, z: Number.NaN }), "z");
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

  test("a well-conditioned design reports the pinned condition estimate", () => {
    const r = olsQr({ columns: V.columns, rows: V.rows });
    expect(r.condition_estimate).toBe(V.condition_estimate);
  });

  test("the rank gate catches a dependent column at ANY scale, not just 1x", () => {
    // The regression test for the gate's original defect. `bytes` is an exact
    // integer multiple of `calls`, so the design is mathematically rank 2 at
    // every multiplier. Against a single global `max|R_kk|` tolerance, a
    // multiplier as small as 9 was enough for the dependent column's rounding
    // residual to clear a bar set by a different column's scale: 2737 of 4800
    // sampled rank-2 designs were accepted as rank 3 and returned coefficients
    // of magnitude 1e13-1e15. The suite only ever exercised multiplier 1, which
    // is the one case that survived.
    for (const multiplier of [1, 9, 100, 1000, 1e6, 1e9, 1e12]) {
      let thrown: unknown;
      try {
        olsQr({
          columns: ["intercept", "calls", "bytes"],
          rows: [
            { x: [1, 1, 1 * multiplier], y: 2 },
            { x: [1, 2, 2 * multiplier], y: 3 },
            { x: [1, 3, 3 * multiplier], y: 5 },
            { x: [1, 4, 4 * multiplier], y: 6 },
          ],
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `multiplier ${multiplier} must be rejected`).toMatchObject({
        code: "SingularDesign",
        rank: 2,
      });
    }
  });

  test("the rank verdict does not depend on the order the columns were listed", () => {
    // Same matrix, permuted. Under a global-scale tolerance this returned
    // rank 3, rank 1, and rank 2 for three permutations of one design.
    const base = [
      { x: [1, 1, 1000], y: 2 },
      { x: [1, 2, 2000], y: 3 },
      { x: [1, 3, 3000], y: 5 },
      { x: [1, 4, 4000], y: 6 },
    ];
    const names = ["intercept", "calls", "bytes"];
    for (const p of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [0, 2, 1],
    ]) {
      let thrown: unknown;
      try {
        olsQr({
          columns: p.map((i) => names[i]!),
          rows: base.map((row) => ({ x: p.map((i) => row.x[i]!), y: row.y })),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `permutation ${p.join("")} must be rejected`).toMatchObject({
        code: "SingularDesign",
        rank: 2,
      });
    }
  });

  test("condition_estimate is invariant to the units a column is measured in", () => {
    // The same model with its size column in bytes, KiB, MiB, GiB, and bits.
    // Identical fit, so the diagnostic must be identical too. Over the RAW
    // diagonal it spanned 1.6e8 to 1.3e18 and the rank verdict FLIPPED — MiB
    // and GiB threw `SingularDesign` where bytes returned rank 3.
    const estimates = [1, 2 ** -10, 2 ** -20, 2 ** -30, 8].map((scale) => {
      const r = olsQr({
        columns: ["intercept", "calls", "size"],
        rows: [
          { x: [1, 1, (1 + 1e-9) * scale], y: 2 },
          { x: [1, 2, (2 - 1e-9) * scale], y: 3 },
          { x: [1, 3, (3 + 1e-9) * scale], y: 5 },
          { x: [1, 4, (4 - 1e-9) * scale], y: 6 },
        ],
      });
      expect(r.rank).toBe(3);
      return r.condition_estimate;
    });
    // Bit-identical, not merely close.
    expect(new Set(estimates).size).toBe(1);
    expect(estimates[0]).toBeGreaterThan(1e6);
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
    } catch (error) {
      thrown = error;
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
    const bad: { input: OlsQrInput; field: string }[] = [
      { input: { columns: [], rows: [{ x: [], y: 1 }] }, field: "columns" },
      {
        input: {
          columns: ["a", "a"],
          rows: [
            { x: [1, 1], y: 1 },
            { x: [2, 2], y: 2 },
          ],
        },
        field: "columns",
      },
      { input: { columns: [" "], rows: [{ x: [1], y: 1 }] }, field: "columns" },
      // fewer rows than columns
      { input: { columns: ["a", "b"], rows: [{ x: [1, 2], y: 1 }] }, field: "rows" },
      // wrong row width
      { input: { columns: ["a"], rows: [{ x: [1, 2], y: 1 }] }, field: "rows" },
      {
        input: { columns: ["a"], rows: [{ x: [Number.POSITIVE_INFINITY], y: 1 }] },
        field: "rows",
      },
      { input: { columns: ["a"], rows: [{ x: [1], y: Number.NaN }] }, field: "rows" },
      { input: { columns: ["a"], rows: [] }, field: "rows" },
    ];
    for (const { input, field } of bad) {
      expectInputError(() => olsQr(input), field);
    }
  });
});

describe("contract surface", () => {
  test("every algorithm tag has exactly one pinned vector, with a well-formed id", () => {
    expect(Object.keys(STATISTICS_TEST_VECTORS).toSorted()).toEqual(
      [...STATISTICS_ALGORITHMS].toSorted(),
    );
    for (const entry of Object.values(STATISTICS_TEST_VECTORS)) {
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9/_-]*\/v1$/);
    }
    expect(PRNG_TEST_VECTOR.id).toMatch(/^[a-z0-9][a-z0-9/_-]*\/v1$/);
  });

  test("every pinned id is distinct", () => {
    const ids = [...Object.values(STATISTICS_TEST_VECTORS).map((e) => e.id), PRNG_TEST_VECTOR.id];
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Composite Simpson over the standard-normal pdf: `Φ(z) = 0.5 + ∫₀^z φ(t)dt`.
   *
   * This is the CDF, not its inverse. It can only ever CHECK a `(confidence, z)`
   * row — it cannot produce a z — so it is not the untagged tenth algorithm the
   * plan's non-goals ban. It lives in the test, never in the module.
   */
  const standardNormalCdf = (z: number, intervals = 20_000): number => {
    const pdf = (t: number): number => Math.exp(-0.5 * t * t) / Math.sqrt(2 * Math.PI);
    const h = z / intervals;
    let sum = pdf(0) + pdf(z);
    for (let i = 1; i < intervals; i++) {
      sum += pdf(i * h) * (i % 2 === 0 ? 2 : 4);
    }
    return 0.5 + (h / 3) * sum;
  };

  test("every table z round-trips through the normal CDF to its own confidence", () => {
    // The table is the module's one load-bearing numeric surface that is NOT in
    // STATISTICS_TEST_VECTORS, and a wrong z ships evidence tagged with a
    // confidence that did not determine the number — the exact failure §4.7
    // exists to prevent. Range and monotonicity checks do not catch that: a z
    // perturbed by 0.2 stays positive, stays under 4, and stays ordered.
    //
    // Every current row lands within 2.6e-15; a 0.2 perturbation lands at
    // 4.2e-3, twelve orders away. 1e-12 separates them with enormous margin
    // while leaving room for the quadrature's own error.
    for (const [confidence, z] of Object.entries(WILSON_Z_BY_CONFIDENCE)) {
      expect(Math.abs(standardNormalCdf(z) - Number(confidence))).toBeLessThan(1e-12);
    }
  });

  test("the round-trip guard is sharp enough to reject a perturbed z", () => {
    // Proves the guard above is not vacuous: without this, a test asserting
    // "z is the normal quantile" could pass while checking nothing of the sort.
    const corrupted = WILSON_Z_BY_CONFIDENCE[0.99] + 0.2;
    expect(Math.abs(standardNormalCdf(corrupted) - 0.99)).toBeGreaterThan(1e-12);
  });

  test("table z values increase with confidence and stay in a plausible range", () => {
    const rows = Object.entries(WILSON_Z_BY_CONFIDENCE)
      .map(([c, z]) => ({ c: Number(c), z }))
      .toSorted((a, b) => a.c - b.c);
    for (const [i, row] of rows.entries()) {
      expect(row.z).toBeGreaterThan(0);
      expect(row.z).toBeLessThan(4);
      if (i > 0) {
        expect(row.z).toBeGreaterThan(rows[i - 1]!.z);
      }
    }
  });
});

describe("canonical-JSON safety", () => {
  /**
   * Lane D's canonical JSON REJECTS `undefined`, `NaN`, `±Infinity`, and `-0`
   * (`canonical-hashing.md` §"rejection contract") — it does not normalize
   * them. Every result object here is serialized into a hashed evidence record,
   * so a single missed `normalizeZero` becomes an opaque rejection inside
   * Plan J. This walks every number of every result shape.
   */
  const assertEmittable = (value: unknown, path = "$"): void => {
    if (typeof value === "number") {
      expect(Number.isFinite(value), `${path} must be finite`).toBe(true);
      expect(Object.is(value, -0), `${path} must not be negative zero`).toBe(false);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertEmittable(v, `${path}[${i}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        expect(v, `${path}.${k} must not be undefined`).not.toBeUndefined();
        assertEmittable(v, `${path}.${k}`);
      }
      return;
    }
    expect(["string", "boolean"], `${path} has an unserializable type`).toContain(typeof value);
  };

  test("every result shape emits only canonical-JSON-safe values", () => {
    const b = STATISTICS_TEST_VECTORS["bootstrap-percentile-v1"];
    const pr = STATISTICS_TEST_VECTORS["paired-ratio-bootstrap-v1"];
    const st = STATISTICS_TEST_VECTORS["stratified-paired-difference-bootstrap-v1"];
    const cp = STATISTICS_TEST_VECTORS["clopper-pearson-zero-failure-upper-v1"];
    const w = STATISTICS_TEST_VECTORS["wilson-one-sided-upper-v1"];
    const o = STATISTICS_TEST_VECTORS["ols-qr-v1"];

    assertEmittable(quantileEstimate(b.values, 0.5, "quantile-r7-v1"));
    assertEmittable(quantileEstimate(b.values, 0, "quantile-nearest-rank-v1"));
    assertEmittable(madEstimate(b.values));
    assertEmittable(bootstrapPercentile(b.values, b.statistic, b.options));
    assertEmittable(bootstrapPercentile(b.values, { algorithm: "mean-v1" }, b.options));
    assertEmittable(pairedRatioBootstrap(pr.pairs, pr.options));
    assertEmittable(stratifiedPairedDifferenceBootstrap(st.pairs, st.options));
    assertEmittable(clopperPearsonZeroFailureUpper(cp.attempts, cp.confidence));
    assertEmittable(
      wilsonOneSidedUpper(w.failures, w.attempts, { confidence: w.confidence, z: w.z }),
    );
    assertEmittable(olsQr({ columns: o.columns, rows: o.rows }));
  });

  test("the zero-coefficient OLS case — the realistic -0 producer — is safe", () => {
    // True intercept exactly 0 over a negative Householder pivot.
    assertEmittable(
      olsQr({
        columns: ["intercept", "x"],
        rows: [
          { x: [1, 1], y: 1 },
          { x: [1, 2], y: 3 },
          { x: [1, 3], y: 2 },
          { x: [1, 4], y: 5 },
        ],
      }),
    );
  });

  test("a single-element -0 sample is normalized on the way out", () => {
    // Replaces a test that asserted `madEstimate([5,5,5]).mad` is not -0. That
    // one could not fail: `madFromMedian` runs every deviation through
    // `Math.abs`, which never returns -0. It read as a pin and pinned nothing.
    //
    // The reachable path is the single-element short-circuit — `quantileR7`
    // returns `sorted[0]` verbatim when n is 1, so a sample of [-0] carries -0
    // straight to `median`, and a q of -0 rides through untouched.
    expect(Object.is(quantileR7([-0], 0.5), -0)).toBe(true); // the raw kernel does emit it
    const m = madEstimate([-0]);
    expect(Object.is(m.median, -0)).toBe(false);
    assertEmittable(m);

    const q = quantileEstimate([-0], -0, "quantile-r7-v1");
    expect(Object.is(q.value, -0)).toBe(false);
    expect(Object.is(q.q, -0)).toBe(false);
    assertEmittable(q);
  });

  /**
   * The guard above walks results exhaustively, but every fixture feeding it is
   * `-0`-free, so it could only ever catch a COMPUTED negative zero. An ECHOED
   * one slipped straight through: `-0` clears `Number.isInteger(v) && v >= 0`
   * and `!(v < 0)` untouched, so a caller parameter carrying `-0` was copied
   * verbatim onto the result. These feed `-0` in deliberately.
   */
  test("a -0 caller parameter is normalized before it reaches the result", () => {
    const b = STATISTICS_TEST_VECTORS["bootstrap-percentile-v1"];

    // seed: -0 arises from `seed: -index` at index 0.
    const seeded = bootstrapPercentile(b.values, b.statistic, { ...b.options, seed: -0 });
    expect(Object.is(seeded.seed, -0)).toBe(false);
    assertEmittable(seeded);

    // statistic.q: -0 arises from `q: -x` at x = 0.
    const q0 = bootstrapPercentile(b.values, { algorithm: "quantile-r7-v1", q: -0 }, b.options);
    expect(Object.is(q0.statistic?.q, -0)).toBe(false);
    assertEmittable(q0);

    // failures: -0 arises from `failures: -count` at count 0.
    const w = wilsonOneSidedUpper(-0, 100, {
      confidence: 0.95,
      z: WILSON_Z_BY_CONFIDENCE[0.95],
    });
    expect(Object.is(w.failures, -0)).toBe(false);
    assertEmittable(w);

    // The other two bootstraps echo `seed` through the same path.
    const pr = STATISTICS_TEST_VECTORS["paired-ratio-bootstrap-v1"];
    const ratio = pairedRatioBootstrap(pr.pairs, { ...pr.options, seed: -0 });
    expect(Object.is(ratio.seed, -0)).toBe(false);
    assertEmittable(ratio);

    const st = STATISTICS_TEST_VECTORS["stratified-paired-difference-bootstrap-v1"];
    const strat = stratifiedPairedDifferenceBootstrap(st.pairs, { ...st.options, seed: -0 });
    expect(Object.is(strat.seed, -0)).toBe(false);
    assertEmittable(strat);
  });

  test("the returned statistic selector is a copy, not the caller's object", () => {
    // Echoing by reference would let a caller mutate an already-emitted evidence
    // record after the fact.
    const b = STATISTICS_TEST_VECTORS["bootstrap-percentile-v1"];
    const selector = { algorithm: "quantile-r7-v1" as const, q: 0.5 };
    const result = bootstrapPercentile(b.values, selector, b.options);
    expect(result.statistic).not.toBe(selector);
    expect(result.statistic).toEqual(selector);
  });
});
