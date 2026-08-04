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
  type StorageListEntry,
  BaerlyError,
  GC_GRACE_PERIOD_MILLIS,
  GC_PENDING_CAS_MAX_ATTEMPTS,
  GC_PENDING_SCHEMA_VERSION,
  MAX_PARALLEL_LOG_READS,
  SNAPSHOT_SCHEMA_VERSION,
  MemoryStorage,
  casUpdateCurrentJson,
  casUpdateGcPending,
  createCurrentJson,
  createGcPending,
  encodeJsonBytes,
  readCurrentJson,
  readGcPending,
  snapshotHash,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  LOG_STATE_GENERATION,
  logStateCurrentJson,
  seedLogEntries,
  seedLogEntry,
} from "../../../tests/fixtures/log-state.ts";
import { compact, type InternalCompactOptions } from "./compactor.ts";
import {
  type ContentDeferralReason,
  type InternalRunGcOptions,
  isDegradedContentDeferral,
  runGc,
} from "./gc.ts";
import { createObservabilityContext, runWithContext } from "./observability/index.ts";
import { encodeSnapshotBody, snapshotKey } from "./snapshot.ts";
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
const PREFIX = "app/t/tenant/x/manifests/c";
const COLL = "c";

interface StorageTrace {
  readonly gets: string[];
  readonly puts: Array<{
    key: string;
    ifMatch: string | undefined;
    ifNoneMatch: string | undefined;
  }>;
  readonly deletes: string[];
  readonly lists: string[];
}

const tracingStorage = (inner: Storage): { storage: Storage; trace: StorageTrace } => {
  const trace: StorageTrace = { gets: [], puts: [], deletes: [], lists: [] };
  const storage: Storage = {
    async get(key, opts) {
      trace.gets.push(key);
      return inner.get(key, opts);
    },
    async put(key, body, opts) {
      trace.puts.push({
        key,
        ifMatch: opts?.ifMatch,
        ifNoneMatch: opts?.ifNoneMatch,
      });
      return inner.put(key, body, opts);
    },
    async delete(key, opts) {
      trace.deletes.push(key);
      return inner.delete(key, opts);
    },
    list(prefix, opts) {
      trace.lists.push(prefix);
      return inner.list(prefix, opts);
    },
  };
  return { storage, trace };
};

const seedDenseLog = async (
  storage: Storage,
  fromSeq: number,
  toExclusive: number,
): Promise<void> =>
  seedLogEntries(storage, PREFIX, fromSeq, toExclusive, (seq) => ({
    after: { _id: `d${seq}`, n: seq },
  }));

describe("runGc", () => {
  test("returns zeros and bootstraps an empty pending.json on first run", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r).toEqual({
      marked: { stale_log: 0, orphan_snapshot: 0, orphan_content: 0 },
      swept: 0,
      dropped: { stale_generation: 0, still_live: 0 },
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

  // Production mutation caught: allowing zero/fractional/negative admission
  // caps into the probe arithmetic could either do no progress or silently
  // admit a partial live set. Both internal seams must fail before the first
  // storage call.
  describe.each([
    ["maxTailProbeGets", { maxTailProbeGets: 0 }, "positive"],
    ["maxTailProbeGets", { maxTailProbeGets: 1.5 }, "positive"],
    ["maxLiveLogEntriesPerRun", { maxLiveLogEntriesPerRun: -1 }, "non-negative"],
    ["maxLiveLogEntriesPerRun", { maxLiveLogEntriesPerRun: 1.5 }, "non-negative"],
  ])("rejects invalid %s before I/O", (option, overrides, contract) => {
    test("fails closed at the internal seam", async () => {
      const fail = (operation: keyof Storage): never => {
        throw new Error(`runGc must validate before storage.${operation}()`);
      };
      const storage: Storage = {
        get: () => fail("get"),
        put: () => fail("put"),
        delete: () => fail("delete"),
        list: () => fail("list"),
      };

      await expect(
        runGc({ storage, currentJsonKey: KEY }, overrides as InternalRunGcOptions),
      ).rejects.toMatchObject({
        code: "InvalidConfig",
        message: expect.stringContaining(`${option} must be a ${contract} integer`),
      });
    });
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

  // ── grace anchoring ──────────────────────────────────────────────
  // `due_at` measures the writer-retry window from the MARK, never
  // from the listed object's write time. GC used to anchor on an
  // optional `StorageListEntry.lastModified` that only the S3/GCS/R2
  // adapters populated, giving production an effective grace of
  // `max(0, grace − object age)` — zero past the 7-day default, for
  // exactly the old objects GC marks — while `MemoryStorage` and
  // `LocalFsStorage`, the backends this suite runs, omitted it and
  // showed a full window.
  //
  // The field is gone, so the type no longer permits this and the
  // storage conformance suite compares list entries whole. The cast
  // below is what keeps the behavioural guard alive anyway: TypeScript
  // cannot stop an adapter attaching an extra property at RUNTIME, and
  // this asserts `computeDueAt` reads nothing off the entry regardless.
  // Delete this only together with the assertion it protects.
  const withListedTimestamp = (inner: Storage, lastModified: Date): Storage => ({
    get: (key, opts) => inner.get(key, opts),
    put: (key, body, opts) => inner.put(key, body, opts),
    delete: (key, opts) => inner.delete(key, opts),
    list: async function* (prefix, opts) {
      for await (const entry of inner.list(prefix, opts)) {
        yield { ...entry, lastModified } as StorageListEntry;
      }
    },
  });

  test("grants full grace from the mark even when listed objects are older than it", async () => {
    const inner = new MemoryStorage();
    await bootstrap(inner, KEY);
    const writer = new Writer({ storage: inner, currentJsonKey: KEY });
    for (let i = 0; i < 12; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    // Folds [0, 10) ⇒ ten stale-log candidates. The snapshot it writes
    // is the live one and every content blob stays reachable (snapshot
    // rows + the live tail), so stale-log is the only category marked.
    await compact({ storage: inner, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 10,
    } as InternalCompactOptions);

    const markedAt = new Date("2026-01-08T00:00:00.000Z");
    // A month old — comfortably past the 7-day default, which is what
    // makes an age-anchored horizon land in the past at mark time.
    const storage = withListedTimestamp(inner, new Date("2025-12-08T00:00:00.000Z"));

    // Default grace (no `graceMillis` override) — the production knob.
    const r = await runGc({ storage, currentJsonKey: KEY }, {
      now: () => markedAt,
    } as InternalRunGcOptions);
    expect(r.marked.stale_log).toBe(10);
    // The absorber must still be armed: nothing is due in the pass
    // that marked it, however old the objects are.
    expect(r.swept).toBe(0);

    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates).toHaveLength(10);
    const dueAts = new Set((pending?.json.candidates ?? []).map((c) => c.due_at));
    expect(dueAts).toEqual(
      new Set([new Date(markedAt.getTime() + GC_GRACE_PERIOD_MILLIS).toISOString()]),
    );
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

  test("rescues a snapshot that becomes current after the initial manifest read", async () => {
    const inner = new MemoryStorage();
    await bootstrap(inner, KEY);
    const newSnapshot = `${PREFIX}/snapshot/L9/newly-current.json`;
    const deleted: string[] = [];
    let advanced = false;
    const storage: Storage = {
      get: (key, opts) => inner.get(key, opts),
      put: (key, body, opts) => inner.put(key, body, opts),
      async delete(key, opts) {
        deleted.push(key);
        await inner.delete(key, opts);
      },
      list(prefix, opts) {
        if (prefix !== `${PREFIX}/snapshot/`) {
          return inner.list(prefix, opts);
        }
        return (async function* (): AsyncIterable<StorageListEntry> {
          if (!advanced) {
            advanced = true;
            await inner.put(newSnapshot, new TextEncoder().encode("{}"));
            await casUpdateCurrentJson(inner, KEY, (current) => ({
              ...current,
              snapshot: newSnapshot,
            }));
          }
          yield* inner.list(prefix, opts);
        })();
      },
    };

    const result = await runGc({ storage, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

    expect(result.marked.orphan_snapshot).toBe(1);
    expect(result.swept).toBe(0);
    expect(deleted).not.toContain(newSnapshot);
    await expect(inner.get(newSnapshot)).resolves.not.toBeNull();
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates.map((candidate) => candidate.key)).not.toContain(newSnapshot);
  });

  // Production mutation caught: admitting any due snapshot not named by the
  // late manifest read lets a compactor publish that exact candidate after
  // the GET linearizes but before DELETE, leaving a dangling pointer.
  test("retains a due snapshot published after the fresh manifest read", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        log_seq_start: 10,
        tail_hint: 10,
      }),
    );
    const candidateBody = encodeSnapshotBody({
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      min_seq: 0,
      max_seq: 20,
      collection: COLL,
      docs: [],
    });
    const candidate = snapshotKey(PREFIX, 0, 20, await snapshotHash(candidateBody));
    await inner.put(candidate, candidateBody);
    await createGcPending(inner, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: candidate,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "orphan-snapshot",
          generation: LOG_STATE_GENERATION,
        },
      ],
      last_swept_at: "",
    });

    let currentReads = 0;
    const deleted: string[] = [];
    const storage: Storage = {
      async get(key, opts) {
        const result = await inner.get(key, opts);
        if (key === KEY) {
          currentReads++;
          if (currentReads === 2) {
            // The GET above linearized first. Publish the already-written
            // snapshot and advance the manifest before GC can issue DELETE.
            await inner.put(candidate, candidateBody);
            await casUpdateCurrentJson(inner, KEY, (current) => ({
              ...current,
              snapshot: candidate,
              log_seq_start: 20,
              tail_hint: 20,
            }));
          }
        }
        return result;
      },
      put: (key, body, opts) => inner.put(key, body, opts),
      async delete(key, opts) {
        deleted.push(key);
        await inner.delete(key, opts);
      },
      list: (prefix, opts) => inner.list(prefix, opts),
    };

    const result = await runGc({ storage, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

    expect(currentReads).toBe(2);
    expect(result.swept).toBe(0);
    expect(deleted).not.toContain(candidate);
    const current = await readCurrentJson(inner, KEY);
    expect(current?.json.snapshot).toBe(candidate);
    await expect(inner.get(candidate)).resolves.not.toBeNull();
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates.map((entry) => entry.key)).toContain(candidate);
  });

  test("sweeps a due canonical snapshot strictly below the fresh log floor", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        log_seq_start: 20,
        tail_hint: 20,
      }),
    );
    const candidate = snapshotKey(PREFIX, 0, 19, "b".repeat(64));
    await inner.put(candidate, new TextEncoder().encode("{}"));
    await createGcPending(inner, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: candidate,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "orphan-snapshot",
          generation: LOG_STATE_GENERATION,
        },
      ],
      last_swept_at: "",
    });

    const result = await runGc({ storage: inner, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

    expect(result.swept).toBe(1);
    await expect(inner.get(candidate)).resolves.toBeNull();
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates.map((entry) => entry.key)).not.toContain(candidate);
  });

  test("retains a due canonical snapshot equal to the fresh log floor", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        log_seq_start: 20,
        tail_hint: 20,
      }),
    );
    const candidate = snapshotKey(PREFIX, 0, 20, "c".repeat(64));
    await inner.put(candidate, new TextEncoder().encode("{}"));
    await createGcPending(inner, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: candidate,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "orphan-snapshot",
          generation: LOG_STATE_GENERATION,
        },
      ],
      last_swept_at: "",
    });

    const result = await runGc({ storage: inner, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

    expect(result.swept).toBe(0);
    await expect(inner.get(candidate)).resolves.not.toBeNull();
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates.map((entry) => entry.key)).toContain(candidate);
  });

  test("retains malformed and unknown-layout due snapshot candidates", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        log_seq_start: 100,
        tail_hint: 100,
      }),
    );
    const malformed = `${PREFIX}/snapshot/L9/not-a-canonical-snapshot.json`;
    const unknownLayout = `${PREFIX}/snapshot/L8/000000000000-000000000001-${"d".repeat(64)}.json`;
    await inner.put(malformed, new TextEncoder().encode("{}"));
    await inner.put(unknownLayout, new TextEncoder().encode("{}"));
    await createGcPending(inner, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [malformed, unknownLayout].map((key) => ({
        key,
        due_at: "2000-01-01T00:00:00.000Z",
        reason: "orphan-snapshot" as const,
        generation: LOG_STATE_GENERATION,
      })),
      last_swept_at: "",
    });

    const result = await runGc({ storage: inner, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

    expect(result.swept).toBe(0);
    await expect(inner.get(malformed)).resolves.not.toBeNull();
    await expect(inner.get(unknownLayout)).resolves.not.toBeNull();
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates.map((entry) => entry.key).toSorted()).toEqual(
      [malformed, unknownLayout].toSorted(),
    );
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

  test("rescues a due pending content candidate once a complete live set references it", async () => {
    const inner = new MemoryStorage();
    await bootstrap(inner, KEY);
    const writer = new Writer({ storage: inner, currentJsonKey: KEY });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "live-again",
      body: { _id: "live-again", n: 1 },
    });
    const liveContentKeys: string[] = [];
    for await (const entry of inner.list(`${PREFIX}/content/`)) {
      liveContentKeys.push(entry.key);
    }
    expect(liveContentKeys).toHaveLength(1);
    const liveContent = liveContentKeys[0]!;
    await createGcPending(inner, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: liveContent,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "orphan-content",
          generation: LOG_STATE_GENERATION,
        },
      ],
      last_swept_at: "",
    });
    const concurrentCandidate = {
      key: `${PREFIX}/gc/concurrent.json`,
      due_at: "2099-01-01T00:00:00.000Z",
      reason: "stale-log" as const,
      generation: LOG_STATE_GENERATION,
    };
    let injectedConcurrentUpdate = false;
    const subject: Storage = {
      get: (key, opts) => inner.get(key, opts),
      async put(key, body, opts) {
        if (key === PENDING_KEY && opts?.ifMatch !== undefined && !injectedConcurrentUpdate) {
          injectedConcurrentUpdate = true;
          await casUpdateGcPending(inner, PENDING_KEY, (latest) => ({
            ...latest,
            candidates: [...latest.candidates, concurrentCandidate],
          }));
        }
        return inner.put(key, body, opts);
      },
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
    };
    const { storage, trace } = tracingStorage(subject);

    const result = await runGc({ storage, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

    expect(result).toMatchObject({ swept: 0, pendingDepth: 1 });
    expect(trace.deletes).not.toContain(liveContent);
    await expect(inner.get(liveContent)).resolves.not.toBeNull();
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates).toEqual([concurrentCandidate]);
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
    // Floor at 1, not the bootstrap default of 0, so the seeded
    // candidate below names a key that is genuinely BENEATH the floor.
    // With a floor of 0 the sweep gate re-derives `log/0.json` as live
    // and drops the candidate instead of deleting it — correctly, since
    // readers walk from 0 — and this test would be asserting a sweep the
    // mark phase could never have authorised in the first place.
    await createCurrentJson(
      s,
      KEY,
      logStateCurrentJson({
        writer_fence: { epoch: 0, owner: "gc-test", claimed_at: "" },
        log_seq_start: 1,
        tail_hint: 1,
      }),
    );
    // Pre-seed pending.json with an entry due-for-sweep so the run
    // has work to do.
    const pre: GcPending = {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: "app/t/tenant/x/manifests/c/log/0.json",
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "stale-log",
          generation: LOG_STATE_GENERATION,
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
    // The retry loop CONVERGED: the interceptor above fires once, so
    // `casUpdateGcPending`'s attempt 2 re-reads the rival's body, re-merges,
    // and lands. The candidate therefore LEAVES the ledger and nothing is
    // sticky. Pinned so the contrast with the exhausted-budget test below
    // is explicit rather than incidental — that test is the one that
    // reaches `gc.ts`'s `Conflict` catch, and this one never does.
    const converged = await readGcPending(s, PENDING_KEY);
    expect(converged?.json.candidates).toEqual([]);
  });

  test("sticky CAS-loss: candidate survives the ledger when every CAS attempt loses", async () => {
    // The genuinely dangerous shape, and the one the sibling test above
    // does NOT reach. A pass that DELETES a key and then fails to persist
    // the removal leaves a candidate in `gc/pending.json` naming a key
    // that is already gone — and a `GcCandidate` is a bare key with no
    // identity. `baerly admin restore --force` can later re-create that
    // exact key inside the NEW live range, at which point the surviving
    // candidate authorises a DELETE of live data. That is the ABA the
    // integration suite (`tests/integration/gc-restore-fencing.test.ts`)
    // drives end to end; this test pins the state it starts from.
    //
    // `runGc` must still report SUCCESS here: the DELETEs it issued are
    // durable, and re-throwing would mask the work that did complete.
    const s = new MemoryStorage();
    // Same fixture as the sibling: floor at 1 so `log/0.json` is genuinely
    // sub-floor and the sweep gate re-derives it as dead.
    await createCurrentJson(
      s,
      KEY,
      logStateCurrentJson({
        log_seq_start: 1,
        tail_hint: 1,
        writer_fence: { epoch: 0, owner: "gc-test", claimed_at: "" },
      }),
    );
    const staleLogKey = "app/t/tenant/x/manifests/c/log/0.json";
    const pre: GcPending = {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: staleLogKey,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "stale-log",
          generation: LOG_STATE_GENERATION,
        },
      ],
      last_swept_at: "",
    };
    await createGcPending(s, PENDING_KEY, pre);
    // Exhaust the budget: land a rival CAS before EVERY guarded PUT, not
    // just the first, so all `GC_PENDING_CAS_MAX_ATTEMPTS` attempts lose
    // and `casUpdateGcPending` surfaces `Conflict`. `inRival` is the
    // re-entrancy guard — the rival's own guarded PUT re-enters this
    // wrapper and would otherwise recurse forever.
    const origPut = s.put.bind(s);
    let guardedPuts = 0;
    let inRival = false;
    s.put = (async (key, body, opts) => {
      if (key === PENDING_KEY && opts?.ifMatch !== undefined && !inRival) {
        guardedPuts++;
        inRival = true;
        try {
          await casUpdateGcPending(s, PENDING_KEY, (cur) => ({
            ...cur,
            last_swept_at: `rival-${String(guardedPuts)}`,
          }));
        } finally {
          inRival = false;
        }
      }
      return origPut(key, body, opts);
    }) as typeof s.put;

    const r = await runGc({ storage: s, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

    // Every attempt was made, and every one lost.
    expect(guardedPuts).toBe(GC_PENDING_CAS_MAX_ATTEMPTS);
    // `runGc` still reports success — the DELETE is durable, so the pass
    // is not a failure.
    expect(r.swept).toBe(1);
    await expect(s.get(staleLogKey)).resolves.toBeNull();
    // …and the candidate is STICKY: it names a key that no longer exists,
    // and it will be re-evaluated by the next pass against whatever the
    // bucket looks like then.
    const stuck = await readGcPending(s, PENDING_KEY);
    expect(stuck?.json.candidates.map((c) => c.key)).toEqual([staleLogKey]);
    // `pendingDepth` is best-effort on this path and deliberately does NOT
    // agree with the ledger: it reports our post-sweep view (0), while the
    // durable ledger still holds 1. Pinned because that divergence is the
    // documented contract of the `Conflict` catch, not a bug to "fix".
    expect(r.pendingDepth).toBe(0);
    expect(stuck?.json.candidates).toHaveLength(1);
  });

  // Production mutation caught: treating an occupied bounded probe as an
  // exact tail would build an incomplete live set and LIST/mark content;
  // returning before all other GC work would instead starve snapshot marks
  // and due sweeps while the hint catches up.
  test("defers only content GC after an inexact tail probe and checkpoints the certified lower bound", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(inner, KEY, logStateCurrentJson({ tail_hint: 0 }));
    await seedDenseLog(inner, 0, 60);
    const orphanSnapshot = `${PREFIX}/snapshot/L9/orphan.json`;
    const orphanContent = `${PREFIX}/content/00000000000000000000000000000000.json`;
    const dueKey = `${PREFIX}/gc/due-inexact.json`;
    await inner.put(orphanSnapshot, new TextEncoder().encode("{}"));
    await inner.put(orphanContent, new TextEncoder().encode("{}"));
    await createGcPending(inner, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: dueKey,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "stale-log",
          generation: LOG_STATE_GENERATION,
        },
      ],
      last_swept_at: "",
      content_scan_cursor: `${PREFIX}/content/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json`,
    });

    const { storage, trace } = tracingStorage(inner);
    const result = await runGc({ storage, currentJsonKey: KEY }, {
      maxTailProbeGets: 25,
      maxLiveLogEntriesPerRun: 20,
      maxMarksPerRun: 20,
      maxSweepsPerRun: 10,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    } as InternalRunGcOptions);

    expect(result).toEqual({
      marked: { stale_log: 0, orphan_snapshot: 1, orphan_content: 0 },
      swept: 1,
      dropped: { stale_generation: 0, still_live: 0 },
      pendingDepth: 1,
      // Budget class: expected on Free, and the checkpoint below is what
      // makes it self-clear.
      contentDeferredReason: "probe-budget",
    });
    const checkpointedCurrent = await readCurrentJson(inner, KEY);
    expect(checkpointedCurrent?.json.tail_hint).toBe(25);
    expect(trace.lists).toContain(`${PREFIX}/snapshot/`);
    expect(trace.lists).not.toContain(`${PREFIX}/content/`);
    expect(trace.deletes).toEqual([dueKey]);
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates.map((candidate) => candidate.key)).toEqual([orphanSnapshot]);
    expect(pending?.json.content_scan_cursor).toBe(
      `${PREFIX}/content/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json`,
    );
  });

  // Production mutation caught: an exact tail is not affordable merely
  // because the suffix probe was short; admitting when the complete live
  // range exceeds the cap would overspend, while returning immediately
  // would starve stale-log/snapshot marking and due sweeps.
  test("defers only content GC when the exact live tail exceeds the admission cap", async () => {
    const inner = new MemoryStorage();
    const liveSnapshot = `${PREFIX}/snapshot/L9/live.json`;
    const orphanSnapshot = `${PREFIX}/snapshot/L9/orphan.json`;
    const orphanContent = `${PREFIX}/content/00000000000000000000000000000000.json`;
    const dueKey = `${PREFIX}/gc/due-oversized.json`;
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        snapshot: liveSnapshot,
        log_seq_start: 20,
        tail_hint: 50,
      }),
    );
    await seedDenseLog(inner, 0, 60);
    await inner.put(liveSnapshot, new TextEncoder().encode("{}"));
    await inner.put(orphanSnapshot, new TextEncoder().encode("{}"));
    await inner.put(orphanContent, new TextEncoder().encode("{}"));
    await createGcPending(inner, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: dueKey,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "stale-log",
          generation: LOG_STATE_GENERATION,
        },
      ],
      last_swept_at: "",
      content_scan_cursor: `${PREFIX}/content/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json`,
    });

    const { storage, trace } = tracingStorage(inner);
    const result = await runGc({ storage, currentJsonKey: KEY }, {
      maxTailProbeGets: 25,
      maxLiveLogEntriesPerRun: 20,
      maxMarksPerRun: 20,
      maxSweepsPerRun: 10,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    } as InternalRunGcOptions);

    expect(result.marked.stale_log).toBeGreaterThan(0);
    expect(result.marked.orphan_snapshot).toBe(1);
    expect(result.marked.orphan_content).toBe(0);
    expect(result.swept).toBe(1);
    const checkpointedCurrent = await readCurrentJson(inner, KEY);
    expect(checkpointedCurrent?.json.tail_hint).toBe(60);
    expect(trace.lists).toContain(`${PREFIX}/log/`);
    expect(trace.lists).toContain(`${PREFIX}/snapshot/`);
    expect(trace.lists).not.toContain(`${PREFIX}/content/`);
    expect(trace.gets).not.toContain(liveSnapshot);
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.content_scan_cursor).toBe(
      `${PREFIX}/content/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json`,
    );
  });

  // Production mutation caught: probing the suffix and then scanning the
  // entire live range from storage would GET entries 50..59 twice. The exact
  // probe's decoded entries must feed the same liveness hash ingestion path.
  test("reuses exact probe entries so every admitted live log key is read once", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        log_seq_start: 40,
        tail_hint: 50,
      }),
    );
    await seedDenseLog(inner, 40, 60);
    const orphanContent = `${PREFIX}/content/00000000000000000000000000000000.json`;
    await inner.put(orphanContent, new TextEncoder().encode("{}"));

    const { storage, trace } = tracingStorage(inner);
    const result = await runGc({ storage, currentJsonKey: KEY }, {
      maxTailProbeGets: 25,
      maxLiveLogEntriesPerRun: 20,
      maxMarksPerRun: 20,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

    expect(result.marked.orphan_content).toBe(1);
    for (let seq = 40; seq < 60; seq++) {
      expect(trace.gets.filter((key) => key === `${PREFIX}/log/${seq}.json`)).toHaveLength(1);
    }
    expect(trace.gets.filter((key) => key === `${PREFIX}/log/60.json`)).toHaveLength(1);
  });

  test("a malformed bounded suffix checkpoints occupancy and defers only content work", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(
      inner,
      KEY,
      logStateCurrentJson({
        log_seq_start: 20,
        tail_hint: 30,
      }),
    );
    await seedLogEntry(inner, PREFIX, 0);
    await seedDenseLog(inner, 20, 36);
    await inner.put(`${PREFIX}/log/32.json`, new TextEncoder().encode("{"));
    const orphanSnapshot = `${PREFIX}/snapshot/L9/orphan-malformed-probe.json`;
    const dueSnapshot = snapshotKey(PREFIX, 0, 19, "e".repeat(64));
    const orphanContent = `${PREFIX}/content/ffffffffffffffffffffffffffffffff.json`;
    const dueStale = `${PREFIX}/gc/due-malformed-probe.json`;
    const storedCursor = `${PREFIX}/content/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json`;
    await inner.put(orphanSnapshot, new TextEncoder().encode("{}"));
    await inner.put(dueSnapshot, new TextEncoder().encode("{}"));
    await inner.put(orphanContent, new TextEncoder().encode("{}"));
    await createGcPending(inner, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: dueStale,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "stale-log",
          generation: LOG_STATE_GENERATION,
        },
        {
          key: dueSnapshot,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "orphan-snapshot",
          generation: LOG_STATE_GENERATION,
        },
      ],
      last_swept_at: "",
      content_scan_cursor: storedCursor,
    });
    const { storage, trace } = tracingStorage(inner);

    const result = await runGc({ storage, currentJsonKey: KEY }, {
      maxTailProbeGets: 25,
      maxLiveLogEntriesPerRun: 20,
      maxMarksPerRun: 20,
      maxSweepsPerRun: 10,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    } as InternalRunGcOptions);

    expect(result).toEqual({
      marked: { stale_log: 1, orphan_snapshot: 1, orphan_content: 0 },
      swept: 2,
      dropped: { stale_generation: 0, still_live: 0 },
      pendingDepth: 2,
      // Degraded class. This probe reaches an exact tail (36 is missing),
      // so only the malformed condition holds; the both-hold precedence
      // case is pinned separately below.
      contentDeferredReason: "probe-slot-malformed",
    });
    expect(trace.gets).toContain(`${PREFIX}/log/36.json`);
    expect(trace.lists).toEqual([`${PREFIX}/log/`, `${PREFIX}/snapshot/`]);
    expect(trace.deletes).toEqual([dueStale, dueSnapshot]);
    await expect(inner.get(orphanContent)).resolves.not.toBeNull();
    const current = await readCurrentJson(inner, KEY);
    expect(current?.json.tail_hint).toBe(36);
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.content_scan_cursor).toBe(storedCursor);
    expect(pending?.json.candidates.map((candidate) => candidate.key).toSorted()).toEqual(
      [`${PREFIX}/log/0.json`, orphanSnapshot].toSorted(),
    );
  });

  // Production mutation caught: treating a missing or malformed live entry as
  // an empty contribution produces a partial hash set. Content absent from that
  // partial set must not be classified; only the content phase is deferred.
  describe.each(["missing", "malformed"] as const)(
    "when a pre-probe-floor live log entry is %s",
    (failure) => {
      test("defers content classification and preserves its cursor", async () => {
        const inner = new MemoryStorage();
        await createCurrentJson(
          inner,
          KEY,
          logStateCurrentJson({
            log_seq_start: 40,
            tail_hint: 50,
          }),
        );
        await seedLogEntry(inner, PREFIX, 0);
        await seedDenseLog(inner, 40, 60);
        if (failure === "missing") {
          await inner.delete(`${PREFIX}/log/45.json`);
        } else {
          await inner.put(`${PREFIX}/log/45.json`, new TextEncoder().encode("not-json"));
        }
        const orphanSnapshot = `${PREFIX}/snapshot/L9/orphan-incomplete-log.json`;
        const orphanContent = `${PREFIX}/content/ffffffffffffffffffffffffffffffff.json`;
        const dueStaleKey = `${PREFIX}/gc/due-incomplete-log.json`;
        const dueSnapshotKey = snapshotKey(PREFIX, 0, 39, "f".repeat(64));
        const storedCursor = `${PREFIX}/content/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json`;
        await inner.put(orphanSnapshot, new TextEncoder().encode("{}"));
        await inner.put(dueSnapshotKey, new TextEncoder().encode("{}"));
        await inner.put(orphanContent, new TextEncoder().encode("{}"));
        await createGcPending(inner, PENDING_KEY, {
          schema_version: GC_PENDING_SCHEMA_VERSION,
          candidates: [
            {
              key: dueStaleKey,
              due_at: "2000-01-01T00:00:00.000Z",
              reason: "stale-log",
              generation: LOG_STATE_GENERATION,
            },
            {
              key: dueSnapshotKey,
              due_at: "2000-01-01T00:00:00.000Z",
              reason: "orphan-snapshot",
              generation: LOG_STATE_GENERATION,
            },
            {
              key: orphanContent,
              due_at: "2000-01-01T00:00:00.000Z",
              reason: "orphan-content",
              generation: LOG_STATE_GENERATION,
            },
          ],
          last_swept_at: "",
          content_scan_cursor: storedCursor,
        });

        const { storage, trace } = tracingStorage(inner);
        const result = await runGc({ storage, currentJsonKey: KEY }, {
          maxTailProbeGets: 25,
          maxLiveLogEntriesPerRun: 20,
          maxMarksPerRun: 20,
          maxSweepsPerRun: 10,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        } as InternalRunGcOptions);

        expect(result).toEqual({
          marked: { stale_log: 1, orphan_snapshot: 1, orphan_content: 0 },
          swept: 2,
          dropped: { stale_generation: 0, still_live: 0 },
          pendingDepth: 3,
          contentDeferredReason: "live-log-unreadable",
        });
        expect(trace.lists).toContain(`${PREFIX}/log/`);
        expect(trace.lists).toContain(`${PREFIX}/snapshot/`);
        expect(trace.lists).not.toContain(`${PREFIX}/content/`);
        expect(trace.deletes).toEqual([dueStaleKey, dueSnapshotKey]);
        await expect(inner.get(orphanContent)).resolves.not.toBeNull();
        const pending = await readGcPending(inner, PENDING_KEY);
        expect(pending?.json.content_scan_cursor).toBe(storedCursor);
        expect(pending?.json.candidates.map((candidate) => candidate.reason).toSorted()).toEqual([
          "orphan-content",
          "orphan-snapshot",
          "stale-log",
        ]);
      });
    },
  );

  // Production mutation caught: swallowing a current-snapshot read failure
  // and returning the hashes collected so far makes every snapshot-only row
  // look dead. All snapshot failure modes must defer content classification.
  describe.each(["failed", "missing", "corrupt"] as const)(
    "when the current snapshot is %s",
    (failure) => {
      test("defers content classification and preserves its cursor", async () => {
        const inner = new MemoryStorage();
        const currentSnapshot = `${PREFIX}/snapshot/L9/000000000000-000000000040-${"a".repeat(64)}.json`;
        await createCurrentJson(
          inner,
          KEY,
          logStateCurrentJson({
            snapshot: currentSnapshot,
            log_seq_start: 0,
            tail_hint: 0,
          }),
        );
        if (failure !== "missing") {
          await inner.put(currentSnapshot, new TextEncoder().encode("not-a-valid-snapshot"));
        }
        const orphanSnapshot = `${PREFIX}/snapshot/L9/orphan-incomplete-snapshot.json`;
        const orphanContent = `${PREFIX}/content/ffffffffffffffffffffffffffffffff.json`;
        const dueKey = `${PREFIX}/gc/due-incomplete-snapshot.json`;
        const storedCursor = `${PREFIX}/content/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json`;
        await inner.put(orphanSnapshot, new TextEncoder().encode("{}"));
        await inner.put(orphanContent, new TextEncoder().encode("{}"));
        await createGcPending(inner, PENDING_KEY, {
          schema_version: GC_PENDING_SCHEMA_VERSION,
          candidates: [
            {
              key: dueKey,
              due_at: "2000-01-01T00:00:00.000Z",
              reason: "stale-log",
              generation: LOG_STATE_GENERATION,
            },
          ],
          last_swept_at: "",
          content_scan_cursor: storedCursor,
        });
        const subject: Storage =
          failure === "failed"
            ? {
                get: (key, opts) => {
                  if (key === currentSnapshot) {
                    throw new BaerlyError("AccessDenied", "snapshot read denied");
                  }
                  return inner.get(key, opts);
                },
                put: (key, body, opts) => inner.put(key, body, opts),
                delete: (key, opts) => inner.delete(key, opts),
                list: (prefix, opts) => inner.list(prefix, opts),
              }
            : inner;

        const { storage, trace } = tracingStorage(subject);
        const result = await runGc({ storage, currentJsonKey: KEY }, {
          maxTailProbeGets: 25,
          maxLiveLogEntriesPerRun: 20,
          maxMarksPerRun: 20,
          maxSweepsPerRun: 10,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        } as InternalRunGcOptions);

        expect(result).toEqual({
          marked: { stale_log: 0, orphan_snapshot: 1, orphan_content: 0 },
          swept: 1,
          dropped: { stale_generation: 0, still_live: 0 },
          pendingDepth: 1,
          // The reviewer-cited scenario: a persistent AccessDenied here
          // parks orphan-content GC forever, so the pass must NOT look
          // identical to an orphan-free one.
          contentDeferredReason: "snapshot-unreadable",
        });
        expect(trace.lists).toContain(`${PREFIX}/snapshot/`);
        expect(trace.lists).not.toContain(`${PREFIX}/content/`);
        expect(trace.deletes).toEqual([dueKey]);
        await expect(inner.get(orphanContent)).resolves.not.toBeNull();
        const pending = await readGcPending(inner, PENDING_KEY);
        expect(pending?.json.content_scan_cursor).toBe(storedCursor);
        expect(pending?.json.candidates.map((candidate) => candidate.reason)).toEqual([
          "orphan-snapshot",
        ]);
      });
    },
  );

  // A degraded pass and a genuinely orphan-free one both mark zero content
  // and sweep zero content. Without a signal that separates them, a
  // persistent snapshot fault disables orphan-content GC silently and
  // forever. Pin both directions of that discrimination.
  describe("content-deferral signal", () => {
    // The class, not the string, is what a cron caller branches on to
    // decide whether to page. Pin every member so a reason that changes
    // class — or a new one classified wrongly — fails here rather than in
    // an operator's alerting rule.
    test("classifies every deferral reason as budget or degraded", () => {
      const byReason: Readonly<Record<ContentDeferralReason, boolean>> = {
        "probe-budget": false,
        "live-tail-over-cap": false,
        "probe-slot-malformed": true,
        "live-log-unreadable": true,
        "snapshot-unreadable": true,
      };
      for (const [reason, degraded] of Object.entries(byReason)) {
        expect(isDegradedContentDeferral(reason as ContentDeferralReason)).toBe(degraded);
      }
      // Total over the result field: no deferral is not a degraded one.
      expect(isDegradedContentDeferral(undefined)).toBe(false);
    });

    test("counts a degraded pass under its reason label", async () => {
      const inner = new MemoryStorage();
      const currentSnapshot = `${PREFIX}/snapshot/L9/000000000000-000000000040-${"a".repeat(64)}.json`;
      await createCurrentJson(
        inner,
        KEY,
        logStateCurrentJson({ snapshot: currentSnapshot, log_seq_start: 0, tail_hint: 0 }),
      );
      await inner.put(currentSnapshot, new TextEncoder().encode("not-a-valid-snapshot"));
      const denied: Storage = {
        get: (key, opts) => {
          if (key === currentSnapshot) {
            throw new BaerlyError("AccessDenied", "snapshot read denied");
          }
          return inner.get(key, opts);
        },
        put: (key, body, opts) => inner.put(key, body, opts),
        delete: (key, opts) => inner.delete(key, opts),
        list: (prefix, opts) => inner.list(prefix, opts),
      };

      const ctx = createObservabilityContext();
      let result!: Awaited<ReturnType<typeof runGc>>;
      await runWithContext(ctx, async () => {
        result = await runGc({ storage: denied, currentJsonKey: KEY }, {
          maxMarksPerRun: 20,
          maxSweepsPerRun: 10,
        } as InternalRunGcOptions);
      });

      expect(result.contentDeferredReason).toBe("snapshot-unreadable");
      expect(
        ctx.recorder.snapshot().counters.filter((c) => c.name === "db.gc.content_deferred_total"),
      ).toEqual([
        {
          name: "db.gc.content_deferred_total",
          value: 1,
          labels: { collection: COLL, reason: "snapshot-unreadable" },
        },
      ]);
    });

    test("emits nothing when a complete live set classified content", async () => {
      const inner = new MemoryStorage();
      await createCurrentJson(inner, KEY, logStateCurrentJson({ tail_hint: 0 }));

      const ctx = createObservabilityContext();
      let result!: Awaited<ReturnType<typeof runGc>>;
      await runWithContext(ctx, async () => {
        result = await runGc({ storage: inner, currentJsonKey: KEY }, {
          maxMarksPerRun: 20,
          maxSweepsPerRun: 10,
        } as InternalRunGcOptions);
      });

      expect(result.contentDeferredReason).toBeUndefined();
      expect(
        ctx.recorder.snapshot().counters.find((c) => c.name === "db.gc.content_deferred_total"),
      ).toBeUndefined();
    });

    // Precedence, not just labelling: a probe can exhaust its budget AND
    // contain a malformed slot. Reporting the budget reason there would
    // file an actionable corruption under the one outcome operators are
    // told to expect on Free, so the degraded reason must win.
    test("reports the degraded reason when a budget reason also holds", async () => {
      const inner = new MemoryStorage();
      await createCurrentJson(inner, KEY, logStateCurrentJson({ log_seq_start: 0, tail_hint: 0 }));
      // Dense past the 25-GET cap, so the probe never sees a 404 and can
      // only return `at-least` — and slot 5 inside that range is malformed.
      await seedDenseLog(inner, 0, 40);
      await inner.put(`${PREFIX}/log/5.json`, new TextEncoder().encode("{"));

      const result = await runGc({ storage: inner, currentJsonKey: KEY }, {
        maxTailProbeGets: 25,
        maxLiveLogEntriesPerRun: 20,
        maxMarksPerRun: 20,
        maxSweepsPerRun: 10,
      } as InternalRunGcOptions);

      expect(result.contentDeferredReason).toBe("probe-slot-malformed");
      // The budget half of the pass still happened: occupancy was
      // certified up to the cap and checkpointed.
      await expect(readCurrentJson(inner, KEY)).resolves.toMatchObject({
        json: { tail_hint: 25 },
      });
    });
  });

  // Production mutation caught: a retrying current.json helper would spend
  // extra budget and could run GC against a different admission snapshot.
  // The captured-etag checkpoint is one attempt; Conflict returns zero work.
  test("returns zero work after one admission checkpoint conflict", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(inner, KEY, logStateCurrentJson({ tail_hint: 0 }));
    await seedDenseLog(inner, 0, 60);
    const conflictOnCheckpoint: Storage = {
      get: (key, opts) => inner.get(key, opts),
      put: async (key, body, opts) => {
        if (key === KEY && opts?.ifMatch !== undefined) {
          throw new BaerlyError("Conflict", "checkpoint lost");
        }
        return inner.put(key, body, opts);
      },
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
    };
    const { storage, trace } = tracingStorage(conflictOnCheckpoint);

    const ctx = createObservabilityContext();
    let result!: Awaited<ReturnType<typeof runGc>>;
    await runWithContext(ctx, async () => {
      result = await runGc({ storage, currentJsonKey: KEY }, {
        maxTailProbeGets: 25,
        maxLiveLogEntriesPerRun: 20,
        maxMarksPerRun: 20,
        maxSweepsPerRun: 10,
      } as InternalRunGcOptions);
    });

    // A lost checkpoint is contention, not an idle collection. Counted the
    // way `compact()` counts its own, and the deferral still reported, so
    // the early return cannot swallow a DEGRADED reason.
    const counters = ctx.recorder.snapshot().counters;
    expect(counters.filter((c) => c.name === "db.gc.cas_lost_total")).toEqual([
      { name: "db.gc.cas_lost_total", value: 1, labels: { collection: COLL } },
    ]);
    expect(counters.filter((c) => c.name === "db.gc.content_deferred_total")).toEqual([
      {
        name: "db.gc.content_deferred_total",
        value: 1,
        labels: { collection: COLL, reason: "probe-budget" },
      },
    ]);
    // Zero work, but NOT an idle no-op: the pass deferred content
    // classification, and that has to survive the lost checkpoint.
    expect(result).toEqual({
      marked: { stale_log: 0, orphan_snapshot: 0, orphan_content: 0 },
      swept: 0,
      dropped: { stale_generation: 0, still_live: 0 },
      pendingDepth: 0,
      contentDeferredReason: "probe-budget",
    });
    const unchangedCurrent = await readCurrentJson(inner, KEY);
    expect(unchangedCurrent?.json.tail_hint).toBe(0);
    expect(trace.puts.filter((put) => put.key === KEY)).toHaveLength(1);
    expect(trace.gets.filter((key) => key === PENDING_KEY)).toHaveLength(0);
    expect(trace.puts.filter((put) => put.key === PENDING_KEY)).toHaveLength(0);
    expect(trace.lists).toEqual([]);
  });

  // Production mutation caught: broad checkpoint error swallowing would hide
  // access/transient failures and report a successful no-op. Only Conflict is
  // the safe zero-work outcome.
  test("propagates a non-Conflict admission checkpoint failure", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(inner, KEY, logStateCurrentJson({ tail_hint: 0 }));
    await seedDenseLog(inner, 0, 60);
    const deniedCheckpoint: Storage = {
      get: (key, opts) => inner.get(key, opts),
      put: async (key, body, opts) => {
        if (key === KEY && opts?.ifMatch !== undefined) {
          throw new BaerlyError("AccessDenied", "checkpoint denied");
        }
        return inner.put(key, body, opts);
      },
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
    };
    const { storage, trace } = tracingStorage(deniedCheckpoint);

    await expect(
      runGc({ storage, currentJsonKey: KEY }, {
        maxTailProbeGets: 25,
        maxLiveLogEntriesPerRun: 20,
        maxMarksPerRun: 20,
        maxSweepsPerRun: 10,
      } as InternalRunGcOptions),
    ).rejects.toMatchObject({ code: "AccessDenied" });
    expect(trace.gets.filter((key) => key === PENDING_KEY)).toHaveLength(0);
    expect(trace.lists).toEqual([]);
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

  // ── stale-log LIST rotation ──────────────────────────────────────
  // The sibling of the orphan-content rotation above, reached by a
  // different route. `logObjectKey` builds UNPADDED decimal keys, so
  // lex order is `0, 1, 10, 100…109, 11, …` and the LIVE keys at/above
  // `log_seq_start` interleave with — and routinely lex-PRECEDE — the
  // stale ones below it. A bounded pass listing from the lexicographic
  // start can therefore spend its whole budget on live keys it will
  // never delete, and never reach the stale keys behind them. Deletion
  // cannot advance a window that is entirely live.
  //
  // NOTE the inversion vs. `seedOrphanContent`: that helper pads to 32
  // hex digits SO THAT lex order == seed order. These seeds must NOT
  // pad — the interleaving IS the defect, and a padded seed would pass
  // against the broken code.
  const STALE_LOG_PREFIX = "app/t/tenant/x/manifests/c/log";
  const logKey = (seq: number): string => `${STALE_LOG_PREFIX}/${seq}.json`;

  /**
   * Floor at 100 with a five-entry live tail `[100, 105)` plus two
   * stale entries `11` and `12`. Lex order is
   * `100, 101, 102, 103, 104, 11, 12` — the five LIVE keys sort FIRST
   * and the two stale ones are stranded behind them.
   */
  const seedInterleavedLog = async (s: MemoryStorage): Promise<void> => {
    await createCurrentJson(
      s,
      KEY,
      logStateCurrentJson({
        log_seq_start: 100,
        tail_hint: 105,
        writer_fence: { epoch: 0, owner: "gc-test", claimed_at: "" },
      }),
    );
    for (const seq of [100, 101, 102, 103, 104, 11, 12]) {
      await seedLogEntry(s, "app/t/tenant/x/manifests/c", seq);
    }
  };

  test("advances the log cursor on an all-live (zero-mark) window", async () => {
    const s = new MemoryStorage();
    await seedInterleavedLog(s);
    // maxMarks=5 ⇒ the LIST examines exactly the five live keys
    // 100..104 and marks nothing. The cursor MUST still advance to the
    // last one so the next pass reaches the stale keys behind them.
    // 5 examined == maxMarks ⇒ NOT end-of-keyspace ⇒ carried, not wrapped.
    const r = await runGc({ storage: s, currentJsonKey: KEY }, {
      maxMarksPerRun: 5,
    } as InternalRunGcOptions);
    expect(r.marked.stale_log).toBe(0);
    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.log_scan_cursor).toBe(logKey(104));
  });

  test("rotates the stale-log LIST so sub-floor keys behind the first window are eventually swept", async () => {
    const s = new MemoryStorage();
    await seedInterleavedLog(s);
    // Pass 1 examines the all-live window and marks nothing; pass 2
    // resumes past it and reaches 11 + 12. Without rotation pass 2 is a
    // verbatim replay of pass 1 and the two stale keys leak forever.
    let totalSwept = 0;
    for (let pass = 0; pass < 2; pass++) {
      const r = await runGc({ storage: s, currentJsonKey: KEY }, {
        graceMillis: 0,
        maxMarksPerRun: 5,
        maxSweepsPerRun: 5,
      } as InternalRunGcOptions);
      totalSwept += r.swept;
    }
    expect(totalSwept).toBe(2);
    await expect(s.get(logKey(11))).resolves.toBeNull();
    await expect(s.get(logKey(12))).resolves.toBeNull();
    // The live tail is untouched.
    for (let seq = 100; seq < 105; seq++) {
      await expect(s.get(logKey(seq))).resolves.not.toBeNull();
    }
  });

  test("persists log_scan_cursor across passes and WRAPS to undefined at the end", async () => {
    const s = new MemoryStorage();
    await seedInterleavedLog(s);
    // Pass 1: 5 examined == maxMarks ⇒ cursor carried at the 5th key.
    await runGc({ storage: s, currentJsonKey: KEY }, {
      maxMarksPerRun: 5,
    } as InternalRunGcOptions);
    const after1 = await readGcPending(s, PENDING_KEY);
    expect(after1?.json.log_scan_cursor).toBe(logKey(104));

    // Pass 2: resumes startAfter log/104.json, examines [11, 12] = 2
    // keys < maxMarks ⇒ reached the end ⇒ WRAP (cursor cleared).
    await runGc({ storage: s, currentJsonKey: KEY }, {
      maxMarksPerRun: 5,
    } as InternalRunGcOptions);
    const after2 = await readGcPending(s, PENDING_KEY);
    expect(after2?.json.log_scan_cursor).toBeUndefined();
  });

  test("unbounded runGc from a CURSORLESS ledger marks ALL stale logs in one pass and wraps", async () => {
    const s = new MemoryStorage();
    await seedInterleavedLog(s);
    // No maxMarksPerRun ⇒ DEFAULT_MAX_MARKS. The LIST yields all seven
    // keys (< maxKeys) in one pass, so the reconcile path is unchanged.
    // "Cursorless" is load-bearing in the name — see the next test.
    const r = await runGc({ storage: s, currentJsonKey: KEY }, {
      graceMillis: 0,
    } as InternalRunGcOptions);
    expect(r.marked.stale_log).toBe(2);
    expect(r.swept).toBe(2);
    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.log_scan_cursor).toBeUndefined();
  });

  test("an unbounded pass RESUMES from a cursor a bounded pass left, then wraps", async () => {
    // BOUNDED and CURSORED are independent axes: `listWindow` applies
    // `startAfter` whenever the ledger carries a cursor, whatever
    // `maxKeys` is. So "unbounded" does NOT mean "scans the whole
    // keyspace" — it means "cannot be cut short by the budget". An
    // unbounded pass that inherits a bounded pass's cursor covers only
    // cursor→end.
    //
    // This is liveness-only and self-healing (the pass wraps, so the
    // next one starts from the beginning), which is why it is specified
    // rather than fixed: suppressing the cursor on the unbounded path
    // would cost a branch in a tight closure to defend a claim we can
    // simply state accurately. Pinned so the behavior is a decision,
    // not an accident. Surfaced by Fresh Eyes on PR #82.
    const s = new MemoryStorage();
    await seedInterleavedLog(s);
    // Park the cursor at the very END of the keyspace: 7 keys examined
    // == maxMarks ⇒ no wrap, cursor at the lex-last key (log/12.json).
    await runGc({ storage: s, currentJsonKey: KEY }, {
      maxMarksPerRun: 7,
    } as InternalRunGcOptions);
    const parked = await readGcPending(s, PENDING_KEY);
    expect(parked?.json.log_scan_cursor).toBe(logKey(12));

    // Add a stale key that sorts FIRST ("0" < "1"), i.e. strictly
    // BEHIND the parked cursor. This is what makes the assertion
    // decisive: a from-the-beginning scan would mark it, a resuming
    // scan cannot see it. Counting marks alone would not distinguish
    // the two, because both reach the same set from log/104 onward.
    await seedLogEntry(s, "app/t/tenant/x/manifests/c", 0);

    const resumed = await runGc({ storage: s, currentJsonKey: KEY }, {
      graceMillis: 0,
    } as InternalRunGcOptions);
    // Unbounded, yet it marks NOTHING new — it resumed past log/0.json.
    expect(resumed.marked.stale_log).toBe(0);
    await expect(s.get(logKey(0))).resolves.not.toBeNull();
    // ...and it wrapped, which is the self-healing half.
    const wrapped = await readGcPending(s, PENDING_KEY);
    expect(wrapped?.json.log_scan_cursor).toBeUndefined();

    // Next pass is cursorless, so the whole keyspace is in scope again
    // and the straggler is reclaimed. One extra pass, nothing stranded.
    const healed = await runGc({ storage: s, currentJsonKey: KEY }, {
      graceMillis: 0,
    } as InternalRunGcOptions);
    expect(healed.marked.stale_log).toBe(1);
    await expect(s.get(logKey(0))).resolves.toBeNull();
  });

  test("the cursor advances past a window of already-pending (known) keys", async () => {
    const s = new MemoryStorage();
    // A FULL window of stale keys, so one window can be entirely
    // already-marked. Floor 100, stale 11..15, live 100..104 — lex order
    // is 100,101,102,103,104,11,12,13,14,15, so the two groups are
    // exactly one maxMarks=5 window each.
    await createCurrentJson(
      s,
      KEY,
      logStateCurrentJson({
        log_seq_start: 100,
        tail_hint: 105,
        writer_fence: { epoch: 0, owner: "gc-test", claimed_at: "" },
      }),
    );
    for (const seq of [100, 101, 102, 103, 104, 11, 12, 13, 14, 15]) {
      await seedLogEntry(s, "app/t/tenant/x/manifests/c", seq);
    }
    const pass = async (): Promise<void> => {
      // DEFAULT grace — marks accumulate in the ledger and are NOT
      // swept, which is the production shape for a full 7 days.
      await runGc({ storage: s, currentJsonKey: KEY }, {
        maxMarksPerRun: 5,
      } as InternalRunGcOptions);
    };
    await pass(); // 1: all-live window        ⇒ cursor log/104
    await pass(); // 2: marks 11..15           ⇒ cursor log/15
    await pass(); // 3: nothing left           ⇒ wrap
    await pass(); // 4: all-live window again  ⇒ cursor log/104
    const before = await readGcPending(s, PENDING_KEY);
    expect(before?.json.log_scan_cursor).toBe(logKey(104));

    // Pass 5 is the one that matters: the window is 11..15, every key
    // already in `known` and awaiting grace. Zero marks — but the
    // cursor MUST still step past them. Advancing only on marked (or
    // only on not-`known`) keys would leave the cursor here forever, so
    // a ledger full of pending candidates re-creates the exact stall
    // the rotation removes — and under the 7-day default that state
    // lasts a week, making it the DOMINANT case, not an edge one.
    const r5 = await runGc({ storage: s, currentJsonKey: KEY }, {
      maxMarksPerRun: 5,
    } as InternalRunGcOptions);
    expect(r5.marked.stale_log).toBe(0);
    expect(r5.swept).toBe(0);
    const after = await readGcPending(s, PENDING_KEY);
    expect(after?.json.log_scan_cursor).toBe(logKey(15));
    expect(after?.json.candidates).toHaveLength(5);
  });

  test("a collection with no floor (log_seq_start = 0) CLEARS an existing log cursor", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    await seedLogEntry(s, "app/t/tenant/x/manifests/c", 0);
    // Seed a cursor first, so this pins the DECISION rather than the
    // absence of one: starting from a ledger with no cursor would make
    // `toBeUndefined()` trivially true and the opposite decision
    // (echo the stored cursor back) would pass too.
    await createGcPending(s, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [],
      last_swept_at: "",
      log_scan_cursor: "app/t/tenant/x/manifests/c/log/9.json",
    });
    // The stale-log phase is skipped entirely when there is no floor.
    // We treat that as a WRAP: the candidate set is empty, so "examined
    // all of it" is trivially true and the correct next position is the
    // beginning. The alternative — echo the stored cursor back, which
    // the greater-of merge would turn into a no-op — is expressible,
    // but it re-skips the head of the keyspace for a rotation after a
    // concurrent wrap. Both are liveness-only; this pins which we chose.
    const r = await runGc({ storage: s, currentJsonKey: KEY }, {
      maxMarksPerRun: 1,
    } as InternalRunGcOptions);
    expect(r.marked.stale_log).toBe(0);
    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.log_scan_cursor).toBeUndefined();
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

  // A partial live-content set cannot prove ANY content key dead — the
  // post-images it is missing are exactly the ones that look orphan. These
  // run the DEFAULT (unbounded) path, because the deferral is not a
  // budget behaviour: a Node operator with an unreadable artifact gets it
  // too. Only the content phase defers; stale-log and orphan-snapshot work
  // and their due sweeps continue.
  describe.each(["missing", "malformed"] as const)(
    "when a live log entry is %s on the default path",
    (failure) => {
      test("defers content classification and preserves its cursor", async () => {
        const inner = new MemoryStorage();
        await createCurrentJson(
          inner,
          KEY,
          logStateCurrentJson({
            log_seq_start: 40,
            tail_hint: 50,
          }),
        );
        await seedLogEntry(inner, PREFIX, 0);
        await seedDenseLog(inner, 40, 60);
        if (failure === "missing") {
          await inner.delete(`${PREFIX}/log/45.json`);
        } else {
          await inner.put(`${PREFIX}/log/45.json`, new TextEncoder().encode("not-json"));
        }
        const orphanSnapshot = `${PREFIX}/snapshot/L9/orphan-incomplete-log.json`;
        const orphanContent = `${PREFIX}/content/ffffffffffffffffffffffffffffffff.json`;
        const dueStaleKey = `${PREFIX}/gc/due-incomplete-log.json`;
        const dueSnapshotKey = snapshotKey(PREFIX, 0, 39, "f".repeat(64));
        const storedCursor = `${PREFIX}/content/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json`;
        await inner.put(orphanSnapshot, new TextEncoder().encode("{}"));
        await inner.put(dueSnapshotKey, new TextEncoder().encode("{}"));
        await inner.put(orphanContent, new TextEncoder().encode("{}"));
        await createGcPending(inner, PENDING_KEY, {
          schema_version: GC_PENDING_SCHEMA_VERSION,
          candidates: [
            {
              key: dueStaleKey,
              due_at: "2000-01-01T00:00:00.000Z",
              reason: "stale-log",
              generation: LOG_STATE_GENERATION,
            },
            {
              key: dueSnapshotKey,
              due_at: "2000-01-01T00:00:00.000Z",
              reason: "orphan-snapshot",
              generation: LOG_STATE_GENERATION,
            },
            {
              key: orphanContent,
              due_at: "2000-01-01T00:00:00.000Z",
              reason: "orphan-content",
              generation: LOG_STATE_GENERATION,
            },
          ],
          last_swept_at: "",
          content_scan_cursor: storedCursor,
        });

        const { storage, trace } = tracingStorage(inner);
        const result = await runGc({ storage, currentJsonKey: KEY }, {
          maxMarksPerRun: 20,
          maxSweepsPerRun: 10,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        } as InternalRunGcOptions);

        expect(result).toEqual({
          marked: { stale_log: 1, orphan_snapshot: 1, orphan_content: 0 },
          swept: 2,
          dropped: { stale_generation: 0, still_live: 0 },
          pendingDepth: 3,
          contentDeferredReason: "live-log-unreadable",
        });
        // The content LIST never runs — nothing can be classified.
        expect(trace.lists).toContain(`${PREFIX}/log/`);
        expect(trace.lists).toContain(`${PREFIX}/snapshot/`);
        expect(trace.lists).not.toContain(`${PREFIX}/content/`);
        expect(trace.deletes).toEqual([dueStaleKey, dueSnapshotKey]);
        // The pending orphan-content candidate is NOT swept on an
        // unprovable pass, and the cursor does not move.
        await expect(inner.get(orphanContent)).resolves.not.toBeNull();
        const pending = await readGcPending(inner, PENDING_KEY);
        expect(pending?.json.content_scan_cursor).toBe(storedCursor);
        expect(pending?.json.candidates.map((candidate) => candidate.reason).toSorted()).toEqual([
          "orphan-content",
          "orphan-snapshot",
          "stale-log",
        ]);
      });
    },
  );

  // Swallowing a current-snapshot read failure and returning the hashes
  // collected so far makes every snapshot-only row look dead. All snapshot
  // failure modes must defer content classification, on every host.
  describe.each(["failed", "missing", "corrupt"] as const)(
    "when the current snapshot is %s on the default path",
    (failure) => {
      test("defers content classification and preserves its cursor", async () => {
        const inner = new MemoryStorage();
        const currentSnapshot = `${PREFIX}/snapshot/L9/000000000000-000000000040-${"a".repeat(64)}.json`;
        await createCurrentJson(
          inner,
          KEY,
          logStateCurrentJson({
            snapshot: currentSnapshot,
            log_seq_start: 0,
            tail_hint: 0,
          }),
        );
        if (failure !== "missing") {
          await inner.put(currentSnapshot, new TextEncoder().encode("not-a-valid-snapshot"));
        }
        const orphanSnapshot = `${PREFIX}/snapshot/L9/orphan-incomplete-snapshot.json`;
        const orphanContent = `${PREFIX}/content/ffffffffffffffffffffffffffffffff.json`;
        const dueKey = `${PREFIX}/gc/due-incomplete-snapshot.json`;
        const storedCursor = `${PREFIX}/content/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json`;
        await inner.put(orphanSnapshot, new TextEncoder().encode("{}"));
        await inner.put(orphanContent, new TextEncoder().encode("{}"));
        await createGcPending(inner, PENDING_KEY, {
          schema_version: GC_PENDING_SCHEMA_VERSION,
          candidates: [
            {
              key: dueKey,
              due_at: "2000-01-01T00:00:00.000Z",
              reason: "stale-log",
              generation: LOG_STATE_GENERATION,
            },
          ],
          last_swept_at: "",
          content_scan_cursor: storedCursor,
        });
        const subject: Storage =
          failure === "failed"
            ? {
                get: (key, opts) => {
                  if (key === currentSnapshot) {
                    throw new BaerlyError("AccessDenied", "snapshot read denied");
                  }
                  return inner.get(key, opts);
                },
                put: (key, body, opts) => inner.put(key, body, opts),
                delete: (key, opts) => inner.delete(key, opts),
                list: (prefix, opts) => inner.list(prefix, opts),
              }
            : inner;

        const { storage, trace } = tracingStorage(subject);
        const result = await runGc({ storage, currentJsonKey: KEY }, {
          maxMarksPerRun: 20,
          maxSweepsPerRun: 10,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        } as InternalRunGcOptions);

        expect(result).toEqual({
          marked: { stale_log: 0, orphan_snapshot: 1, orphan_content: 0 },
          swept: 1,
          dropped: { stale_generation: 0, still_live: 0 },
          pendingDepth: 1,
          // A persistent AccessDenied here parks orphan-content GC
          // forever, so the pass must NOT look identical to an
          // orphan-free one.
          contentDeferredReason: "snapshot-unreadable",
        });
        expect(trace.lists).toContain(`${PREFIX}/snapshot/`);
        expect(trace.lists).not.toContain(`${PREFIX}/content/`);
        expect(trace.deletes).toEqual([dueKey]);
        await expect(inner.get(orphanContent)).resolves.not.toBeNull();
        const pending = await readGcPending(inner, PENDING_KEY);
        expect(pending?.json.content_scan_cursor).toBe(storedCursor);
        expect(pending?.json.candidates.map((candidate) => candidate.reason)).toEqual([
          "orphan-snapshot",
        ]);
      });
    },
  );
});

// ---------------------------------------------------------------------
// The sweep-time revalidation gate.
//
// Before this gate the sweep had exactly two conjuncts: a budget counter
// and `due_at <= now`. A mark decision taken under one view of the
// bucket therefore executed up to `GC_GRACE_PERIOD_MILLIS` later under a
// different one, with no liveness re-check. These tests pin the four
// outcomes the gate now distinguishes, and each is written so that
// removing the arm under test turns it RED rather than merely changing a
// count — the object's continued existence is the assertion, not the
// tally.
// ---------------------------------------------------------------------
describe("runGc — sweep-time revalidation", () => {
  const OTHER_GENERATION = "ffffffffffff";

  /** Seed a manifest + a due `stale-log` candidate naming `log/<seq>`. */
  const seedDueStaleLog = async (
    storage: MemoryStorage,
    opts: { floor: number; seq: number; manifestGeneration?: string; candidateGeneration?: string },
  ): Promise<string> => {
    await createCurrentJson(
      storage,
      KEY,
      logStateCurrentJson({
        log_seq_start: opts.floor,
        tail_hint: opts.floor,
        ...(opts.manifestGeneration !== undefined && { generation: opts.manifestGeneration }),
      }),
    );
    const key = `${PREFIX}/log/${String(opts.seq)}.json`;
    await storage.put(key, new TextEncoder().encode("{}"));
    await createGcPending(storage, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "stale-log",
          ...(opts.candidateGeneration !== undefined && {
            generation: opts.candidateGeneration,
          }),
        },
      ],
      last_swept_at: "",
    });
    return key;
  };

  const sweep = async (storage: MemoryStorage): ReturnType<typeof runGc> =>
    runGc({ storage, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

  test("drops a due candidate whose generation no longer matches the manifest", async () => {
    // The reachable data-loss schedule, reduced to its gate. A candidate
    // was marked against generation A; `admin restore --force` has since
    // re-minted the manifest to generation B and re-created `log/5` as a
    // LIVE entry of the new incarnation. Without the fence this DELETEs
    // a live log object, putting a hole inside `[log_seq_start, tail)` —
    // after which every read and every fold throws `Internal` from
    // `walkLogRangeWithBytes` and the collection cannot heal itself.
    const s = new MemoryStorage();
    const key = await seedDueStaleLog(s, {
      floor: 9,
      seq: 5,
      manifestGeneration: OTHER_GENERATION,
      candidateGeneration: LOG_STATE_GENERATION,
    });

    const r = await sweep(s);

    // The load-bearing assertion: the object SURVIVES. A drop resolves a
    // candidate out of the ledger; it never deletes.
    await expect(s.get(key)).resolves.not.toBeNull();
    expect(r.swept).toBe(0);
    expect(r.dropped).toEqual({ stale_generation: 1, still_live: 0 });
    // …and it really left the ledger, rather than being retained and
    // re-examined (and re-dropped) on every future pass.
    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.candidates).toEqual([]);
  });

  test("sweeps a due candidate whose generation still matches", async () => {
    // The control for the test above: the fence must not swallow the
    // ordinary case. Same fixture, same floor, same due date — only the
    // manifest generation agrees.
    const s = new MemoryStorage();
    const key = await seedDueStaleLog(s, {
      floor: 9,
      seq: 5,
      candidateGeneration: LOG_STATE_GENERATION,
    });

    const r = await sweep(s);

    await expect(s.get(key)).resolves.toBeNull();
    expect(r.swept).toBe(1);
    expect(r.dropped).toEqual({ stale_generation: 0, still_live: 0 });
  });

  test("drops a candidate marked before the build began stamping generations", async () => {
    // The upgrade path. A ledger written by an older build carries no
    // `generation` at all, and absent cannot be proven to match a
    // manifest that has one — so the whole pre-upgrade ledger is dropped
    // on the first pass and re-marked on the next with a fresh grace
    // period. One-time, self-healing, and visible as a single
    // `stale-generation` spike.
    const s = new MemoryStorage();
    const key = await seedDueStaleLog(s, { floor: 9, seq: 5 });

    const r = await sweep(s);

    await expect(s.get(key)).resolves.not.toBeNull();
    expect(r.dropped.stale_generation).toBe(1);
  });

  test("keeps reclaiming on a bucket whose manifest carries no generation", async () => {
    // Legacy compatibility, and the reason the field is optional on BOTH
    // sides rather than defaulted at the writer. Absent compares equal to
    // absent, so a collection predating `generation` entirely is not
    // fenced off from GC forever.
    const s = new MemoryStorage();
    const key = await seedDueStaleLog(s, {
      floor: 9,
      seq: 5,
      manifestGeneration: undefined,
    });
    // `logStateCurrentJson` always stamps a generation, so strip it to
    // build the pre-`generation` manifest shape this test is about.
    const cur = await readCurrentJson(s, KEY);
    const { generation: _dropped, ...withoutGeneration } = cur!.json;
    await s.put(KEY, encodeJsonBytes(withoutGeneration), { ifMatch: cur!.etag });

    const r = await sweep(s);

    await expect(s.get(key)).resolves.toBeNull();
    expect(r.swept).toBe(1);
    expect(r.dropped).toEqual({ stale_generation: 0, still_live: 0 });
  });

  test("drops a due stale-log candidate that the floor has made live again", async () => {
    // The second arm, independent of the first: same generation
    // throughout, but the floor has moved DOWN beneath the candidate.
    // Only `admin restore --force` writes that shape — its deliberate
    // floor exemption reseeds `log_seq_start` from the surviving log
    // objects. `log/5` was dead under a floor of 9; under a floor of 3 it
    // is a live entry readers walk.
    const s = new MemoryStorage();
    const key = await seedDueStaleLog(s, {
      floor: 3,
      seq: 5,
      candidateGeneration: LOG_STATE_GENERATION,
    });

    const r = await sweep(s);

    await expect(s.get(key)).resolves.not.toBeNull();
    expect(r.swept).toBe(0);
    expect(r.dropped).toEqual({ stale_generation: 0, still_live: 1 });
  });

  test("a drop advances neither last_swept_at nor db.gc.swept_total", async () => {
    // A drop frees no bytes. Folding it into the sweep counters would
    // make a pass that reclaimed nothing read as productive, and would
    // move a timestamp whose whole purpose is to say when bytes last came
    // back.
    const s = new MemoryStorage();
    await seedDueStaleLog(s, {
      floor: 9,
      seq: 5,
      manifestGeneration: OTHER_GENERATION,
      candidateGeneration: LOG_STATE_GENERATION,
    });

    const ctx = createObservabilityContext();
    await runWithContext(ctx, async () => sweep(s));

    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.last_swept_at).toBe("");
    const snap = ctx.recorder.snapshot();
    expect(snap.counters.find((c) => c.name === "db.gc.swept_total")).toBeUndefined();
    const dropped = snap.counters.filter((c) => c.name === "db.gc.dropped_total");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.value).toBe(1);
    expect(dropped[0]?.labels).toMatchObject({ cause: "stale-generation" });
  });

  test("stamps the marking manifest's generation onto every new candidate", async () => {
    // The other half of the fence: a candidate with no generation is
    // fenced against nothing on the next pass. Marks must carry it, or
    // the sweep arm above degenerates into the upgrade path forever.
    const s = new MemoryStorage();
    await createCurrentJson(s, KEY, logStateCurrentJson({ log_seq_start: 4, tail_hint: 4 }));
    for (let seq = 0; seq < 3; seq++) {
      await s.put(`${PREFIX}/log/${String(seq)}.json`, new TextEncoder().encode("{}"));
    }

    await runGc({ storage: s, currentJsonKey: KEY }, {
      // A grace far in the future, so everything marked stays pending
      // and this test reads marks rather than sweeps.
      graceMillis: 60 * 60 * 1000,
    } as InternalRunGcOptions);

    const pending = await readGcPending(s, PENDING_KEY);
    expect(pending?.json.candidates.length).toBeGreaterThan(0);
    for (const candidate of pending!.json.candidates) {
      expect(candidate.generation).toBe(LOG_STATE_GENERATION);
    }
  });
});
