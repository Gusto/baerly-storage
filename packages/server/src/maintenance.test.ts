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
import {
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  NODE_PROFILE,
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
      // one tick. Compact's bounds come from NODE_PROFILE.
      { ...NODE_PROFILE, gc: { ...NODE_PROFILE.gc, graceMillis: 0 } },
    );
    expect(r.compact?.written).toBe(true);
    expect(r.compact?.entriesFolded).toBe(150);
    // After compact, [0, 150) become stale-log; GC marks them and the
    // zero-grace lets the same pass sweep them.
    expect(r.gc).not.toBeNull();
    expect(r.gc?.marked.stale_log).toBeGreaterThan(0);
  });

  it("skipCompact runs gc only", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const r = await runScheduledMaintenance(
      { storage: s, currentJsonKey: KEY },
      { skipCompact: true },
    );
    expect(r.compact).toBeNull();
    expect(r.gc).not.toBeNull();
  });

  it("skipGc runs compact only", async () => {
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
      { ...NODE_PROFILE, skipGc: true },
    );
    expect(r.compact?.written).toBe(true);
    expect(r.gc).toBeNull();
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
      await runScheduledMaintenance({ storage: s, currentJsonKey: KEY }, { skipCompact: true });
      // The maintenance run also nests compact+gc — but skipCompact
      // is set so only gc runs, which emits its own canonical line
      // on baerly.gc.
      const maintenanceLines = records.filter((r) => r.category.join(".") === "baerly.maintenance");
      expect(maintenanceLines).toHaveLength(1);
      expect(maintenanceLines[0]!.level).toBe("info");
      expect(maintenanceLines[0]!.properties["outcome"]).toBe("ok");
    });

    it("enriches the canonical line with compact_written / gc_swept / skip flags + recorder-bag fields", async () => {
      // Drive a real compact+GC pass so both phases emit their
      // recorder-bag metrics (`db.compact.entries_folded`,
      // `db.gc.swept_total`, etc.) and the new explicit operator-
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
        { ...NODE_PROFILE, gc: { ...NODE_PROFILE.gc, graceMillis: 0 } },
      );

      const maintenanceLines = records.filter((r) => r.category.join(".") === "baerly.maintenance");
      expect(maintenanceLines).toHaveLength(1);
      const props = maintenanceLines[0]!.properties;

      // Explicit operator-facing fields (the new T04 enrichment).
      expect(props["compact_written"]).toBe(150);
      expect(props["gc_swept"]).toBeGreaterThan(0);
      expect(props["compact_skipped"]).toBe(false);
      expect(props["gc_skipped"]).toBe(false);

      // Recorder-bag fields stay on the line. `db.compact.entries_folded`
      // is a histogram so it expands into `_p50` / `_count` / `_sum`;
      // `db.gc.swept_total` is a counter so it expands into `_total`.
      expect(props["db.compact.entries_folded_count"]).toBe(1);
      expect(props["db.compact.entries_folded_p50"]).toBe(150);
      expect(typeof props["db.gc.swept_total"]).toBe("number");
      expect(props["db.gc.swept_total"]).toBeGreaterThan(0);
    });

    it("flags skipped phases as compact_skipped / gc_skipped on the canonical line", async () => {
      const s = new MemoryStorage();
      await bootstrap(s, KEY);
      await runScheduledMaintenance({ storage: s, currentJsonKey: KEY }, { skipCompact: true });

      const maintenanceLines = records.filter((r) => r.category.join(".") === "baerly.maintenance");
      expect(maintenanceLines).toHaveLength(1);
      const props = maintenanceLines[0]!.properties;
      expect(props["compact_skipped"]).toBe(true);
      expect(props["gc_skipped"]).toBe(false);
      expect(props["compact_written"]).toBe(0);
      // No log writes seeded, so GC has nothing to sweep — the count
      // is exactly 0, not "≥ 0", to lock the skipped-phase semantics.
      expect(props["gc_swept"]).toBe(0);
    });
  });

  it("profile constants carry the documented bounds", async () => {
    // A regression in these constants means the budget audits and
    // the per-tier docstring lie about the worst-case I/O profile.
    expect(CLOUDFLARE_FREE_TIER.compact?.maxEntriesPerRun).toBe(20);
    expect(CLOUDFLARE_FREE_TIER.compact?.minEntriesToCompact).toBe(50);
    expect(CLOUDFLARE_FREE_TIER.gc?.maxMarksPerRun).toBe(20);
    expect(CLOUDFLARE_FREE_TIER.gc?.maxSweepsPerRun).toBe(10);

    expect(CLOUDFLARE_PAID_TIER.compact?.maxEntriesPerRun).toBe(2000);
    expect(CLOUDFLARE_PAID_TIER.gc?.maxMarksPerRun).toBe(1000);
    expect(CLOUDFLARE_PAID_TIER.gc?.maxSweepsPerRun).toBe(500);

    expect(NODE_PROFILE.compact?.maxEntriesPerRun).toBe(100_000);
    expect(NODE_PROFILE.gc?.maxMarksPerRun).toBe(100_000);
    expect(NODE_PROFILE.gc?.maxSweepsPerRun).toBe(1000);
  });
});
