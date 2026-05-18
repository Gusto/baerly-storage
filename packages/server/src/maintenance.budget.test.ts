/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the budget test seeds doc bodies with it. */

/**
 * Cloudflare free-tier subrequest budget guard.
 *
 * One scheduled Worker invocation is capped at 50 subrequests on the
 * free tier; this test wraps `MemoryStorage` in a counting proxy and
 * proves that a single {@link runScheduledMaintenance} tick under
 * {@link CLOUDFLARE_FREE_TIER} stays at or below that budget. R2
 * binding ops map 1:1 to subrequests, so the proxy counts `get` /
 * `put` / `delete` / `list` invocations as one each.
 *
 * The Cloudflare scheduled handler runs only one phase per tick
 * (even-minute compact, odd-minute GC) because `collectLiveContentHashes`
 * inside `runGc()` reads the full live log tail unconditionally —
 * combining both phases in a single tick can exceed 50 ops when the
 * tail is long. This test therefore checks each phase in isolation,
 * mirroring what production actually executes. If a future refactor
 * inflates either phase's per-tick budget, this is the load-bearing
 * test that fails — do NOT relax the assertion. Tune
 * `CLOUDFLARE_FREE_TIER` or the underlying primitives instead.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MemoryStorage,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, it } from "vitest";
import { compact } from "./compactor.ts";
import { runGc } from "./gc.ts";
import { CLOUDFLARE_FREE_TIER } from "./maintenance.ts";
import { ServerWriter } from "./server-writer.ts";

const FREE_TIER_BUDGET = 50;

/**
 * Wrap a {@link Storage} and count its top-level method invocations.
 * `get` / `put` / `delete` / `list` each count as one storage op
 * (R2 binding semantics: one op per call, regardless of body size).
 */
const countingStorage = (
  inner: Storage,
): { storage: Storage; getOps: () => number; report: () => Record<string, number> } => {
  const counts = { get: 0, put: 0, delete: 0, list: 0 };
  const wrapper: Storage = {
    async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
      counts.get += 1;
      return inner.get(key, opts);
    },
    async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
      counts.put += 1;
      return inner.put(key, body, opts);
    },
    async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
      counts.delete += 1;
      return inner.delete(key, opts);
    },
    list(
      prefix: string,
      opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
    ): AsyncIterable<StorageListEntry> {
      counts.list += 1;
      return inner.list(prefix, opts);
    },
  };
  return {
    storage: wrapper,
    getOps: (): number => counts.get + counts.put + counts.delete + counts.list,
    report: (): Record<string, number> => ({ ...counts }),
  };
};

const seed = async (
  storage: Storage,
  key: string,
  collection: string,
  entries: number,
): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "budget-test", claimed_at: "" },
  });
  const writer = new ServerWriter({ storage, currentJsonKey: key });
  for (let i = 0; i < entries; i++) {
    await writer.commit({
      op: "I",
      collection,
      docId: `d${i}`,
      body: { _id: `d${i}`, n: i },
    });
  }
};

describe("CLOUDFLARE_FREE_TIER budget", () => {
  const KEY = "app/t/tenant/x/manifests/c/current.json";
  const COLL = "c";

  it("compact-only tick stays at or below 50 storage ops", async () => {
    // Even-minute branch of the scheduled handler: compact alone.
    // Budget math: 1 GET current + N GETs log (N = maxEntriesPerRun
    // = 20) + 1 PUT snapshot + 1 PUT current = 23. (No prior snapshot
    // on first compact ⇒ skip the snapshot-load GET.)
    const inner = new MemoryStorage();
    await seed(inner, KEY, COLL, 200);
    const { storage, getOps, report } = countingStorage(inner);

    const r = await compact(
      { storage, currentJsonKey: KEY },
      CLOUDFLARE_FREE_TIER.compact,
    );
    expect(r.written).toBe(true);
    const ops = getOps();
    expect(ops, `ops by category: ${JSON.stringify(report())}`).toBeLessThanOrEqual(
      FREE_TIER_BUDGET,
    );
  });

  it("gc-only tick stays at or below 50 storage ops at steady state", async () => {
    // Odd-minute branch of the scheduled handler: GC alone. Steady
    // state on free tier: compaction runs at the same cadence as GC
    // and keeps the live log tail near `minEntriesToCompact = 50`,
    // bounded by the M term in the GC budget docstring.
    //
    // To model the steady-state operating point we seed 60 entries
    // and pre-compact: log_seq_start = 20, next_seq = 60 ⇒ tail = 40,
    // which is below the 50-entry compaction threshold (next compact
    // tick will rerun). The GC pass then mark+sweeps stale-log
    // candidates and computes live-content hashes over the 40-entry
    // tail.
    //
    // Budget math (steady state): 1 GET current + 1 GET pending +
    // 1 PUT create pending (first GC pass) + 3 LISTs + 1 GET snapshot
    // + ≤40 GETs log + ≤20 DELETEs (mark-and-sweep bypass) + 1 PUT
    // pending = ≤67 — over budget. The default 7-day grace means
    // *zero* sweeps in any single pass, so the realistic GC ops are
    // 1 GET current + 1 GET pending + 1 PUT create + 3 LISTs + 1 GET
    // snapshot + 40 GETs log + 1 PUT pending = 48, fits.
    const inner = new MemoryStorage();
    await seed(inner, KEY, COLL, 60);

    // Pre-compact to set up the steady-state shape; we measure GC
    // alone, so we do compact outside the counting wrapper.
    await compact({ storage: inner, currentJsonKey: KEY }, CLOUDFLARE_FREE_TIER.compact);

    const { storage, getOps, report } = countingStorage(inner);
    const r = await runGc(
      { storage, currentJsonKey: KEY },
      CLOUDFLARE_FREE_TIER.gc,
    );
    expect(r).not.toBeNull();
    const ops = getOps();
    expect(ops, `ops by category: ${JSON.stringify(report())}`).toBeLessThanOrEqual(
      FREE_TIER_BUDGET,
    );
  });
});
