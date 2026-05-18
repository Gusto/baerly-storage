/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the maintenance test seeds doc bodies with it. */

/**
 * Maintenance — `runScheduledMaintenance()` composition of
 * `compact()` + `runGc()` under `MemoryStorage`. The Cloudflare-side
 * worker test and the Node-side `runMaintenanceTick` test cover the
 * adapter wrappers.
 */

import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, MemoryStorage } from "@baerly/protocol";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compact } from "./compactor.ts";
import { runGc, type InternalRunGcOptions } from "./gc.ts";
import {
  CLOUDFLARE_FREE_TIER,
  type InternalMaintenanceOptions,
  runScheduledMaintenance,
} from "./maintenance.ts";
import { configureObservability } from "./observability/index.ts";
import { ServerWriter } from "./server-writer.ts";

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
  it("runs both compact and gc by default", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
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

  it("runGc alone runs without compact", async () => {
    // Single-phase ticks (e.g. the CF free-tier even/odd-minute cron
    // pattern) invoke the primitive directly instead of
    // `runScheduledMaintenance`.
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r).not.toBeNull();
  });

  it("compact alone runs without gc", async () => {
    // Single-phase ticks invoke the primitive directly instead of
    // `runScheduledMaintenance`.
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
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

  describe("observability", () => {
    let records: LogRecord[];
    let sink: Sink;

    beforeEach(async () => {
      records = [];
      sink = (r) => records.push(r);
      await configureObservability({ level: "debug", sink, sampleRate: 1 });
    });

    afterEach(async () => {
      await reset();
    });

    it("emits one canonical line at info level on the baerly.maintenance category", async () => {
      const s = new MemoryStorage();
      await bootstrap(s, KEY);
      await runScheduledMaintenance({ storage: s, currentJsonKey: KEY }, {});
      const maintenanceLines = records.filter((r) => r.category.join(".") === "baerly.maintenance");
      expect(maintenanceLines).toHaveLength(1);
      expect(maintenanceLines[0]!.level).toBe("info");
      expect(maintenanceLines[0]!.properties["outcome"]).toBe("ok");
    });

    it("emits no nested baerly.compactor or baerly.gc lines under runScheduledMaintenance", async () => {
      // `compact()` and `runGc()` are nesting-aware via
      // `withObservability` — when called inside an outer scope, they
      // inherit the outer ctx+recorder instead of opening their own.
      // One unit-of-work (the maintenance tick) → exactly one
      // canonical line, per canonical.ts's documented invariant.
      const s = new MemoryStorage();
      await bootstrap(s, KEY);
      await runScheduledMaintenance({ storage: s, currentJsonKey: KEY }, {});
      const compactorLines = records.filter((r) => r.category.join(".") === "baerly.compactor");
      const gcLines = records.filter((r) => r.category.join(".") === "baerly.gc");
      expect(compactorLines).toHaveLength(0);
      expect(gcLines).toHaveLength(0);
    });

    it("standalone compact() still emits its own baerly.compactor canonical line", async () => {
      const s = new MemoryStorage();
      await bootstrap(s, KEY);
      await compact({ storage: s, currentJsonKey: KEY });
      const lines = records.filter((r) => r.category.join(".") === "baerly.compactor");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.properties["outcome"]).toBe("ok");
    });

    it("standalone runGc() still emits its own baerly.gc canonical line", async () => {
      const s = new MemoryStorage();
      await bootstrap(s, KEY);
      await runGc({ storage: s, currentJsonKey: KEY });
      const lines = records.filter((r) => r.category.join(".") === "baerly.gc");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.properties["outcome"]).toBe("ok");
    });

    it("enriches the canonical line with compact_written / gc_swept + recorder-bag fields", async () => {
      // Drive a real compact+GC pass so both phases emit their
      // recorder-bag metrics (`db.compact.entries_folded`,
      // `db.gc.swept_total`, etc.) and the explicit operator-
      // facing fields land alongside them.
      const s = new MemoryStorage();
      await bootstrap(s, KEY);
      const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
      for (let i = 0; i < 150; i++) {
        await writer.commit({
          op: "I",
          collection: COLL,
          docId: `d${i}`,
          body: { _id: `d${i}`, n: i },
        });
      }
      await runScheduledMaintenance(
        { storage: s, currentJsonKey: KEY },
        // Bypass GC's 7-day grace so the sweep path actually runs in
        // one tick and `db.gc.swept_total` lands on the canonical
        // line's recorder bag.
        { gc: { graceMillis: 0 } as InternalRunGcOptions },
      );

      const maintenanceLines = records.filter((r) => r.category.join(".") === "baerly.maintenance");
      expect(maintenanceLines).toHaveLength(1);
      const props = maintenanceLines[0]!.properties;

      // Explicit operator-facing fields (the T04 enrichment).
      expect(props["compact_written"]).toBe(150);
      expect(props["gc_swept"]).toBeGreaterThan(0);

      // Recorder-bag fields stay on the line. `db.compact.entries_folded`
      // is a histogram so it expands into `_p50` / `_count` / `_sum`;
      // `db.gc.swept_total` is a counter so it expands into `_total`.
      expect(props["db.compact.entries_folded_count"]).toBe(1);
      expect(props["db.compact.entries_folded_p50"]).toBe(150);
      expect(typeof props["db.gc.swept_total"]).toBe("number");
      expect(props["db.gc.swept_total"]).toBeGreaterThan(0);
    });
  });

  it("CLOUDFLARE_FREE_TIER carries the documented bounds", async () => {
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
