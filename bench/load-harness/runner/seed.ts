/**
 * Seed phase. Consumes a `Dataset` (ticket 51) and issues one
 * `db.collection(collection).insert(...)` per record. No batching at MVP
 * — one `commit()` per row is a different workload shape than
 * "user pastes a CSV"; revisit if a future preset wants bulk-load
 * semantics explicitly.
 *
 * Returns the `StorageSnapshot` captured between the entry and exit
 * of the seed phase. Caller must `storage.reset()` BEFORE calling
 * this function and again before each subsequent phase.
 *
 * Caller is responsible for invoking phases in a valid order; the
 * runner only captures per-phase metrics.
 */

import type { BaerlyConfig } from "@baerly/server";
import type { StorageSnapshot } from "../../types.ts";
import type { CountingStorage } from "../../storage.ts";
import type { Dataset } from "../generators/dataset.ts";
import { makeDbFactory } from "./db-factory.ts";

export interface SeedOpts {
  readonly storage: CountingStorage;
  readonly app: string;
  /** Default tenant when a dataset tenant has no records (degenerate). */
  readonly defaultTenant: string;
  /** Collection name to insert records into. */
  readonly collection: string;
  readonly dataset: Dataset;
  /**
   * Optional {@link BaerlyConfig} forwarded to `Db.create`. The
   * seed phase MUST receive the same config as the replay phases
   * so index entries materialise during seed inserts.
   */
  readonly config?: BaerlyConfig;
}

export interface SeedResult {
  readonly inserted: number;
  readonly wallclockMs: number;
  readonly metrics: StorageSnapshot;
}

export async function runSeed(opts: SeedOpts): Promise<SeedResult> {
  opts.storage.reset();
  const t0 = performance.now();
  let inserted = 0;

  // One `Db` per (app, tenant) — same lifecycle as production.
  const dbFor = makeDbFactory(opts);

  for (const tenant of opts.dataset.tenants) {
    const db = dbFor(tenant.tenantId);
    for (const record of tenant.records) {
      await db.collection(opts.collection).insert({
        _id: record.recordId,
        bytes: record.bytes,
        createdAtMs: record.createdAtMs,
        popularityRank: record.popularityRank,
      });
      inserted++;
    }
  }

  return {
    inserted,
    wallclockMs: performance.now() - t0,
    metrics: opts.storage.snapshot(),
  };
}
