/**
 * Provider sniffer: maps a bucket URI + optional S3 endpoint into a
 * pricing tag, and resolves that tag into a `ProviderPricing`
 * record. Pure — zero I/O.
 *
 * Detection rules (first match wins):
 *   - `file://*`               → "dev"
 *   - `memory://*`             → "dev"
 *   - `gcs://*`                → "gcs"
 *   - `s3://*` + endpoint matching `*.r2.cloudflarestorage.com` → "r2"
 *   - `s3://*` + endpoint matching `*.amazonaws.com`            → "aws-s3"
 *   - `s3://*` + no endpoint                                    → "aws-s3"
 *   - everything else (Minio, Backblaze, on-prem, unknown s3 endpoint) → "self-hosted"
 *
 * `override` skips detection entirely — used by the
 * `baerly inspect --provider=...` CLI flag when auto-detection picks
 * wrong (e.g., a self-hosted S3 gateway in front of R2).
 */

import type { CostProfile, CostProfileTag, ProviderPricing, ProviderTag } from "./project.ts";

export type { ProviderTag } from "./project.ts";

export interface DetectArgs {
  /** Raw bucket URI as passed on the CLI (s3://, file://, memory://). */
  readonly bucketUri: string;
  /** Effective S3 endpoint at parse time (typically `process.env["BAERLY_S3_ENDPOINT"]`). */
  readonly s3Endpoint?: string;
  /** When set, skip detection and return this tag. */
  readonly override?: ProviderTag;
}

export const detectProvider = (args: DetectArgs): ProviderTag => {
  if (args.override !== undefined) {
    return args.override;
  }
  if (args.bucketUri.startsWith("file://")) {
    return "dev";
  }
  if (args.bucketUri.startsWith("memory://")) {
    return "dev";
  }
  if (args.bucketUri.startsWith("gcs://")) {
    return "gcs";
  }
  if (!args.bucketUri.startsWith("s3://")) {
    return "self-hosted";
  }
  // s3:// branch — look at the endpoint.
  const endpoint = args.s3Endpoint ?? "";
  if (endpoint === "") {
    return "aws-s3";
  } // default AWS
  if (/\.r2\.cloudflarestorage\.com(:\d+)?\/?$/i.test(endpoint)) {
    return "r2";
  }
  if (/\.amazonaws\.com(:\d+)?\/?$/i.test(endpoint)) {
    return "aws-s3";
  }
  return "self-hosted";
};

/**
 * R2 price table.
 * Source: <https://developers.cloudflare.com/r2/pricing/> (review date 2026-05-17).
 * Change-control: pair every edit with a `docs/about/pricing-log.md` entry.
 */
const R2_PRICING: ProviderPricing = {
  provider: "r2",
  freeClassAPerMonth: 1_000_000,
  usdPerMillionClassA: 4.5,
  freeStorageGb: 10,
  usdPerGbMonth: 0.015,
};

/**
 * AWS S3 (Standard) price table.
 * Source: <https://aws.amazon.com/s3/pricing/> (review date 2026-05-17).
 * The 12-month new-account free tier is intentionally excluded
 * (most operators are past it; reporting $0 to them would lie).
 */
const AWS_S3_PRICING: ProviderPricing = {
  provider: "aws-s3",
  freeClassAPerMonth: 0,
  usdPerMillionClassA: 5,
  freeStorageGb: 0,
  usdPerGbMonth: 0.023,
};

/** Locations where the Always Free allowance applies. */
export const GCS_ALWAYS_FREE_REGIONS: readonly string[] = ["us-west1", "us-central1", "us-east1"];

/**
 * Google Cloud Storage Standard, flat-namespace, regional price table.
 * The allowance applies only in the eligible US regions documented by
 * `docs/about/cost-model.md`; the CLI discloses that condition.
 */
const GCS_PRICING: ProviderPricing = {
  provider: "gcs",
  freeClassAPerMonth: 5_000,
  usdPerMillionClassA: 5,
  freeStorageGb: 5,
  usdPerGbMonth: 0.02,
};

const SELF_HOSTED_PRICING: ProviderPricing = {
  provider: "self-hosted",
  freeClassAPerMonth: 0,
  usdPerMillionClassA: Number.NaN,
  freeStorageGb: 0,
  usdPerGbMonth: Number.NaN,
};

const DEV_PRICING: ProviderPricing = {
  provider: "dev",
  freeClassAPerMonth: 0,
  usdPerMillionClassA: Number.NaN,
  freeStorageGb: 0,
  usdPerGbMonth: Number.NaN,
};

const CF_FREE_PROFILE: CostProfile = {
  profile: "cf-free",
  effectiveWriteAmp: 2,
};

const NODE_PROFILE: CostProfile = {
  profile: "node",
  effectiveWriteAmp: 3,
};

export const costProfileFor = (profile: CostProfileTag): CostProfile =>
  profile === "cf-free" ? CF_FREE_PROFILE : NODE_PROFILE;

export const defaultCostProfileFor = (provider: ProviderTag): CostProfileTag =>
  provider === "r2" ? "cf-free" : "node";

/**
 * GCS pricing for a bucket in `region`. Outside {@link GCS_ALWAYS_FREE_REGIONS}
 * the free allowance is dropped; the per-op and per-GB rates stay the
 * US-regional ones, which the CLI discloses as modeled.
 */
export const gcsPricingForRegion = (region: string | undefined): ProviderPricing =>
  region === undefined || GCS_ALWAYS_FREE_REGIONS.includes(region.toLowerCase())
    ? GCS_PRICING
    : { ...GCS_PRICING, freeClassAPerMonth: 0, freeStorageGb: 0 };

export const pricingFor = (provider: ProviderTag): ProviderPricing => {
  switch (provider) {
    case "r2": {
      return R2_PRICING;
    }
    case "aws-s3": {
      return AWS_S3_PRICING;
    }
    case "gcs": {
      return GCS_PRICING;
    }
    case "self-hosted": {
      return SELF_HOSTED_PRICING;
    }
    case "dev": {
      return DEV_PRICING;
    }
  }
};
