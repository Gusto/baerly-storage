/**
 * Pure projection math for the `baerly inspect` cost-trajectory
 * footer. Zero I/O. Price tables live as top-level constants; every
 * change MUST be paired with a `docs/about/pricing-log.md` entry.
 *
 * Three rules:
 *   1. `classAPerMonth = writesPerMin × 60 × 24 × 30 × effectiveWriteAmp`
 *      where `effectiveWriteAmp` (≈3 on Cloudflare, ≈4 on Node) is the
 *      measured Class A ops/write INCLUDING in-band maintenance — see
 *      `docs/spec/attachments/amortized-write-cost-baseline.json`. The
 *      old "× 2" was the commit FLOOR only and undercounted maintenance.
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
  /**
   * Effective Class A ops per logical write, INCLUDING in-band
   * maintenance (folds + GC) — NOT just the 2-op commit floor.
   * Empirically measured: ~3 on Cloudflare (cf-free profile), ~4 on
   * serverful Node (gcInterval=2 ⇒ ~2× the GC LISTs). Source:
   * docs/spec/attachments/amortized-write-cost-baseline.json (bench
   * `pnpm bench:amortized-write-cost`). Provider is the host proxy:
   * r2 ⇒ Cloudflare ⇒ 3; aws-s3 ⇒ Node ⇒ 4.
   */
  readonly effectiveWriteAmp: number;
}

/**
 * Graduation triggers — sustained for 7 days, any one of these
 * means the workload has outgrown baerly-storage's positioning.
 *
 * Source: `docs/about/cost-model.md:159-163`.
 */
export const GRADUATION_CLASS_A_PER_MONTH = 50_000_000;
/**
 * Advisory crossing — eyes-open signal, NOT a hard stop.
 *
 * Keyed to a sustained WRITE RATE (100 writes/min, account-wide), not an
 * absolute Class A count, so it fires at the same workload on every
 * provider regardless of write-amp. On R2 (×3) that is ~13M Class A/mo
 * (~$54/mo object-storage ops); on S3 (×4) ~17.3M Class A/mo (~$86/mo).
 * The previous absolute 13M-Class-A threshold was R2-derived and, applied
 * to S3, fired at ~75 writes/min (~$65/mo) while the rendered note quoted
 * the 100-writes/min figure (~$86) — provider-inconsistent. Fires before
 * the 50M hard trigger to surface the ops-vs-cost tradeoff: object storage
 * buys zero ops / no on-call / no migration; a managed DB trades those
 * dollars for a schema, SQL, and an ops surface. Does NOT change the 50M
 * hard trigger.
 */
export const GRADUATION_ADVISORY_WRITES_PER_MIN = 100;
// Storage graduation is a COST SIGNAL at the ~10 GB R2 free-tier line,
// not a hard trigger — intentionally not represented as a graduation
// constant. `storedBytes` feeds the dollar projection (storage overage)
// but the projection surfaces no storage graduation %; the tooling
// tracks only the 50M Class A/mo trigger. See cost-model.md. (The
// historic `effective write-amp > 6` trigger is retired — see
// pricing-log.md 2026-06-22 — and is not represented here either.)

/** What the inspect footer renders from. */
export interface Trajectory {
  readonly writesPerMin: number;
  readonly classAPerMonth: number;
  /** Percent of provider's free-tier Class A budget. `null` when the provider has no free tier (aws-s3) or no $ model (self-hosted/dev). */
  readonly percentOfFreeTier: number | null;
  /** Percent of the 50M/mo graduation trigger. Always a finite number. */
  readonly percentOfGraduation: number;
  /** Percent of the 100-writes/min advisory threshold (provider-agnostic). Always a finite number. */
  readonly percentOfAdvisory: number;
  /** Projected USD/month. `0` when fully inside the free tier. `null` when the provider has no $ model (self-hosted/dev). */
  readonly projectedUsdPerMonth: number | null;
  readonly withinFreeTier: boolean;
  readonly provider: ProviderPricing["provider"];
}

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
  if (!Number.isFinite(writesPerMin)) {
    return null;
  }

  const classAPerMonth = writesPerMin * 60 * 24 * 30 * pricing.effectiveWriteAmp;

  const percentOfGraduation = (classAPerMonth / GRADUATION_CLASS_A_PER_MONTH) * 100;
  // Advisory is a write-RATE crossing (provider-agnostic), not an absolute
  // Class A count — so it fires at the same 100 writes/min on R2 and S3
  // alike, rather than at a lower S3 rate where the rendered cost note
  // would be wrong. See GRADUATION_ADVISORY_WRITES_PER_MIN.
  const percentOfAdvisory = (writesPerMin / GRADUATION_ADVISORY_WRITES_PER_MIN) * 100;

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
    percentOfAdvisory,
    projectedUsdPerMonth,
    withinFreeTier,
    provider: pricing.provider,
  };
};
