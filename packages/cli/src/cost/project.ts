/**
 * Pure projection math for the `baerly inspect` cost-trajectory
 * footer. Zero I/O. Price tables live as top-level constants; every
 * change MUST be paired with a `docs/about/pricing-log.md` entry.
 *
 * Three rules:
 *   1. `classAPerMonth = writesPerMin × 60 × 24 × 30 × 3`. The `× 3`
 *      is the protocol's enforced write-amp ceiling
 *      (`docs/about/cost-model.md:43-44`); snapshot writes
 *      amortize and are excluded from the headline.
 *   2. `projectedUsdPerMonth = 0` exactly when both `classAPerMonth
 *      ≤ pricing.freeClassAPerMonth` AND `storedBytes ≤
 *      pricing.freeStorageGb × 1GB`. Say `$0`, not `$0.00`. `null`
 *      for self-hosted/dev (no $ model).
 *   3. Returns `null` when `writesPerMin` is non-finite (no-data case
 *      from `estimateWritesPerMin`); inspect renders no footer.
 */

/** R2 / AWS S3 / self-hosted / dev price table. */
export interface ProviderPricing {
  readonly provider: "r2" | "aws-s3" | "self-hosted" | "dev";
  /** Free-tier Class A ops per month; 0 if no free tier. */
  readonly freeClassAPerMonth: number;
  /** $/1M Class A above free tier. NaN for "self-hosted" / "dev". */
  readonly usdPerMillionClassA: number;
  /** Free-tier stored GB; 0 if no free tier. */
  readonly freeStorageGb: number;
  /** $/GB-month above free tier. NaN for "self-hosted" / "dev". */
  readonly usdPerGbMonth: number;
}

/**
 * Graduation triggers — sustained for 7 days, any one of these
 * means the workload has outgrown Baerly's positioning.
 *
 * Source: `docs/about/cost-model.md:159-163`.
 */
export const GRADUATION_CLASS_A_PER_MONTH = 50_000_000;
export const GRADUATION_WRITE_AMP = 6;
export const GRADUATION_STORED_BYTES = 5 * 1024 * 1024 * 1024;

/** What the inspect footer renders from. */
export interface Trajectory {
  readonly writesPerMin: number;
  readonly classAPerMonth: number;
  /** Percent of provider's free-tier Class A budget. `null` when the provider has no free tier (aws-s3) or no $ model (self-hosted/dev). */
  readonly percentOfFreeTier: number | null;
  /** Percent of the 50M/mo graduation trigger. Always a finite number. */
  readonly percentOfGraduation: number;
  /** Projected USD/month. `0` when fully inside the free tier. `null` when the provider has no $ model (self-hosted/dev). */
  readonly projectedUsdPerMonth: number | null;
  readonly withinFreeTier: boolean;
  readonly provider: ProviderPricing["provider"];
}

/**
 * Protocol write-amp ceiling: every logical write produces exactly
 * 3 Class A ops (PUT content + PUT log entry + CAS-advance
 * current.json). Source: `docs/about/cost-model.md:43-44`.
 */
const PROTOCOL_WRITE_AMP = 3;

/** Minutes per month × write-amp = Class A ops/month per write/min. */
const OPS_PER_WPM_PER_MONTH = 60 * 24 * 30 * PROTOCOL_WRITE_AMP;

/**
 * Project a `writesPerMin` rate (typically from
 * `estimateWritesPerMin`) into a monthly cost trajectory.
 *
 * Returns `null` when `writesPerMin` is non-finite. The caller
 * (inspect) renders no footer in that case.
 */
export const project = (
  writesPerMin: number,
  storedBytes: number,
  pricing: ProviderPricing,
): Trajectory | null => {
  if (!Number.isFinite(writesPerMin)) return null;

  const classAPerMonth = writesPerMin * OPS_PER_WPM_PER_MONTH;

  const percentOfGraduation = (classAPerMonth / GRADUATION_CLASS_A_PER_MONTH) * 100;

  const percentOfFreeTier =
    pricing.freeClassAPerMonth > 0 ? (classAPerMonth / pricing.freeClassAPerMonth) * 100 : null;

  const storedGb = storedBytes / (1024 * 1024 * 1024);
  const withinFreeTier =
    pricing.freeClassAPerMonth > 0 &&
    classAPerMonth <= pricing.freeClassAPerMonth &&
    storedGb <= pricing.freeStorageGb;

  let projectedUsdPerMonth: number | null;
  if (Number.isNaN(pricing.usdPerMillionClassA)) {
    projectedUsdPerMonth = null;
  } else if (withinFreeTier) {
    projectedUsdPerMonth = 0;
  } else {
    const classAOverage = Math.max(0, classAPerMonth - pricing.freeClassAPerMonth);
    const storageOverage = Math.max(0, storedGb - pricing.freeStorageGb);
    projectedUsdPerMonth =
      (classAOverage / 1_000_000) * pricing.usdPerMillionClassA +
      storageOverage * pricing.usdPerGbMonth;
  }

  return {
    writesPerMin,
    classAPerMonth,
    percentOfFreeTier,
    percentOfGraduation,
    projectedUsdPerMonth,
    withinFreeTier,
    provider: pricing.provider,
  };
};
