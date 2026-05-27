/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the maintenance test seeds doc bodies with it. */

/**
 * Maintenance — `runScheduledMaintenance()` composition of
 * `compact()` + `runGc()` under `MemoryStorage`. The Cloudflare-side
 * worker test and the Node-side `runMaintenanceTick` test cover the
 * adapter wrappers.
 */

import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, MemoryStorage } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { compact } from "./compactor.ts";
import { runGc, type InternalRunGcOptions } from "./gc.ts";
import {
  CLOUDFLARE_FREE_TIER,
  type InternalMaintenanceOptions,
  runScheduledMaintenance,
} from "./maintenance.ts";
import { Writer } from "./writer.ts";

const KEY = "app/t/tenant/x/manifests/c/current.json";
const COLL = "c";

const bootstrap = async (storage: MemoryStorage, key: string): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "maintenance-test", claimed_at: "" },
  });
};

describe("runScheduledMaintenance", () => {
  test("runs both compact and gc by default", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 150; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const r = await runScheduledMaintenance(
      { storage: s, currentJsonKey: KEY },
      // Bypass GC's 7-day grace so the sweep path actually runs in
      // one tick. Engine defaults are unbounded so a single pass folds
      // the entire live tail.
      { gc: { graceMillis: 0 } as InternalRunGcOptions },
    );
    expect(r.compact.written).toBe(true);
    expect(r.compact.entriesFolded).toBe(150);
    // After compact, [0, 150) become stale-log; GC marks them and the
    // zero-grace lets the same pass sweep them.
    expect(r.gc.marked.stale_log).toBeGreaterThan(0);
  });

  test("runGc alone runs without compact", async () => {
    // Single-phase ticks (e.g. the CF free-tier even/odd-minute cron
    // pattern) invoke the primitive directly instead of
    // `runScheduledMaintenance`.
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r).not.toBeNull();
  });

  test("compact alone runs without gc", async () => {
    // Single-phase ticks invoke the primitive directly instead of
    // `runScheduledMaintenance`.
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 150; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const r = await compact({ storage: s, currentJsonKey: KEY });
    expect(r.written).toBe(true);
  });

  test("CLOUDFLARE_FREE_TIER carries the documented bounds", async () => {
    // A regression in these constants means the budget audits and
    // the per-tier docstring lie about the worst-case I/O profile.
    // The budget caps live on the InternalMaintenanceOptions surface
    // (they're not part of the public `MaintenanceOptions` shape).
    const cfFree = CLOUDFLARE_FREE_TIER as InternalMaintenanceOptions;

    expect(cfFree.compact?.maxEntriesPerRun).toBe(20);
    expect(cfFree.compact?.minEntriesToCompact).toBe(50);
    expect(cfFree.gc?.maxMarksPerRun).toBe(20);
    expect(cfFree.gc?.maxSweepsPerRun).toBe(10);
  });
});
