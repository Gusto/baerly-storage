/**
 * Pure projection math for the `baerly cost` trajectory output. Zero
 * I/O. Provider prices and measured host profiles are orthogonal inputs:
 * price tables own billing and profiles own write amplification.
 *
 * Three rules:
 *   1. `classAPerMonth = writesPerMin × 60 × 24 × 30 × effectiveWriteAmp`.
 *      The profile's measured amplification includes in-band maintenance;
 *      it is not the one-op commit floor.
 *   2. Exact continuous provider cost is calculated internally and then
 *      mapped to a stable band. `$0` is reserved for a projection wholly
 *      inside a modeled free tier; unmodeled providers return `null`.
 *   3. Non-finite writes/min returns `null`, preserving the estimator's
 *      no-data behavior.
 */

export type ProviderTag = "r2" | "aws-s3" | "gcs" | "self-hosted" | "dev";
export type CostProfileTag = "cf-free" | "node";
export type ProjectedUsdBand =
  | "$0"
  | "<$25"
  | "$25-$50"
  | "$50-$100"
  | "$100-$250"
  | "$250-$500"
  | "$500+";

/** Provider price table, independent of the host that performs writes. */
export interface ProviderPricing {
  readonly provider: ProviderTag;
  /** Free-tier Class A ops per month; 0 if no free tier. */
  readonly freeClassAPerMonth: number;
  /** $/1M Class A above free tier. NaN for self-hosted/dev. */
  readonly usdPerMillionClassA: number;
  /** Free-tier stored GB; 0 if no free tier. */
  readonly freeStorageGb: number;
  /** $/GB-month above free tier. NaN for self-hosted/dev. */
  readonly usdPerGbMonth: number;
}

/** Measured host execution profile, independent of provider pricing. */
export interface CostProfile {
  readonly profile: CostProfileTag;
  /**
   * Effective Class A ops per logical write, including in-band folds
   * and GC. Source:
   * docs/spec/attachments/amortized-write-cost-baseline.json.
   */
  readonly effectiveWriteAmp: number;
}

/**
 * Hard Class A graduation envelope, sustained over seven days. Storage
 * remains a cost signal rather than a hard trigger.
 */
export const GRADUATION_CLASS_A_PER_MONTH = 50_000_000;

/**
 * Provider-agnostic eyes-open advisory crossing. It is keyed to the
 * sampled write rate, so provider/profile amplification changes the
 * displayed band without moving the 100-writes/min threshold.
 */
export const GRADUATION_ADVISORY_WRITES_PER_MIN = 100;

/** What the cost command renders from. */
export interface Trajectory {
  readonly writesPerMin: number;
  readonly classAPerMonth: number;
  /**
   * Percent of the provider's Class A allowance. `null` for providers
   * with no modeled allowance or dollar model.
   */
  readonly percentOfFreeTier: number | null;
  /** Percent of the 50M/month hard graduation envelope. */
  readonly percentOfGraduation: number;
  /** Percent of the provider-agnostic 100 writes/min advisory. */
  readonly percentOfAdvisory: number;
  /**
   * Coarse monthly USD band. `$0` means wholly inside a modeled free
   * tier; `null` means the provider has no dollar model.
   */
  readonly projectedUsdBand: ProjectedUsdBand | null;
  readonly withinFreeTier: boolean;
  readonly provider: ProviderTag;
  readonly profile: CostProfileTag;
}

const bandForPositiveUsd = (usd: number): ProjectedUsdBand => {
  if (usd < 25) {
    return "<$25";
  }
  if (usd < 50) {
    return "$25-$50";
  }
  if (usd < 100) {
    return "$50-$100";
  }
  if (usd < 250) {
    return "$100-$250";
  }
  if (usd < 500) {
    return "$250-$500";
  }
  return "$500+";
};

/**
 * Project a sampled write rate into monthly operations and a stable
 * provider-cost band. Exact continuous USD arithmetic remains internal.
 * Returns `null` when `writesPerMin` is non-finite.
 */
export const project = (
  writesPerMin: number,
  storedBytes: number,
  pricing: ProviderPricing,
  profile: CostProfile,
): Trajectory | null => {
  if (!Number.isFinite(writesPerMin)) {
    return null;
  }

  // Group the exact month/profile multiplier before applying the sampled
  // floating-point rate so known free-tier boundaries do not drift one ULP.
  const classAPerMonth = writesPerMin * (60 * 24 * 30 * profile.effectiveWriteAmp);
  const percentOfGraduation = (classAPerMonth / GRADUATION_CLASS_A_PER_MONTH) * 100;
  const percentOfAdvisory = (writesPerMin / GRADUATION_ADVISORY_WRITES_PER_MIN) * 100;
  const percentOfFreeTier =
    pricing.freeClassAPerMonth > 0 ? (classAPerMonth / pricing.freeClassAPerMonth) * 100 : null;

  const storedGb = storedBytes / (1024 * 1024 * 1024);
  const withinFreeTier =
    pricing.freeClassAPerMonth > 0 &&
    classAPerMonth <= pricing.freeClassAPerMonth &&
    storedGb <= pricing.freeStorageGb;

  let projectedUsdBand: ProjectedUsdBand | null;
  if (Number.isNaN(pricing.usdPerMillionClassA)) {
    projectedUsdBand = null;
  } else if (withinFreeTier) {
    projectedUsdBand = "$0";
  } else {
    const classAOverage = Math.max(0, classAPerMonth - pricing.freeClassAPerMonth);
    const storageOverage = Math.max(0, storedGb - pricing.freeStorageGb);
    const estimatedUsdPerMonth =
      (classAOverage / 1_000_000) * pricing.usdPerMillionClassA +
      storageOverage * pricing.usdPerGbMonth;
    // `$0` is reserved for a projection wholly inside a modeled free tier.
    projectedUsdBand = bandForPositiveUsd(estimatedUsdPerMonth);
  }

  return {
    writesPerMin,
    classAPerMonth,
    percentOfFreeTier,
    percentOfGraduation,
    percentOfAdvisory,
    projectedUsdBand,
    withinFreeTier,
    provider: pricing.provider,
    profile: profile.profile,
  };
};
