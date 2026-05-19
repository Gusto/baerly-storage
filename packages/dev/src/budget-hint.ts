import {
  R2_FREE_TIER_CLASS_A_OPS_PER_MONTH,
  R2_FREE_TIER_STORAGE_GB_PER_MONTH,
  STORAGE_OPS_PER_LOGICAL_WRITE,
} from "@baerly/protocol";
import type { DevBannerHint } from "./dev-banner.ts";

const fmt = (n: number): string => {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}k`;
  }
  return String(n);
};

/**
 * One-line free-tier headroom hint suitable for {@link printDevBanner}.
 * Drops the Cloudflare R2 monthly caps next to a write-equivalent
 * derived from {@link STORAGE_OPS_PER_LOGICAL_WRITE} so an author
 * can see roughly how many logical writes their free budget buys.
 */
export const freeTierBudgetHint = (): DevBannerHint => {
  const writesEquiv = R2_FREE_TIER_CLASS_A_OPS_PER_MONTH / STORAGE_OPS_PER_LOGICAL_WRITE;
  return {
    key: "budget",
    value: `R2 free tier · ${fmt(R2_FREE_TIER_CLASS_A_OPS_PER_MONTH)} Class A / mo (~${fmt(writesEquiv)} writes @ ${STORAGE_OPS_PER_LOGICAL_WRITE}× write-amp) · ${R2_FREE_TIER_STORAGE_GB_PER_MONTH} GB-mo storage`,
  };
};
