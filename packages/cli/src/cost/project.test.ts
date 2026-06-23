/**
 * Unit tests for the pure projection math in `./project.ts`.
 * Zero I/O — every case constructs a `ProviderPricing` literal,
 * calls `project()`, asserts on the returned `Trajectory`.
 */

import { describe, expect, test } from "vitest";
import {
  GRADUATION_ADVISORY_WRITES_PER_MIN,
  GRADUATION_CLASS_A_PER_MONTH,
  type ProviderPricing,
  project,
} from "./project.ts";

const R2: ProviderPricing = {
  provider: "r2",
  freeClassAPerMonth: 1_000_000,
  usdPerMillionClassA: 4.5,
  freeStorageGb: 10,
  usdPerGbMonth: 0.015,
  effectiveWriteAmp: 3,
};

const AWS_S3: ProviderPricing = {
  provider: "aws-s3",
  freeClassAPerMonth: 0,
  usdPerMillionClassA: 5,
  freeStorageGb: 0,
  usdPerGbMonth: 0.023,
  effectiveWriteAmp: 4,
};

const SELF_HOSTED: ProviderPricing = {
  provider: "self-hosted",
  freeClassAPerMonth: 0,
  usdPerMillionClassA: Number.NaN,
  freeStorageGb: 0,
  usdPerGbMonth: Number.NaN,
  effectiveWriteAmp: 4,
};

describe("project", () => {
  test("returns null when writesPerMin is NaN (no-data case)", () => {
    expect(project(Number.NaN, 0, R2)).toBeNull();
  });

  test("R2 inside free tier: projectedUsdPerMonth is exactly 0 and withinFreeTier is true", () => {
    // 0.5 writes/min × 60 × 24 × 30 × 3 = 64,800 Class A/mo — well under 1M.
    const t = project(0.5, 0, R2);
    expect(t).not.toBeNull();
    expect(t!.classAPerMonth).toBe(64_800);
    expect(t!.withinFreeTier).toBe(true);
    expect(t!.projectedUsdPerMonth).toBe(0);
    expect(t!.provider).toBe("r2");
  });

  test("R2 above free tier: projectedUsdPerMonth uses paid math on the overage", () => {
    // 15 writes/min × 60 × 24 × 30 × 3 = 1,944,000 Class A/mo.
    // Overage: 944,000. Cost: 0.944 × $4.50 = $4.248.
    const t = project(15, 0, R2);
    expect(t).not.toBeNull();
    expect(t!.classAPerMonth).toBe(1_944_000);
    expect(t!.withinFreeTier).toBe(false);
    expect(t!.projectedUsdPerMonth).toBeCloseTo(4.248, 3);
  });

  test("AWS S3 (no free tier): bill starts at the first op", () => {
    // 0.5 writes/min × 60 × 24 × 30 × 4 = 86,400/mo × $5/1M = $0.432.
    const t = project(0.5, 0, AWS_S3);
    expect(t).not.toBeNull();
    expect(t!.withinFreeTier).toBe(false);
    expect(t!.projectedUsdPerMonth).toBeCloseTo(0.432, 3);
  });

  test("self-hosted: projectedUsdPerMonth and percentOfFreeTier are null; percentages still computed", () => {
    const t = project(15, 0, SELF_HOSTED);
    expect(t).not.toBeNull();
    expect(t!.projectedUsdPerMonth).toBeNull();
    expect(t!.percentOfFreeTier).toBeNull();
    expect(t!.classAPerMonth).toBe(2_592_000);
    expect(t!.percentOfGraduation).toBeCloseTo((2_592_000 / GRADUATION_CLASS_A_PER_MONTH) * 100, 3);
  });

  test("write-amp constant: classAPerMonth = writesPerMin × 60 × 24 × 30 × effectiveWriteAmp", () => {
    const t = project(1, 0, R2);
    expect(t!.classAPerMonth).toBe(1 * 60 * 24 * 30 * 3);
  });

  test("percentOfGraduation: 50M Class A/mo → 100%", () => {
    // Need writesPerMin such that writesPerMin × 60 × 24 × 30 × 3 = 50_000_000.
    const wpm = GRADUATION_CLASS_A_PER_MONTH / (60 * 24 * 30 * 3);
    const t = project(wpm, 0, R2);
    expect(t!.percentOfGraduation).toBeCloseTo(100, 3);
  });

  test("percentOfFreeTier: R2 with classA exactly at free-tier ceiling → 100%", () => {
    // Need writesPerMin such that classAPerMonth = 1_000_000.
    const wpm = 1_000_000 / (60 * 24 * 30 * 3);
    const t = project(wpm, 0, R2);
    expect(t!.percentOfFreeTier).toBeCloseTo(100, 3);
    expect(t!.withinFreeTier).toBe(true); // boundary is inclusive
  });

  test("R2 over storage free tier alone: storage overage billed at $0.015/GB-mo", () => {
    // 15 GB stored, tiny rate keeps Class A inside free tier
    // → storage overage 5 GB × $0.015 = $0.075
    const t = project(0.001, 15 * 1024 * 1024 * 1024, R2);
    expect(t).not.toBeNull();
    expect(t!.withinFreeTier).toBe(false); // storage exceeds free tier
    expect(t!.projectedUsdPerMonth).toBeCloseTo(5 * 0.015, 4);
  });

  test("R2 with both Class A AND storage overages: bill sums both terms", () => {
    // 15 writes/min → 1,944,000 Class A (overage 944,000 → $4.248)
    // 15 GB stored → storage overage 5 GB → $0.075
    // Expected total: $4.323
    const t = project(15, 15 * 1024 * 1024 * 1024, R2);
    expect(t).not.toBeNull();
    expect(t!.projectedUsdPerMonth).toBeCloseTo(4.248 + 5 * 0.015, 3);
  });

  test("R2 between 50% and 100% of free tier: still withinFreeTier=true, percentOfFreeTier in [50, 100]", () => {
    // classAPerMonth = 750_000 → 75% of free tier (1M).
    // writesPerMin = 750_000 / (60 × 24 × 30 × 3) ≈ 5.79.
    const wpm = 750_000 / (60 * 24 * 30 * 3);
    const t = project(wpm, 0, R2);
    expect(t).not.toBeNull();
    expect(t!.withinFreeTier).toBe(true);
    expect(t!.percentOfFreeTier).not.toBeNull();
    expect(t!.percentOfFreeTier!).toBeGreaterThanOrEqual(50);
    expect(t!.percentOfFreeTier!).toBeLessThan(100);
  });

  test("percentOfAdvisory: exactly at the 100-writes/min advisory rate → 100%, on every provider", () => {
    // The advisory is a write-RATE crossing, not an absolute Class A count,
    // so a provider's write-amp must NOT shift where it fires.
    const r2 = project(GRADUATION_ADVISORY_WRITES_PER_MIN, 0, R2);
    const s3 = project(GRADUATION_ADVISORY_WRITES_PER_MIN, 0, AWS_S3);
    expect(r2).not.toBeNull();
    expect(s3).not.toBeNull();
    expect(r2!.percentOfAdvisory).toBeCloseTo(100, 3);
    expect(s3!.percentOfAdvisory).toBeCloseTo(100, 3);
  });

  test("percentOfAdvisory: at half the advisory write rate → 50%", () => {
    const t = project(GRADUATION_ADVISORY_WRITES_PER_MIN / 2, 0, R2);
    expect(t).not.toBeNull();
    expect(t!.percentOfAdvisory).toBeCloseTo(50, 3);
  });

  test("percentOfAdvisory: at the 50M Class A/mo R2 graduation rate → well past 100%", () => {
    // R2 graduation rate (writesPerMin), expressed as a percent of the
    // 100-writes/min advisory: ~385.8 writes/min ⇒ ~386%.
    const wpm = GRADUATION_CLASS_A_PER_MONTH / (60 * 24 * 30 * 3);
    const t = project(wpm, 0, R2);
    expect(t).not.toBeNull();
    expect(t!.percentOfAdvisory).toBeCloseTo((wpm / GRADUATION_ADVISORY_WRITES_PER_MIN) * 100, 1);
    expect(t!.percentOfAdvisory).toBeGreaterThan(100);
  });

  test("percentOfAdvisory is always finite (self-hosted provider)", () => {
    const t = project(100, 0, SELF_HOSTED);
    expect(t).not.toBeNull();
    expect(Number.isFinite(t!.percentOfAdvisory)).toBe(true);
  });
});
