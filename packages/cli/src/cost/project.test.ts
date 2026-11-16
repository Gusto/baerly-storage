/**
 * Unit tests for the pure projection math in `./project.ts`.
 * Zero I/O — expected bands and monthly operation counts are derived
 * from literal provider rates and profile amplification values.
 */

import { describe, expect, test } from "vitest";
import {
  GRADUATION_ADVISORY_WRITES_PER_MIN,
  GRADUATION_CLASS_A_PER_MONTH,
  type CostProfile,
  type ProviderPricing,
  project,
} from "./project.ts";

const R2: ProviderPricing = {
  provider: "r2",
  freeClassAPerMonth: 1_000_000,
  usdPerMillionClassA: 4.5,
  freeStorageGb: 10,
  usdPerGbMonth: 0.015,
};

const AWS_S3: ProviderPricing = {
  provider: "aws-s3",
  freeClassAPerMonth: 0,
  usdPerMillionClassA: 5,
  freeStorageGb: 0,
  usdPerGbMonth: 0.023,
};

const GCS: ProviderPricing = {
  provider: "gcs",
  freeClassAPerMonth: 5_000,
  usdPerMillionClassA: 5,
  freeStorageGb: 5,
  usdPerGbMonth: 0.02,
};

const SELF_HOSTED: ProviderPricing = {
  provider: "self-hosted",
  freeClassAPerMonth: 0,
  usdPerMillionClassA: Number.NaN,
  freeStorageGb: 0,
  usdPerGbMonth: Number.NaN,
};

const DEV: ProviderPricing = {
  provider: "dev",
  freeClassAPerMonth: 0,
  usdPerMillionClassA: Number.NaN,
  freeStorageGb: 0,
  usdPerGbMonth: Number.NaN,
};

const CF_FREE: CostProfile = { profile: "cf-free", effectiveWriteAmp: 2 };
const NODE: CostProfile = { profile: "node", effectiveWriteAmp: 3 };

const writesPerMinForAwsCost = (usd: number): number =>
  ((usd / 5) * 1_000_000) / (60 * 24 * 30 * 3);

describe("project", () => {
  test.each([
    { usd: 0.001, expected: "<$25" },
    { usd: 24.999, expected: "<$25" },
    { usd: 25, expected: "$25-$50" },
    { usd: 49.999, expected: "$25-$50" },
    { usd: 50, expected: "$50-$100" },
    { usd: 99.999, expected: "$50-$100" },
    { usd: 100, expected: "$100-$250" },
    { usd: 249.999, expected: "$100-$250" },
    { usd: 250, expected: "$250-$500" },
    { usd: 499.999, expected: "$250-$500" },
    { usd: 500, expected: "$500+" },
  ] as const)("AWS modeled cost $usd maps to $expected", ({ usd, expected }) => {
    const trajectory = project(writesPerMinForAwsCost(usd), 0, AWS_S3, NODE);
    expect(trajectory?.projectedUsdBand).toBe(expected);
  });

  test.each([
    { name: "Worker+R2", pricing: R2, profile: CF_FREE, classA: 86_400 },
    { name: "Node+R2", pricing: R2, profile: NODE, classA: 129_600 },
    { name: "Node+S3", pricing: AWS_S3, profile: NODE, classA: 129_600 },
    { name: "Node+GCS", pricing: GCS, profile: NODE, classA: 129_600 },
  ])("$name combines provider pricing with host amplification", ({ pricing, profile, classA }) => {
    const trajectory = project(1, 0, pricing, profile);
    expect(trajectory).toMatchObject({
      provider: pricing.provider,
      profile: profile.profile,
      classAPerMonth: classA,
    });
  });

  test("returns null when writesPerMin is NaN", () => {
    expect(project(Number.NaN, 0, R2, CF_FREE)).toBeNull();
  });

  test("R2 inside the modeled free tier maps to $0", () => {
    const trajectory = project(0.5, 0, R2, CF_FREE);
    expect(trajectory).toMatchObject({
      classAPerMonth: 43_200,
      withinFreeTier: true,
      projectedUsdBand: "$0",
      provider: "r2",
      profile: "cf-free",
    });
  });

  test("GCS inside the eligible-region allowance maps to $0", () => {
    const writesPerMin = 5_000 / (60 * 24 * 30 * 3);
    const trajectory = project(writesPerMin, 0, GCS, NODE);
    expect(trajectory?.classAPerMonth).toBe(5_000);
    expect(trajectory?.withinFreeTier).toBe(true);
    expect(trajectory?.projectedUsdBand).toBe("$0");
  });

  test("the smallest positive R2 overage maps to <$25 without rounding to $0", () => {
    const writesPerMin = (1_000_000 + 1) / (60 * 24 * 30 * 2);
    const trajectory = project(writesPerMin, 0, R2, CF_FREE);
    expect(trajectory?.classAPerMonth).toBe(1_000_001);
    expect(trajectory?.withinFreeTier).toBe(false);
    expect(trajectory?.projectedUsdBand).toBe("<$25");
  });

  test("a modeled provider without a free allowance does not report $0", () => {
    const trajectory = project(0, 0, AWS_S3, NODE);
    expect(trajectory?.withinFreeTier).toBe(false);
    expect(trajectory?.projectedUsdBand).toBe("<$25");
  });

  test.each([
    ["self-hosted", SELF_HOSTED],
    ["dev", DEV],
  ] as const)("%s has no dollar band", (_name, pricing) => {
    const trajectory = project(15, 0, pricing, NODE);
    expect(trajectory?.projectedUsdBand).toBeNull();
    expect(trajectory?.percentOfFreeTier).toBeNull();
    expect(trajectory?.classAPerMonth).toBe(1_944_000);
  });

  test("storage overage contributes to the exact internal cost before banding", () => {
    const trajectory = project(0.001, 15 * 1024 * 1024 * 1024, R2, CF_FREE);
    expect(trajectory?.withinFreeTier).toBe(false);
    expect(trajectory?.projectedUsdBand).toBe("<$25");
  });

  test("the 50M Class A graduation boundary remains exact", () => {
    const writesPerMin = GRADUATION_CLASS_A_PER_MONTH / (60 * 24 * 30 * 2);
    const trajectory = project(writesPerMin, 0, R2, CF_FREE);
    expect(trajectory?.percentOfGraduation).toBeCloseTo(100, 3);
  });

  test("the advisory is keyed to write rate rather than provider/profile amplification", () => {
    const r2 = project(GRADUATION_ADVISORY_WRITES_PER_MIN, 0, R2, CF_FREE);
    const s3 = project(GRADUATION_ADVISORY_WRITES_PER_MIN, 0, AWS_S3, NODE);
    expect(r2?.percentOfAdvisory).toBeCloseTo(100, 3);
    expect(s3?.percentOfAdvisory).toBeCloseTo(100, 3);
  });
});
