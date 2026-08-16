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
  type StorageListEntry,
  GC_MAX_PENDING_CANDIDATES,
  GC_PENDING_CAS_MAX_ATTEMPTS,
  GC_PENDING_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  MemoryStorage,
  casUpdateCurrentJson,
  casUpdateGcPending,
  createCurrentJson,
  createGcPending,
  encodeJsonBytes,
  logObjectKey,
  readCurrentJson,
  readGcPending,
  snapshotHash,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { LOG_STATE_GENERATION, logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { seedLegacyContentForBody } from "../../../tests/fixtures/legacy-content.ts";
import { compact, type InternalCompactOptions } from "./compactor.ts";
import { type InternalRunGcOptions, runGc } from "./gc.ts";
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

describe("runGc", () => {
  test("returns zeros and bootstraps an empty pending.json on first run", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const r = await runGc({ storage: s, currentJsonKey: KEY });
    expect(r).toEqual({
      marked: { orphan_snapshot: 0 },
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
    expect(r.marked).toEqual({ orphan_snapshot: 0 });
    expect(r.swept).toBe(0);
    // Nothing was bootstrapped either — pending.json is absent.
    await expect(readGcPending(s, PENDING_KEY)).resolves.toBeNull();
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
    const newSnapshot = snapshotKey(PREFIX, 0, 0, "e".repeat(64));
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
        if (prefix !== `${PREFIX}/snapshot/L9/`) {
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

  test("evicts malformed and unknown-layout snapshot candidates without deleting objects", async () => {
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

    const { storage, trace } = tracingStorage(inner);
    const result = await runGc({ storage, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

    expect(result.swept).toBe(0);
    expect(trace.deletes).toEqual([]);
    await expect(inner.get(malformed)).resolves.not.toBeNull();
    await expect(inner.get(unknownLayout)).resolves.not.toBeNull();
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates).toEqual([]);
  });

  test("does not mark non-canonical snapshot objects", async () => {
    const inner = new MemoryStorage();
    await bootstrap(inner, KEY);
    const canonical = snapshotKey(PREFIX, 0, 1, "a".repeat(64));
    const malformed = `${PREFIX}/snapshot/L9/not-a-canonical-snapshot.json`;
    const unknownLayout = `${PREFIX}/snapshot/L8/000000000000-000000000001-${"b".repeat(64)}.json`;
    for (const key of [canonical, malformed, unknownLayout]) {
      await inner.put(key, new TextEncoder().encode("{}"));
    }

    const result = await runGc({ storage: inner, currentJsonKey: KEY });

    expect(result.marked.orphan_snapshot).toBe(1);
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates.map((candidate) => candidate.key)).toEqual([canonical]);
    for (const key of [canonical, malformed, unknownLayout]) {
      await expect(inner.get(key)).resolves.not.toBeNull();
    }
  });

  test("does not let an L8 window starve a canonical L9 orphan", async () => {
    const inner = new MemoryStorage();
    await bootstrap(inner, KEY);
    const maxMarksPerRun = 20;
    for (let index = 0; index < maxMarksPerRun; index++) {
      await inner.put(
        `${PREFIX}/snapshot/L8/${index.toString().padStart(12, "0")}.json`,
        new TextEncoder().encode("{}"),
      );
    }
    const canonical = snapshotKey(PREFIX, 0, 1, "c".repeat(64));
    await inner.put(canonical, new TextEncoder().encode("{}"));

    const result = await runGc({ storage: inner, currentJsonKey: KEY }, {
      maxMarksPerRun,
    } as InternalRunGcOptions);

    expect(result.marked.orphan_snapshot).toBe(1);
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates.map((candidate) => candidate.key)).toEqual([canonical]);
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

  const sweep = async (storage: Storage): ReturnType<typeof runGc> =>
    runGc({ storage, currentJsonKey: KEY }, {
      graceMillis: 0,
      maxSweepsPerRun: 10,
    } as InternalRunGcOptions);

  test("evicts legacy orphan-content candidates from the ledger without deleting the object", async () => {
    // A v0.6 bucket's ledger head can be entirely orphan-content, and this
    // build classifies none of it. Leaving those entries pending pins the head
    // forever: `mergeGcPending` keeps the FIRST GC_MAX_PENDING_CANDIDATES
    // entries, so it is not a slow leak but a total GC outage — every new
    // stale-log and orphan-snapshot mark gets discarded. Evict, never delete.
    const inner = new MemoryStorage();
    await createCurrentJson(inner, KEY, logStateCurrentJson({ log_seq_start: 1, tail_hint: 1 }));
    await inner.put(`${PREFIX}/log/0.json`, new TextEncoder().encode("{}"), {
      contentType: "application/json",
    });

    // Fill the ledger head to the cap with legacy content candidates and put
    // one real stale-log candidate BEHIND them: if eviction regresses, that
    // stale log is never reclaimed.
    const legacyKeys = Array.from(
      { length: GC_MAX_PENDING_CANDIDATES },
      (_, i) => `${PREFIX}/content/${i.toString(16).padStart(32, "0")}.json`,
    );
    for (const key of legacyKeys) {
      await inner.put(key, new TextEncoder().encode('{"_id":"legacy"}'), {
        contentType: "application/json",
      });
    }
    // The cast is what makes this a LEGACY ledger: `content_scan_cursor` is
    // not a `GcPending` field, so it can only reach the seeded JSON this way.
    // `assertGcPending` runs no excess-property check, so it still decodes.
    await createGcPending(inner, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        ...legacyKeys.map((key) => ({
          key,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "orphan-content" as const,
          generation: LOG_STATE_GENERATION,
        })),
        {
          key: `${PREFIX}/log/0.json`,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "stale-log" as const,
          generation: LOG_STATE_GENERATION,
        },
      ],
      last_swept_at: "",
      content_scan_cursor: `${PREFIX}/content/ffffffffffffffffffffffffffffffff.json`,
    } as GcPending);

    const result = await runGc({ storage: inner, currentJsonKey: KEY }, {
      graceMillis: 0,
    } as InternalRunGcOptions);

    // The ledger is empty: every legacy candidate evicted, the stale log swept.
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates).toEqual([]);

    // Eviction frees no bytes, so it drives NEITHER the swept count NOR the
    // `dropped` counters — only the real stale-log DELETE does.
    expect(result.swept).toBe(1);
    expect(result.dropped).toEqual({ stale_generation: 0, still_live: 0 });
    await expect(inner.get(`${PREFIX}/log/0.json`)).resolves.toBeNull();

    // Evicted from the ledger, but still on the bucket.
    for (const key of legacyKeys) {
      await expect(inner.get(key), `${key} must survive eviction`).resolves.not.toBeNull();
    }
  });

  test("never LISTs, GETs, or DELETEs anything under content/", async () => {
    const inner = new MemoryStorage();
    // A floor of 1 so the stale-log LIST actually runs — with
    // `log_seq_start === 0` that phase is skipped and the `trace.lists`
    // assertion below would not pin the log prefix.
    await createCurrentJson(inner, KEY, logStateCurrentJson({ log_seq_start: 1, tail_hint: 1 }));
    const legacy = await seedLegacyContentForBody(inner, PREFIX, { _id: "legacy", n: 1 });
    const { storage, trace } = tracingStorage(inner);

    await runGc({ storage, currentJsonKey: KEY }, { graceMillis: 0 } as InternalRunGcOptions);

    expect(trace.lists).toEqual([`${PREFIX}/snapshot/L9/`]);
    expect(trace.gets.filter((key) => key.includes("/content/"))).toEqual([]);
    expect(trace.deletes.filter((key) => key.includes("/content/"))).toEqual([]);
    await expect(inner.get(legacy)).resolves.not.toBeNull();
  });

  // Arm 1 — stale-log deletion authority. A persisted candidate authorizes
  // DELETE only when its key is the exact canonical `log/<seq>.json` for THIS
  // collection, and `parseSeqFromCanonicalLogKey` has three guards that can
  // refuse it. One row per guard, because they fail differently and a
  // regression in one is invisible from the others:
  //
  //   prefix         — `!key.startsWith(collectionPrefix + "/log/")`
  //   decimal regex  — `/^(\d+)\.json$/`
  //   canonical      — `Number.isSafeInteger` + `logObjectKey(...) === key`
  //
  // The last two matter most: those keys sit under this collection's OWN log
  // prefix, so the prefix guard waves them through and only the canonical
  // check stands between a foreign object and an unauthorized DELETE. The
  // floor is 9, so a dropped canonical check reads `007` as seq 7 — below the
  // floor — and sweeps it; it reads `10000000000000000` as above the floor and
  // rescues it (`still_live: 1`). Both diverge from eviction, which resolves
  // the candidate OUT of the ledger with no DELETE, no counter, and no
  // `last_swept_at` bump.
  test.each([
    {
      guard: "prefix",
      what: "a content object mislabeled stale-log",
      candidateKey: `${PREFIX}/content/00000000000000000000000000000000.json`,
    },
    {
      guard: "prefix",
      what: "a canonical stale-log key belonging to a different collection",
      candidateKey: "app/t/tenant/x/manifests/other/log/0.json",
    },
    {
      guard: "decimal regex",
      what: "a malformed log key under the collection log prefix",
      candidateKey: `${PREFIX}/log/notanumber.json`,
    },
    {
      guard: "canonical round-trip",
      what: "a leading-zero log key that parses as a below-floor seq",
      candidateKey: `${PREFIX}/log/007.json`,
    },
    {
      // Round-trips exactly (`String(1e16) === "10000000000000000"`) yet
      // exceeds `Number.MAX_SAFE_INTEGER`, so this is the only row the
      // `Number.isSafeInteger` term rejects on its own.
      guard: "safe-integer range",
      what: "a log key whose sequence is past the safe-integer range",
      candidateKey: `${PREFIX}/log/10000000000000000.json`,
    },
  ])("evicts $what ($guard) without deleting it", async ({ candidateKey }) => {
    const inner = new MemoryStorage();
    await createCurrentJson(inner, KEY, logStateCurrentJson({ log_seq_start: 9, tail_hint: 9 }));
    await inner.put(candidateKey, new TextEncoder().encode('{"_id":"legacy"}'));
    await createGcPending(inner, PENDING_KEY, {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [
        {
          key: candidateKey,
          due_at: "2000-01-01T00:00:00.000Z",
          reason: "stale-log",
          generation: LOG_STATE_GENERATION,
        },
      ],
      last_swept_at: "",
    });
    const { storage, trace } = tracingStorage(inner);
    const ctx = createObservabilityContext();

    const result = await runWithContext(ctx, async () => sweep(storage));

    await expect(inner.get(candidateKey)).resolves.not.toBeNull();
    expect(trace.deletes).not.toContain(candidateKey);
    expect(result.swept).toBe(0);
    expect(result.dropped).toEqual({ stale_generation: 0, still_live: 0 });
    const pending = await readGcPending(inner, PENDING_KEY);
    expect(pending?.json.candidates).toEqual([]);
    expect(pending?.json.last_swept_at).toBe("");
    const metrics = ctx.recorder.snapshot();
    expect(
      metrics.counters.find((counter) => counter.name === "db.gc.swept_total"),
    ).toBeUndefined();
    expect(
      metrics.counters.find((counter) => counter.name === "db.gc.dropped_total"),
    ).toBeUndefined();
  });

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
    // The stale-log upgrade path. A candidate written by an older build
    // carries no `generation`, and absent cannot be proven to match a
    // manifest that has one — so it is dropped on the first pass and, if
    // still stale, re-marked on the next with a fresh grace period.
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

  test("revalidation adds ZERO storage ops — a dropping pass costs a sweeping pass minus the DELETE", async () => {
    // The gate's cost argument, pinned. Every value it consults is already in
    // lexical scope — `current` and `logSeqStart` from step 1 — so it issues
    // no probe, no HEAD, and no extra LIST. Nothing else in the suite counts
    // operations, so without this test that claim rests on inspection alone.
    //
    // Two arms, byte-identical but for the candidate's `generation`, so
    // any difference in the op trace IS revalidation cost. Both halves
    // matter: comparing the arms catches an op added on the drop path,
    // and pinning the absolute trace catches one added to BOTH paths,
    // which a comparison alone would let through.
    const traceFor = async (candidateGeneration: string): Promise<StorageTrace> => {
      const inner = new MemoryStorage();
      // Seed on the raw storage so fixture writes are not traced.
      await seedDueStaleLog(inner, { floor: 9, seq: 5, candidateGeneration });
      const { storage, trace } = tracingStorage(inner);
      await runGc({ storage, currentJsonKey: KEY }, {
        graceMillis: 0,
        maxSweepsPerRun: 10,
      } as InternalRunGcOptions);
      return trace;
    };

    const swept = await traceFor(LOG_STATE_GENERATION);
    const dropped = await traceFor(OTHER_GENERATION);

    // Identical reads, writes and listings — the whole difference is the
    // DELETE the fenced pass correctly declined to issue.
    expect(dropped.gets).toEqual(swept.gets);
    expect(dropped.puts).toEqual(swept.puts);
    expect(dropped.lists).toEqual(swept.lists);
    expect(swept.deletes).toEqual([`${PREFIX}/log/5.json`]);
    expect(dropped.deletes).toEqual([]);

    // The absolute shape, so an op added to both arms cannot hide behind
    // the equality above. Keys rather than counts: a changed op is then
    // legible in the diff instead of arriving as an off-by-one.
    expect(swept.gets).toEqual([KEY, PENDING_KEY, PENDING_KEY]);
    expect(swept.lists).toEqual([`${PREFIX}/snapshot/L9/`]);
    expect(swept.puts.map((p) => p.key)).toEqual([PENDING_KEY]);
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

  test("does not mark stale log entries below the floor", async () => {
    const storage = new MemoryStorage();
    const prefix = "app/a/tenant/t/manifests/c";
    await createCurrentJson(
      storage,
      `${prefix}/current.json`,
      logStateCurrentJson({
        log_seq_start: 100,
        tail_hint: 100,
        writer_fence: { epoch: 0, owner: "gc-test", claimed_at: "" },
      }),
    );
    for (const seq of [0, 1, 2, 50, 99]) {
      await storage.put(logObjectKey(prefix, seq), encodeJsonBytes({ seq }), {
        ifNoneMatch: "*",
      });
    }

    const result = await runGc({ storage, currentJsonKey: `${prefix}/current.json` }, {
      graceMillis: 0,
    } as InternalRunGcOptions);

    expect(result.marked).not.toHaveProperty("stale_log");
    for (const seq of [0, 1, 2, 50, 99]) {
      await expect(storage.get(logObjectKey(prefix, seq))).resolves.not.toBeNull();
    }
  });
});
