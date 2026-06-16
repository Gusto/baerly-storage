/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the GC test seeds and asserts on it. */

/**
 * GC — `runGc()` mark + sweep under `MemoryStorage`. The
 * cross-adapter coverage (memory / local-fs / node-minio /
 * cloudflare-r2) is exercised by the `[gc]` variant inside
 * `tests/fixtures/collection-api-cascade.ts`.
 */

import {
  type GcPending,
  type Storage,
  type StorageGetOptions,
  GC_PENDING_SCHEMA_VERSION,
  MAX_PARALLEL_LOG_READS,
  MemoryStorage,
  casUpdateGcPending,
  createCurrentJson,
  createGcPending,
  readGcPending,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { compact, type InternalCompactOptions } from "./compactor.ts";
import { type InternalRunGcOptions, runGc } from "./gc.ts";
import { createObservabilityContext, runWithContext } from "./observability/index.ts";
import { Writer } from "./writer.ts";

const bootstrap = async (storage: MemoryStorage, key: string): Promise<void> => {
  await createCurrentJson(
    storage,
    key,
    logStateCurrentJson({ writer_fence: { epoch: 0, owner: "gc-test", claimed_at: "" } }),
  );
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

  // ── orphan-content LIST rotation (Task 4.6) ──────────────────────
  // Seed N orphan content blobs (no live docs ⇒ every content key is
  // an orphan). With `maxMarksPerRun` < N the per-pass content LIST
  // yields at most `maxMarks` keys; without the `content_scan_cursor`
  // rotation it would re-scan the same lexicographic-first window each
  // pass and never reach the tail. The cursor resumes `startAfter` the
  // prior pass's last examined key so the whole keyspace is swept.
  const seedOrphanContent = async (s: MemoryStorage, count: number): Promise<string[]> => {
    const keys: string[] = [];
    for (let i = 0; i < count; i++) {
      // 32-hex key sorted by index — lex order == seed order, so we
      // can reason about which window each pass examines.
      const hex = i.toString(16).padStart(32, "0");
      const key = `app/t/tenant/x/manifests/c/content/${hex}.json`;
      await s.put(key, new TextEncoder().encode(`{"i":${i}}`), {
        contentType: "application/json",
      });
      keys.push(key);
    }
    return keys;
  };

  test("rotates the content LIST so orphans past the first maxMarks window are eventually swept", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const keys = await seedOrphanContent(s, 60);

    // 3 passes at maxMarks=20 cover all 60. Each pass marks+sweeps its
    // window (grace 0) and advances the cursor by examined keys.
    let totalSwept = 0;
    for (let pass = 0; pass < 3; pass++) {
      const r = await runGc({ storage: s, currentJsonKey: KEY }, {
        graceMillis: 0,
        maxMarksPerRun: 20,
        maxSweepsPerRun: 20,
      } as InternalRunGcOptions);
      totalSwept += r.swept;
    }
    expect(totalSwept).toBe(60);
    // Every seeded orphan is gone from the bucket.
    for (const key of keys) {
      await expect(s.get(key)).resolves.toBeNull();
    }
  });

  test("persists content_scan_cursor across passes and WRAPS to undefined at the end", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    // Seed 30 orphans; with maxMarks=20, grace NOT bypassed so nothing
    // is swept this turn — the cursor advances purely by examination.
    await seedOrphanContent(s, 30);

    // Pass 1: examines keys [0..19], yields == maxMarks (20) ⇒ cursor
    // set to the 20th key (index 19), no wrap.
    await runGc({ storage: s, currentJsonKey: KEY }, {
      maxMarksPerRun: 20,
    } as InternalRunGcOptions);
    const after1 = await readGcPending(s, PENDING_KEY);
    expect(after1?.json.content_scan_cursor).toBe(
      `app/t/tenant/x/manifests/c/content/${(19).toString(16).padStart(32, "0")}.json`,
    );

    // Pass 2: resumes startAfter index 19, examines [20..29] = 10 keys
    // < maxMarks ⇒ reached the end ⇒ WRAP (cursor cleared).
    await runGc({ storage: s, currentJsonKey: KEY }, {
      maxMarksPerRun: 20,
    } as InternalRunGcOptions);
    const after2 = await readGcPending(s, PENDING_KEY);
    expect(after2?.json.content_scan_cursor).toBeUndefined();
  });

  test("advances the cursor on an all-live (zero-mark) window", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    // Seed 30 live docs ⇒ 30 live content blobs, none orphan. Disable
    // the Writer's write-tick maintenance during seeding so NO runGc
    // pass fires inline (which would otherwise advance the cursor on its
    // own) — this test must observe the cursor written by exactly ONE
    // controlled runGc pass from a clean (cursor-absent) start.
    const seedCtx = createObservabilityContext({ maintenance: { disabled: true } });
    await runWithContext(seedCtx, async () => {
      for (let i = 0; i < 30; i++) {
        await writer.commit({
          op: "I",
          collection: COLL,
          docId: `d${i}`,
          body: { _id: `d${i}`, n: i },
        });
      }
    });
    // maxMarks=10 ⇒ the LIST examines the first 10 (all live), marks
    // zero, but the cursor MUST still advance to the 10th content key so
    // the next pass reaches fresh keys. 10 examined == maxMarks ⇒ NOT
    // end-of-keyspace ⇒ cursor carried, not wrapped.
    const r = await runGc({ storage: s, currentJsonKey: KEY }, {
      maxMarksPerRun: 10,
    } as InternalRunGcOptions);
    expect(r.marked.orphan_content).toBe(0);
    const pending = await readGcPending(s, PENDING_KEY);
    // A cursor was written even though zero orphans were marked.
    expect(pending?.json.content_scan_cursor).toMatch(/\/content\/[0-9a-f]{32}\.json$/);
  });

  test("unbounded runGc marks ALL orphans in one pass and wraps the cursor", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    await seedOrphanContent(s, 60);
    // No maxMarksPerRun ⇒ DEFAULT_MAX_MARKS (≈ MAX_SAFE_INTEGER). The
    // content LIST yields all 60 keys (< maxKeys) in one pass.
    const r = await runGc({ storage: s, currentJsonKey: KEY }, {
      graceMillis: 0,
    } as InternalRunGcOptions);
    expect(r.marked.orphan_content).toBe(60);
    expect(r.swept).toBe(60);
    // Reached the end ⇒ cursor wrapped (cleared).
    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.content_scan_cursor).toBeUndefined();
  });

  // ── live-log scan concurrency bound ──────────────────────────────
  // The live-content-hash scan reads every live `log/<seq>` in
  // `[log_seq_start, tail)`. A backlogged tail makes that range large
  // (up to LOG_FORWARD_PROBE_CAP = 100_000). The scan must cap its
  // in-flight log GETs at MAX_PARALLEL_LOG_READS so it never blows the
  // Cloudflare Workers ~50-concurrent-subrequest cap. This wrapper
  // instruments `get` on `/log/` keys to record the PEAK simultaneous
  // in-flight GETs across the whole run; each get yields a microtask
  // (await) so concurrent reads actually overlap and stack.
  const instrumentLogGetConcurrency = (
    inner: Storage,
  ): { storage: Storage; peak: () => number } => {
    let inFlight = 0;
    let peak = 0;
    const storage: Storage = {
      get: async (key: string, opts?: StorageGetOptions) => {
        const isLogGet = /\/log\/\d+\.json$/.test(key);
        if (isLogGet) {
          inFlight++;
          if (inFlight > peak) {
            peak = inFlight;
          }
        }
        try {
          // Yield twice so overlapping reads have a chance to stack
          // before the first resolves.
          await Promise.resolve();
          await Promise.resolve();
          return await inner.get(key, opts);
        } finally {
          if (isLogGet) {
            inFlight--;
          }
        }
      },
      put: (key, body, opts) => inner.put(key, body, opts),
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
    };
    return { storage, peak: () => peak };
  };

  test("bounds live-log scan concurrency to MAX_PARALLEL_LOG_READS", async () => {
    const inner = new MemoryStorage();
    await bootstrap(inner, KEY);
    // Seed a live log range comfortably larger than the cap. No
    // compaction ⇒ log_seq_start stays 0 and every entry is live, so
    // the scan walks all of [0, tail). tail_hint starts at 0, forcing
    // the probe + scan to walk the full range.
    const writer = new Writer({ storage: inner, currentJsonKey: KEY });
    const RANGE = 64; // 4× the cap of 16
    const seedCtx = createObservabilityContext({ maintenance: { disabled: true } });
    await runWithContext(seedCtx, async () => {
      for (let i = 0; i < RANGE; i++) {
        await writer.commit({
          op: "I",
          collection: COLL,
          docId: `d${i}`,
          body: { _id: `d${i}`, n: i },
        });
      }
    });

    const { storage, peak } = instrumentLogGetConcurrency(inner);
    const r = await runGc({ storage, currentJsonKey: KEY });
    // No compaction ran ⇒ nothing is a stale-log orphan, and every
    // content blob is referenced by a live log entry ⇒ zero orphans.
    expect(r.marked.orphan_content).toBe(0);
    // The peak simultaneous in-flight log GETs must stay within the
    // bounded-walker cap. Before the fix the unbounded Promise.all
    // fanned out all RANGE (=64) reads at once.
    expect(peak()).toBeLessThanOrEqual(MAX_PARALLEL_LOG_READS);
    expect(peak()).toBeGreaterThan(0);
  });

  test("live-log scan still marks a true orphan and spares a live blob (complete scan)", async () => {
    // Correctness guard for the bounded scan: a known-orphan content
    // key (no referencing log entry) is still marked, and the
    // live-referenced blobs across a range > the cap are NOT marked.
    const inner = new MemoryStorage();
    await bootstrap(inner, KEY);
    const writer = new Writer({ storage: inner, currentJsonKey: KEY });
    const seedCtx = createObservabilityContext({ maintenance: { disabled: true } });
    await runWithContext(seedCtx, async () => {
      for (let i = 0; i < 40; i++) {
        await writer.commit({
          op: "I",
          collection: COLL,
          docId: `d${i}`,
          body: { _id: `d${i}`, n: i },
        });
      }
    });
    // A truly-orphan content blob (writer crashed pre-log-PUT).
    const orphanKey = "app/t/tenant/x/manifests/c/content/ffffffffffffffffffffffffffffffff.json";
    await inner.put(orphanKey, new TextEncoder().encode(`{"_id":"ghost"}`), {
      contentType: "application/json",
    });

    const { storage } = instrumentLogGetConcurrency(inner);
    const r = await runGc({ storage, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 100,
    } as InternalRunGcOptions);
    // Exactly the one true orphan is swept; the 40 live blobs survive.
    expect(r.marked.orphan_content).toBe(1);
    expect(r.swept).toBe(1);
    await expect(inner.get(orphanKey)).resolves.toBeNull();
    // Every live content blob is still present (complete scan ⇒ no
    // live data deleted).
    for await (const entry of inner.list("app/t/tenant/x/manifests/c/content/")) {
      await expect(inner.get(entry.key)).resolves.not.toBeNull();
    }
  });
});
