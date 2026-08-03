import { describe, test, expect } from "vitest";
import { mulberry32 } from "../load-harness/generators/rng.ts";
import type { BootstrapOptions } from "./statistics.ts";
import {
  BOOTSTRAP_PRNG,
  bootstrapPercentile,
  bootstrapPercentileReplicates,
  madEstimate,
  madFromMedian,
  PRNG_TEST_VECTOR,
  quantileEstimate,
  quantileNearestRank,
  quantileR7,
  STATISTICS_ALGORITHMS,
  STATISTICS_TEST_VECTORS,
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
