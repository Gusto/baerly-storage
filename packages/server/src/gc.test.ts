/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the GC test seeds and asserts on it. */

/**
 * GC — `runGc()` mark + sweep under `MemoryStorage`. The
 * cross-adapter coverage (memory / local-fs / node-minio /
 * cloudflare-r2) is exercised by the `[gc]` variant inside
 * `tests/fixtures/table-api-cascade.ts`.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  type GcPending,
  GC_PENDING_SCHEMA_VERSION,
  MemoryStorage,
  casUpdateGcPending,
  createCurrentJson,
  createGcPending,
  readGcPending,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { compact, type InternalCompactOptions } from "./compactor.ts";
import { type InternalRunGcOptions, runGc } from "./gc.ts";
import { createObservabilityContext, runWithContext } from "./observability/index.ts";
import { Writer } from "./writer.ts";

const bootstrap = async (storage: MemoryStorage, key: string): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "gc-test", claimed_at: "" },
  });
};

const KEY = "app/t/tenant/x/manifests/c/current.json";
const PENDING_KEY = "app/t/tenant/x/manifests/c/gc/pending.json";
const COLL = "c";

describe("runGc", () => {
  test("returns zeros and bootstraps an empty pending.json on first run", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r).toEqual({
      marked: { stale_log: 0, orphan_snapshot: 0, orphan_content: 0 },
      swept: 0,
      pendingDepth: 0,
    });
    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending).not.toBeNull();
    expect(pending?.json.candidates).toEqual([]);
    expect(pending?.json.schema_version).toBe(1);
  });

  test("returns zeros when current.json is missing", async () => {
    const s = new MemoryStorage();
    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r.marked).toEqual({ stale_log: 0, orphan_snapshot: 0, orphan_content: 0 });
    expect(r.swept).toBe(0);
    // Nothing was bootstrapped either — pending.json is absent.
    await expect(readGcPending(s, PENDING_KEY)).resolves.toBeNull();
  });

  test("marks stale log entries after compaction (no sweep at default grace)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 40,
    } as InternalCompactOptions);
    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r.marked.stale_log).toBe(40);
    expect(r.swept).toBe(0); // 7-day grace not elapsed.
    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.candidates).toHaveLength(40);
    for (const c of pending?.json.candidates ?? []) {
      expect(c.reason).toBe("stale-log");
      expect(c.key).toMatch(/\/log\/\d+\.json$/);
    }
  });

  test("sweeps stale log entries when grace is bypassed", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 40,
    } as InternalCompactOptions);
    // grace=0 ⇒ due_at is `now` (or earlier) at mark time, so the
    // same pass marks AND sweeps.
    const r = await runGc({ storage: s, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 40,
    } as InternalRunGcOptions);
    expect(r.marked.stale_log).toBe(40);
    expect(r.swept).toBe(40);
    // The swept keys really were deleted from the bucket.
    for (let i = 0; i < 40; i++) {
      await expect(s.get(`app/t/tenant/x/manifests/c/log/${i}.json`)).resolves.toBeNull();
    }
    // Live tail [40, 50) untouched.
    for (let i = 40; i < 50; i++) {
      await expect(s.get(`app/t/tenant/x/manifests/c/log/${i}.json`)).resolves.not.toBeNull();
    }
  });

  test("sweeps in a second pass after grace elapses (clock injection)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 40,
    } as InternalCompactOptions);

    let nowMs = Date.parse("2025-01-01T00:00:00.000Z");
    const clock = (): Date => new Date(nowMs);

    const first = await runGc({ storage: s, currentJsonKey: KEY }, {
      now: clock,
      maxSweepsPerRun: 40,
    } as InternalRunGcOptions);
    expect(first.marked.stale_log).toBe(40);
    expect(first.swept).toBe(0); // grace not yet elapsed

    nowMs += 8 * 24 * 60 * 60 * 1000;
    const second = await runGc({ storage: s, currentJsonKey: KEY }, {
      now: clock,
      maxSweepsPerRun: 40,
    } as InternalRunGcOptions);
    expect(second.swept).toBe(40);
    // pending.json is empty after the sweep + last_swept_at is set.
    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.candidates).toEqual([]);
    expect(pending?.json.last_swept_at).toBe(new Date(nowMs).toISOString());
  });

  test("marks the replaced snapshot after a second compaction run", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 40; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const first = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 40,
    } as InternalCompactOptions);
    expect(first.written).toBe(true);
    for (let i = 40; i < 80; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const second = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 40,
    } as InternalCompactOptions);
    expect(second.written).toBe(true);
    expect(second.previousSnapshotKey).toBe(first.newSnapshotKey);

    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r.marked.orphan_snapshot).toBe(1);
    const pending = await readGcPending(s, PENDING_KEY);
    const snapCandidates =
      pending?.json.candidates.filter((c) => c.reason === "orphan-snapshot") ?? [];
    expect(snapCandidates).toHaveLength(1);
    expect(snapCandidates[0]?.key).toBe(first.newSnapshotKey);
  });

  test("does NOT mark a live content blob as orphan", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "a",
      body: { _id: "a", n: 1 },
    });
    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r.marked.orphan_content).toBe(0);
    // And a second pass after a compaction should still treat the
    // post-snapshot content as live (the snapshot rows feed into the
    // live-hash set).
    for (let i = 0; i < 30; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 100,
    } as InternalCompactOptions);
    const r2 = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r2.marked.orphan_content).toBe(0);
  });

  test("marks a truly orphan content blob (writer crashed pre-log-PUT)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    // Simulate a crashed writer: PUT a content key without any log
    // entry referencing it. The hash here is 32 hex chars, matching
    // `versionFromContent`'s output shape.
    const orphanBody = new TextEncoder().encode(JSON.stringify({ _id: "ghost", x: 1 }));
    await s.put(
      "app/t/tenant/x/manifests/c/content/00000000000000000000000000000000.json",
      orphanBody,
      { contentType: "application/json" },
    );
    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r.marked.orphan_content).toBe(1);
  });

  test("sweeping orphan content with grace=0 deletes the key", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const orphanKey = "app/t/tenant/x/manifests/c/content/00000000000000000000000000000000.json";
    await s.put(orphanKey, new TextEncoder().encode("{}"), {
      contentType: "application/json",
    });
    const r = await runGc({ storage: s, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);
    expect(r.marked.orphan_content).toBe(1);
    expect(r.swept).toBe(1);
    await expect(s.get(orphanKey)).resolves.toBeNull();
  });

  test("bounds new marks per category at maxMarksPerRun", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 200; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 200,
    } as InternalCompactOptions);
    const r = await runGc({ storage: s, currentJsonKey: KEY }, {
      maxMarksPerRun: 50,
    } as InternalRunGcOptions);
    expect(r.marked.stale_log).toBe(50);
    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.candidates).toHaveLength(50);
  });

  test("idempotent across two consecutive runs (no double-marking)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 20; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 20,
    } as InternalCompactOptions);

    const r1 = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r1.marked.stale_log).toBe(20);
    const r2 = await runGc({ storage: s, currentJsonKey: KEY });
    // Second pass marks nothing — every stale log is already in
    // pending.json.
    expect(r2.marked.stale_log).toBe(0);
    expect(r2.swept).toBe(0);
    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.candidates).toHaveLength(20);
  });

  test("emits db.orphan.candidate_count, db.gc.entries_swept_per_second, and db.gc.swept_total", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 40,
    } as InternalCompactOptions);
    const ctx = createObservabilityContext();
    let r!: Awaited<ReturnType<typeof runGc>>;
    await runWithContext(ctx, async () => {
      r = await runGc({ storage: s, currentJsonKey: KEY }, {
        graceMillis: 0,
        maxSweepsPerRun: 40,
      } as InternalRunGcOptions);
    });
    expect(r.marked.stale_log).toBe(40);
    expect(r.swept).toBe(40);
    const snap = ctx.recorder.snapshot();
    // Post-sweep, pendingDepth = 0 (everything swept).
    const candidate = snap.gauges.findLast((g) => g.name === "db.orphan.candidate_count");
    expect(candidate?.value).toBe(0);
    // Sweep count is the swept-per-pass observation.
    const sweptGauge = snap.gauges.findLast((g) => g.name === "db.gc.entries_swept_per_second");
    expect(sweptGauge?.value).toBe(40);
    // Counter labelled by reason; one bucket since all were stale-log.
    const swept = snap.counters.find((c) => c.name === "db.gc.swept_total");
    expect(swept?.value).toBe(40);
    expect(swept?.labels["reason"]).toBe("stale-log");
  });

  test("emits zero-sweep observations when nothing swept this pass", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const ctx = createObservabilityContext();
    let r!: Awaited<ReturnType<typeof runGc>>;
    await runWithContext(ctx, async () => {
      r = await runGc({ storage: s, currentJsonKey: KEY });
    });
    expect(r.swept).toBe(0);
    const snap = ctx.recorder.snapshot();
    // Sweep gauge still emitted (operator wants 0-state visibility).
    const sweptGauge = snap.gauges.findLast((g) => g.name === "db.gc.entries_swept_per_second");
    expect(sweptGauge?.value).toBe(0);
    const candidate = snap.gauges.findLast((g) => g.name === "db.orphan.candidate_count");
    expect(candidate?.value).toBe(0);
    // No swept_total counter emitted on zero-sweep runs (avoid noise).
    expect(snap.counters.find((c) => c.name === "db.gc.swept_total")).toBeUndefined();
  });

  test("returns success on CAS-lost on pending.json (best-effort pendingDepth)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    // Pre-seed pending.json with an entry due-for-sweep so the run
    // has work to do.
    const pre: GcPending = {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: "app/t/tenant/x/manifests/c/log/0.json",
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "stale-log",
        },
      ],
      last_swept_at: "",
    };
    await createGcPending(s, PENDING_KEY, pre);
    // Force a CAS-lose by spying-and-flipping the etag: after runGc
    // reads pending.json, we cas-update it via a second writer to
    // bump its etag. To do this deterministically we patch
    // `storage.put` to intercept the runGc CAS write and inject a
    // pre-write rival update.
    //
    // Concretely: wrap `s.put` so that the first PUT to PENDING_KEY
    // first triggers a rival casUpdate to bump the etag, then lets
    // the original PUT proceed (which will now fail with
    // PreconditionFailed).
    const origPut = s.put.bind(s);
    let intercepted = false;
    s.put = (async (key, body, opts) => {
      if (key === PENDING_KEY && opts?.ifMatch !== undefined && !intercepted) {
        intercepted = true;
        // Rival update: simply re-CAS the same shape but with
        // `last_swept_at` set to something. This bumps the etag.
        await casUpdateGcPending(s, PENDING_KEY, (cur) => ({
          ...cur,
          last_swept_at: "rival",
        }));
      }
      return origPut(key, body, opts);
    }) as typeof s.put;
    const r = await runGc({ storage: s, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);
    // The DELETE of log/0.json landed; the CAS-lose on pending.json
    // is non-fatal.
    expect(r.swept).toBe(1);
    await expect(s.get("app/t/tenant/x/manifests/c/log/0.json")).resolves.toBeNull();
  });
});
