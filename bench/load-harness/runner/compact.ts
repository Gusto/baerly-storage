/**
 * Compact phase. Calls `runScheduledMaintenance` sequentially for
 * each `currentJsonKey` in `opts.currentJsonKeys`, using one of the
 * three pre-baked tuning profiles.
 *
 * Sequential per (tenant, table) — `runScheduledMaintenance` is safe
 * to run concurrently against disjoint `currentJsonKey`s but
 * contending against the same key is the contention scenario the
 * r2-contention bench measures separately. Keeping this phase
 * sequential avoids confounding the headline number with
 * self-contention.
 *
 * Caller is responsible for invoking phases in a valid order; the
 * runner only captures per-phase metrics.
 */

import type { Storage } from "@baerly/protocol";
import {
  runScheduledMaintenance,
  NODE_PROFILE,
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
} from "@baerly/server";
import type { StorageSnapshot } from "../../types.ts";
import type { CountingStorage } from "../../storage.ts";

export type CompactProfileName = "NODE_PROFILE" | "CLOUDFLARE_PAID_TIER" | "CLOUDFLARE_FREE_TIER";

export interface CompactOpts {
  readonly storage: CountingStorage;
  readonly currentJsonKeys: readonly string[];
  readonly profile: CompactProfileName;
}

export interface CompactResult {
  readonly perTableEntriesFolded: Record<string, number>;
  readonly wallclockMs: number;
  readonly metrics: StorageSnapshot;
}

// Map profile name strings to the imported `MaintenanceOptions` constants.
const PROFILES = {
  NODE_PROFILE,
  CLOUDFLARE_PAID_TIER,
  CLOUDFLARE_FREE_TIER,
} as const;

export async function runCompact(opts: CompactOpts): Promise<CompactResult> {
  opts.storage.reset();
  const t0 = performance.now();
  const perTableEntriesFolded: Record<string, number> = {};

  for (const key of opts.currentJsonKeys) {
    const res = await runScheduledMaintenance(
      { storage: opts.storage as unknown as Storage, currentJsonKey: key },
      PROFILES[opts.profile],
    );
    perTableEntriesFolded[key] = res.compact?.entriesFolded ?? 0;
  }

  return {
    perTableEntriesFolded,
    wallclockMs: performance.now() - t0,
    metrics: opts.storage.snapshot(),
  };
}
