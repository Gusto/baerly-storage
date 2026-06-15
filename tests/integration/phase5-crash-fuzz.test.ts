/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol`'s `Collection<T>`
   declaration); the reader helper threads it through. */

/**
 * Crash-injection fuzzer.
 *
 * Property-based fault-injection that drives `Writer`,
 * `compact()`, and `runGc()` against a `Storage` proxy that aborts the
 * K-th underlying operation. Asserts the durability contracts:
 *
 *   1. A crashed writer leaves no readable phantom row (the would-be
 *      insert is either fully landed or fully absent).
 *   2. A crashed compactor leaves no readable corrupt snapshot (the
 *      reader's row set is identical pre- and post-crash).
 *   3. A crashed GC sweep never deletes a still-referenced key (the
 *      reader's row set is identical pre- and post-crash).
 *   4. A long-running mixed loop of writes / compaction / GC with
 *      random aborts converges to a reader view matching the exact
 *      set of successfully-committed `_id`s.
 *   5. (write-tick fold) For every K, aborting the K-th op across a
 *      fold (snapshot PUT → `current.json` CAS) then running `runGc`
 *      never deletes content referenced by the committed snapshot:
 *      every row still reads, and every content key the committed
 *      snapshot's rows hash to survives the sweep.
 *   6. (lost-fold contention) A fold whose CAS loses to a concurrent
 *      write leaves an orphan snapshot; after `runGc` drains past the
 *      grace window no orphan snapshot is left unreferenced, and the
 *      committed snapshot's content survives.
 *
 * Runs under default `FC_NUM_RUNS=100` on `pnpm test`. The cranked
 * variant `pnpm test:fuzz-phase5` (`FC_NUM_RUNS=10000`) is the
 * intended thorough sweep.
 *
 * Test-only. The control-flow-level kill points complement
 * `tests/integration/randomized.test.ts`'s transport-level
 * Toxiproxy-driven cascade.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fc, test as propTest } from "@fast-check/vitest";
import { afterEach, describe, expect, test } from "vitest";
import {
  BaerlyError,
  type Collection,
  createCurrentJson,
  decodeJsonBytes,
  type DocumentData,
  encodeJsonBytes,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  versionFromContent,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Db } from "@baerly/server";
import { compact, runGc } from "@baerly/server/maintenance";
import {
  type InternalCompactOptions,
  type InternalRunGcOptions,
  Writer,
} from "@baerly/server/_internal/testing";
import { abortingStorage } from "../fixtures/aborting-storage.ts";
import { logStateCurrentJson } from "../fixtures/log-state.ts";

/**
 * Per-property timeout, in ms. At `FC_NUM_RUNS=100` (default
 * `pnpm test`) each property finishes in <1s; at `FC_NUM_RUNS=10000`
 * (`pnpm test:fuzz-phase5`) each property runs multiple minutes.
 * Pick a value that comfortably accommodates 10k iterations on a
 * modern laptop.
 */
const PROP_TIMEOUT_MS = 600_000;

const TABLE_PREFIX = "app/a/tenant/t/manifests/c";
const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;
const COLLECTION = "c";

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(
    storage,
    CURRENT_JSON_KEY,
    logStateCurrentJson({ writer_fence: { epoch: 0, owner: "phase5-fuzz", claimed_at: "" } }),
  );
};

interface Row extends DocumentData {
  _id: string;
}

/**
 * Read every row in the collection through the locked collection API,
 * sorted by `_id` for stable equality. The reader walks
 * `(snapshot, log_tail)` exactly the same way production does, so the
 * post-crash invariants are checked against the customer-visible
 * surface.
 */
const readAllRowIds = async (storage: Storage): Promise<string[]> => {
  const db = Db.create({ storage, app: "a", tenant: "t" });
  const rows = await (db.collection(COLLECTION) as Collection<Row>).where({}).all();
  return [...rows]
    .map((r) => r._id)
    .toSorted((a, b) => {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    });
};

/** Collect every key under `prefix` into a sorted array. */
const listKeys = async (storage: Storage, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  for await (const entry of storage.list(prefix)) {
    keys.push(entry.key);
  }
  return keys.toSorted();
};

/**
 * The content keys the COMMITTED snapshot's rows reference. Reads
 * `current.json`, then (if a snapshot is committed) the snapshot body,
 * and hashes every row `body` with the exact `versionFromContent` the
 * writer used to mint the content key. Returns the set of
 * `<collectionPrefix>/content/<hash>.json` keys that GC must never
 * delete. Empty when no snapshot is committed yet.
 *
 * Deliberately re-derives the keys from the customer-visible snapshot
 * body rather than trusting GC's own `collectLiveContentHashes`, so the
 * assertion is independent of the code under test.
 */
const committedSnapshotContentKeys = async (storage: Storage): Promise<Set<string>> => {
  const collectionPrefix = TABLE_PREFIX;
  const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
  if (read === null || read.json.snapshot === null) {
    return new Set<string>();
  }
  const got = await storage.get(read.json.snapshot);
  if (got === null) {
    return new Set<string>();
  }
  const body = decodeJsonBytes<{ docs?: ReadonlyArray<{ body?: unknown }> }>(got.body);
  const keys = new Set<string>();
  for (const doc of body.docs ?? []) {
    if (doc.body === undefined) {
      continue;
    }
    const version = await versionFromContent(encodeJsonBytes(doc.body));
    keys.add(`${collectionPrefix}/content/${version}.json`);
  }
  return keys;
};

describe("abortingStorage harness sanity", () => {
  test("armAt(K) fires AbortError on the K-th underlying op", async () => {
    const inner = new MemoryStorage();
    const handle = abortingStorage(inner);
    // op 1 = put, op 2 = get; arm op 2 — first put must succeed,
    // first get must throw.
    handle.armAt(2);
    await handle.storage.put("k", new TextEncoder().encode("v"));
    expect(handle.opCount()).toBe(1);
    await expect(handle.storage.get("k")).rejects.toMatchObject({ name: "AbortError" });
    // Trap resets after firing — the next op succeeds.
    expect(handle.opCount()).toBe(2);
    const got = await handle.storage.get("k");
    expect(got).not.toBeNull();
  });
});

describe("Writer crash never leaves readable phantom row", () => {
  propTest.prop({
    abortAfter: fc.integer({ min: 1, max: 8 }),
    numInsertsBefore: fc.integer({ min: 0, max: 30 }),
    docId: fc.string({ minLength: 1, maxLength: 8 }),
  })(
    "Db.commit() with mid-op abort: insert is fully absent OR fully landed",
    async ({ abortAfter, numInsertsBefore, docId }) => {
      const inner = new MemoryStorage();
      await provision(inner);

      // Seed with `numInsertsBefore` good writes so the log isn't
      // empty when the crash fires.
      const goodWriter = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      const seededIds = new Set<string>();
      for (let i = 0; i < numInsertsBefore; i++) {
        const id = `seed-${i}`;
        await goodWriter.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, kind: "seed" },
        });
        seededIds.add(id);
      }
      // The probe `_id` must not collide with a seed — drop it if it does.
      const probeIsSeed = seededIds.has(docId);

      // Wrap + arm. The trap fires before the K-th underlying I/O on
      // `inner`. Counter starts at 0; the very next op is op 1.
      const handle = abortingStorage(inner);
      const crashWriter = new Writer({
        storage: handle.storage,
        currentJsonKey: CURRENT_JSON_KEY,
      });
      handle.armAt(abortAfter);

      let postCrashCommitted = false;
      try {
        await crashWriter.commit({
          op: "I",
          collection: COLLECTION,
          docId,
          body: { _id: docId, kind: "post-crash" },
        });
        postCrashCommitted = true;
      } catch {
        // Expected — we injected an abort, OR `MemoryStorage` raised
        // a CAS `Conflict`. The post-state invariant is the gate.
      }

      // INVARIANT: a fresh reader sees a consistent view.
      const ids = await readAllRowIds(inner);
      // Every seed must still be reachable.
      for (const seed of seededIds) {
        expect(ids).toContain(seed);
      }
      // The post-crash probe is EITHER absent (most cases — the abort
      // fired before the CAS-advance) OR present (rare: the API
      // surfaced an abort *after* the CAS-advance landed, which is
      // fine — that's "the commit landed even though the API threw").
      const probePresent = ids.includes(docId);
      if (postCrashCommitted) {
        // If the writer didn't throw, the row MUST be reachable.
        expect(probePresent).toBe(true);
      } else if (probeIsSeed) {
        // It was already a seed — must be present regardless.
        expect(probePresent).toBe(true);
      }
      // The only forbidden state is a partial / corrupt row, which
      // the reader contract makes unrepresentable: rows come from
      // `LogEntry.after` whole, never split.
    },
    PROP_TIMEOUT_MS,
  );
});

describe("Compactor crash never leaves readable corrupt snapshot", () => {
  propTest.prop({
    abortAfter: fc.integer({ min: 1, max: 50 }),
    numInserts: fc.integer({ min: 20, max: 60 }),
  })(
    "compact() with mid-op abort: reader returns the same set pre- and post-crash",
    async ({ abortAfter, numInserts }) => {
      const inner = new MemoryStorage();
      await provision(inner);
      const writer = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < numInserts; i++) {
        const id = `d-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }

      const before = await readAllRowIds(inner);

      // Run a compaction with an abort armed at op K.
      const handle = abortingStorage(inner);
      handle.armAt(abortAfter);
      try {
        await compact({ storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY }, {
          minEntriesToCompact: 10,
          maxEntriesPerRun: numInserts,
        } as InternalCompactOptions);
      } catch {
        // Expected — abort or `Conflict`. Either way, the bucket must
        // still surface the original row set to a fresh reader.
      }

      const after = await readAllRowIds(inner);
      expect(after).toEqual(before);
    },
    PROP_TIMEOUT_MS,
  );
});

describe("GC crash never deletes a still-referenced key", () => {
  propTest.prop({
    abortAfter: fc.integer({ min: 1, max: 30 }),
    numInserts: fc.integer({ min: 20, max: 60 }),
  })(
    "runGc() with mid-op abort: reader still returns all live rows",
    async ({ abortAfter, numInserts }) => {
      const inner = new MemoryStorage();
      await provision(inner);
      const writer = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < numInserts; i++) {
        const id = `d-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }
      // Fold the log so there's a snapshot + stale-log surface for GC
      // to mark as candidates.
      await compact({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
        minEntriesToCompact: 10,
        maxEntriesPerRun: numInserts,
      } as InternalCompactOptions);
      const before = await readAllRowIds(inner);

      const handle = abortingStorage(inner);
      handle.armAt(abortAfter);
      try {
        await runGc({ storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY }, {
          graceMillis: 0,
          maxSweepsPerRun: 200,
        } as InternalRunGcOptions);
      } catch {
        // Expected — abort or `Conflict`. The reader contract is the
        // gate.
      }

      const after = await readAllRowIds(inner);
      expect(after).toEqual(before);
    },
    PROP_TIMEOUT_MS,
  );
});

describe("Write-tick fold crash never deletes committed-snapshot content", () => {
  propTest.prop({
    abortAfter: fc.integer({ min: 1, max: 60 }),
    numInserts: fc.integer({ min: 20, max: 60 }),
  })(
    "abort the K-th op across the fold, then runGc: live rows survive AND committed-snapshot content is never deleted",
    async ({ abortAfter, numInserts }) => {
      const inner = new MemoryStorage();
      await provision(inner);
      const writer = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < numInserts; i++) {
        const id = `d-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }
      const before = await readAllRowIds(inner);

      // Run a fold (snapshot PUT → current.json CAS) with an abort
      // armed at the K-th underlying op. The fold may land fully,
      // abort mid-snapshot-PUT, or abort before the CAS — every
      // outcome is acceptable input to the GC step below.
      const foldHandle = abortingStorage(inner);
      foldHandle.armAt(abortAfter);
      try {
        await compact({ storage: foldHandle.storage, currentJsonKey: CURRENT_JSON_KEY }, {
          minEntriesToCompact: 10,
          maxEntriesPerRun: numInserts,
        } as InternalCompactOptions);
      } catch {
        // Expected — injected abort or CAS Conflict. The post-state is
        // the gate.
      }

      // Capture the content keys the COMMITTED snapshot references
      // BEFORE GC runs — these must survive the sweep.
      const protectedKeys = await committedSnapshotContentKeys(inner);

      // Drain GC with the grace bypassed so any due candidate is swept
      // in-pass. Several passes exercise the content-scan-cursor
      // rotation under a tight per-pass mark cap (8 marks × 5 passes
      // need not reach numInserts at the high end — full keyspace
      // coverage isn't guaranteed every run). Under-marking is
      // conservative-safe: it can never wrongly sweep a protected key,
      // so the invariant below still holds regardless of how far the
      // cursor advances.
      for (let pass = 0; pass < 5; pass++) {
        await runGc({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
          graceMillis: 0,
          maxMarksPerRun: 8,
          maxSweepsPerRun: 200,
        } as InternalRunGcOptions);
      }

      // INVARIANT A: the reader view is unchanged — no live row lost.
      const after = await readAllRowIds(inner);
      expect(after).toEqual(before);

      // INVARIANT B: every content key the committed snapshot
      // references is still on the bucket. This is the property a
      // GC that ignored the committed snapshot's references would
      // violate.
      const contentKeysAfter = new Set(await listKeys(inner, `${TABLE_PREFIX}/content/`));
      for (const key of protectedKeys) {
        expect(contentKeysAfter.has(key)).toBe(true);
      }
    },
    PROP_TIMEOUT_MS,
  );
});

describe("Lost-fold orphan snapshot reclaimed under contention", () => {
  propTest.prop({
    numInserts: fc.integer({ min: 20, max: 50 }),
  })(
    "a fold that loses its CAS to a concurrent write leaves an orphan snapshot that runGc reclaims past grace; committed content survives",
    async ({ numInserts }) => {
      const inner = new MemoryStorage();
      await provision(inner);
      const writer = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < numInserts; i++) {
        const id = `d-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }
      // First clean fold so there's a committed snapshot to protect and
      // a prior pointer for the lost fold to be measured against.
      await compact({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
        minEntriesToCompact: 5,
        maxEntriesPerRun: numInserts,
      } as InternalCompactOptions);
      // More writes so the next fold has a non-empty tail to fold.
      for (let i = 0; i < numInserts; i++) {
        const id = `e-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }

      // Force a fold CAS-loss: run a fold over a Storage whose `put` to
      // current.json is intercepted so that a concurrent write lands
      // FIRST — invalidating the fold's captured ETag. The fold then
      // PUTs its snapshot (orphan) and loses the CAS-advance.
      let interleaved = false;
      const racingStorage: Storage = {
        get: (k, o) => inner.get(k, o),
        delete: (k, o) => inner.delete(k, o),
        list: (p, o) => inner.list(p, o),
        async put(k, b, o) {
          // The fold's CAS-advance is a guarded PUT to current.json
          // (`ifMatch` set). Just before it lands, slip a concurrent
          // committed write in so the captured ETag is now stale.
          if (k === CURRENT_JSON_KEY && o?.ifMatch !== undefined && !interleaved) {
            interleaved = true;
            await writer.commit({
              op: "I",
              collection: COLLECTION,
              docId: "racer",
              body: { _id: "racer", kind: "racer" },
            });
          }
          return inner.put(k, b, o);
        },
      };
      const lostFold = await compact({ storage: racingStorage, currentJsonKey: CURRENT_JSON_KEY }, {
        minEntriesToCompact: 5,
        maxEntriesPerRun: numInserts,
      } as InternalCompactOptions);
      // The fold must have lost the CAS and written an orphan snapshot.
      expect(lostFold.written).toBe(false);
      expect(lostFold.skippedReason).toBe("cas-lost");
      expect(lostFold.newSnapshotKey).toBeDefined();

      // Two distinct snapshot files exist now: the committed one and
      // the orphan the lost fold left behind.
      const snapshotsBefore = await listKeys(inner, `${TABLE_PREFIX}/snapshot/`);
      expect(snapshotsBefore.length).toBeGreaterThanOrEqual(2);

      const before = await readAllRowIds(inner);
      const protectedKeys = await committedSnapshotContentKeys(inner);
      const committedSnapshotKey = (await readCurrentJson(inner, CURRENT_JSON_KEY))!.json.snapshot;

      // Drain GC PAST the grace window (now advanced well beyond every
      // candidate's due_at). Several passes to clear marks then sweeps.
      const future = (): Date => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      for (let pass = 0; pass < 6; pass++) {
        await runGc({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
          graceMillis: 0,
          now: future,
          maxMarksPerRun: 200,
          maxSweepsPerRun: 200,
        } as InternalRunGcOptions);
      }

      // INVARIANT A: reader view unchanged (the racer write also lands,
      // so recompute the expectation from `before`).
      const after = await readAllRowIds(inner);
      expect(after).toEqual(before);

      // INVARIANT B: no orphan snapshot left — the ONLY snapshot key
      // remaining is the committed one.
      const snapshotsAfter = await listKeys(inner, `${TABLE_PREFIX}/snapshot/`);
      expect(snapshotsAfter).toEqual([committedSnapshotKey]);

      // INVARIANT C: the committed snapshot's content survives.
      const contentKeysAfter = new Set(await listKeys(inner, `${TABLE_PREFIX}/content/`));
      for (const key of protectedKeys) {
        expect(contentKeysAfter.has(key)).toBe(true);
      }
    },
    PROP_TIMEOUT_MS,
  );
});

describe("Long-running fuzzer (many tick + crash cycles)", () => {
  test(
    "converges to a consistent reader view after up to 200 ops with random aborts",
    { timeout: PROP_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.oneof(
              fc.record({
                kind: fc.constant("write" as const),
                id: fc.string({ minLength: 1, maxLength: 6 }),
              }),
              fc.record({
                kind: fc.constant("compact" as const),
                abortAfter: fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
              }),
              fc.record({
                kind: fc.constant("gc" as const),
                abortAfter: fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
              }),
            ),
            { minLength: 50, maxLength: 200 },
          ),
          async (ops) => {
            const inner = new MemoryStorage();
            await provision(inner);
            const writer = new Writer({
              storage: inner,
              currentJsonKey: CURRENT_JSON_KEY,
            });
            const expectedIds = new Set<string>();
            for (const op of ops) {
              try {
                switch (op.kind) {
                  case "write": {
                    await writer.commit({
                      op: "I",
                      collection: COLLECTION,
                      docId: op.id,
                      body: { _id: op.id, kind: "live" },
                    });
                    expectedIds.add(op.id);
                    break;
                  }
                  case "compact": {
                    if (op.abortAfter === undefined) {
                      await compact({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
                        minEntriesToCompact: 5,
                        maxEntriesPerRun: 200,
                      } as InternalCompactOptions);
                    } else {
                      const handle = abortingStorage(inner);
                      handle.armAt(op.abortAfter);
                      await compact({ storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY }, {
                        minEntriesToCompact: 5,
                        maxEntriesPerRun: 200,
                      } as InternalCompactOptions);
                    }
                    break;
                  }
                  case "gc": {
                    if (op.abortAfter === undefined) {
                      await runGc({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
                        graceMillis: 0,
                        maxSweepsPerRun: 200,
                      } as InternalRunGcOptions);
                    } else {
                      const handle = abortingStorage(inner);
                      handle.armAt(op.abortAfter);
                      await runGc({ storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY }, {
                        graceMillis: 0,
                        maxSweepsPerRun: 200,
                      } as InternalRunGcOptions);
                    }
                    break;
                  }
                }
              } catch {
                // Aborts and `Conflict`s are expected; the post-loop
                // reader view is the only gate.
              }
            }
            // Post-loop INVARIANT: every successful write is
            // reachable; no phantom rows.
            const ids = new Set(await readAllRowIds(inner));
            expect(ids).toEqual(expectedIds);
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});

// ─────────────────────────────────────────────────────────────────────
// ticket-01 bug reproductions (characterization tests)
// ─────────────────────────────────────────────────────────────────────

/**
 * Two storage variants for the ticket-01 characterization tests:
 * `memory` (zero infra) and `local-fs` (real I/O over a temp dir).
 * Mirrors the variant table in `phase5-end-to-end.test.ts`; the
 * Minio / Cloudflare variants are intentionally excluded so these
 * stay in the default zero-infra `pnpm test` glob.
 */
interface BugVariant {
  readonly label: "memory" | "local-fs";
  readonly build: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

const BUG_VARIANTS: readonly BugVariant[] = [
  {
    label: "memory",
    build: async () => ({ storage: new MemoryStorage() }),
  },
  {
    label: "local-fs",
    build: async () => {
      const root = await mkdtemp(join(tmpdir(), "baerly-ticket01-"));
      return {
        storage: new LocalFsStorage({ root }),
        cleanup: async () => {
          await rm(root, { recursive: true, force: true }).catch(() => {
            // A stale tmp dir under a crashed worker shouldn't fail the
            // suite; the OS reaps `/tmp` eventually.
          });
        },
      };
    },
  },
];

/** Collect every log-entry seq durably present under `<prefix>/log/`. */
const durableLogSeqs = async (storage: Storage, tablePrefix: string): Promise<number[]> => {
  const seqs: number[] = [];
  for await (const entry of storage.list(`${tablePrefix}/log/`)) {
    const match = /\/log\/(\d+)\.json$/.exec(entry.key);
    if (match !== null) {
      seqs.push(Number(match[1]));
    }
  }
  return seqs.toSorted((a, b) => a - b);
};

describe("ticket-01 bug reproductions (characterization — assert CURRENT buggy behavior)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      await c();
    }
  });

  for (const variant of BUG_VARIANTS) {
    /**
     * ── BUG 1: single-entry orphan wedge (permanent, all writers). ──
     *
     * WHAT THIS DOCUMENTS:
     * `Writer.commit()` writes content → log entry → CAS-advance of
     * `current.json` as three separate storage ops. A single-input
     * commit that crashes AFTER its `log/<seq>.json` PUT but BEFORE the
     * `current.json` CAS leaves a DURABLE ORPHAN log object at
     * `seq == current.next_seq`. The next writer reads the same
     * `next_seq`, mints the same seq, PUTs `log/<seq>.json` with
     * `ifNoneMatch:"*"` → 412, reads the orphan, and
     * `tryAdoptOwnSessionLogEntry` refuses it ("foreign-session" — the
     * orphan carries a different `session`). The writer throws
     * `Conflict`, retries up to `maxRetries`, hits the same orphan every
     * time, and throws `Conflict`. GC only sweeps
     * `seq < log_seq_start ≤ next_seq`, so the orphan AT `next_seq` is
     * never swept and `next_seq` never advances. The collection WEDGES
     * PERMANENTLY for every writer.
     *
     * This test asserts the CURRENT, BUGGY behavior: the fresh commit
     * ultimately throws `Conflict`, the orphan sits at `next_seq`, and
     * `next_seq` does not advance past it.
     *
     * ┌─────────────────────────────────────────────────────────────┐
     * │ A future recovery ticket may invert this: the marked          │
     * │ assertions below ("documents the wedge") would flip to assert │
     * │ that the fresh commit SUCCEEDS, the wedge clears, `next_seq`   │
     * │ advances, and the probe row is readable. The recovery design  │
     * │ is unresolved; this characterizes the wedge until then.       │
     * └─────────────────────────────────────────────────────────────┘
     */
    test(`[${variant.label}] BUG 1: single-entry orphan at next_seq wedges every future writer`, async () => {
      const { storage, cleanup } = await variant.build();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }

      const tablePrefix = TABLE_PREFIX;
      const currentJsonKey = CURRENT_JSON_KEY;
      await provision(storage);

      // 1) One clean single-input commit lands at seq 0 (next_seq → 1).
      const goodWriter = new Writer({ storage, currentJsonKey });
      await goodWriter.commit({
        op: "I",
        collection: COLLECTION,
        docId: "first",
        body: { _id: "first", kind: "good" },
      });
      const afterGood = await readCurrentJson(storage, currentJsonKey);
      expect(afterGood!.json.next_seq).toBe(1);

      // 2) Drive a single-input commit that crashes right AFTER its
      //    `log/1.json` PUT lands but BEFORE the `current.json` CAS.
      //    For a single insert with no indexes the op order on `inner`
      //    is: op1 GET current.json, op2 PUT content, op3 PUT log/1.json,
      //    op4 CAS PUT current.json. Arming at op4 fires the abort just
      //    before the CAS — leaving log/1.json durable as an orphan with
      //    next_seq still pinned at 1.
      const handle = abortingStorage(storage);
      const crashWriter = new Writer({ storage: handle.storage, currentJsonKey });
      handle.armAt(4);
      await expect(
        crashWriter.commit({
          op: "I",
          collection: COLLECTION,
          docId: "orphan-doc",
          body: { _id: "orphan-doc", kind: "orphan" },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      // Precondition for the wedge: the orphan log object IS durable at
      // seq 1, and `current.json.next_seq` did NOT advance past it.
      const seqsAfterCrash = await durableLogSeqs(storage, tablePrefix);
      expect(seqsAfterCrash).toContain(1);
      const afterCrash = await readCurrentJson(storage, currentJsonKey);
      expect(afterCrash!.json.next_seq).toBe(1);
      // The orphan at seq 1 sits AT next_seq, above log_seq_start, so GC
      // (which only sweeps seq < log_seq_start ≤ next_seq) can never
      // reach it.
      expect(afterCrash!.json.log_seq_start).toBeLessThanOrEqual(1);

      // 3) A fresh writer (new session) attempts a normal commit. It
      //    re-reads next_seq == 1, mints seq 1, collides with the orphan
      //    on the log PUT, refuses adoption ("foreign-session"), and
      //    retries to exhaustion. Use a tiny maxRetries + zero backoff so
      //    the test is fast AND deterministic (no real concurrency).
      const freshWriter = new Writer({
        storage,
        currentJsonKey,
        options: { maxRetries: 3, initialBackoffMs: 0, random: () => 0 },
      });

      // ░░░ A future recovery ticket may invert this assertion ░░░
      // CURRENT (buggy): the fresh commit throws Conflict — the orphan
      // wedges the collection permanently.
      // AFTER recovery (design unresolved): this would assert that the
      // commit RESOLVES — the writer clears the wedge and advances
      // next_seq.
      let caught: unknown;
      try {
        await freshWriter.commit({
          op: "I",
          collection: COLLECTION,
          docId: "wedge-probe",
          body: { _id: "wedge-probe", kind: "probe" },
        });
      } catch (error) {
        caught = error;
      }
      // Assert on the caught error directly so a wrong-code regression
      // (e.g. `Internal` instead of `Conflict`) fails loudly with the
      // actual code rather than "expected false to be true".
      expect(caught).toBeInstanceOf(BaerlyError);
      expect(caught).toMatchObject({ code: "Conflict" }); // ← INVERT: assert the commit succeeds.

      // ░░░ A future recovery ticket may invert these too ░░░
      // CURRENT (buggy): next_seq is still pinned at 1 (the wedge never
      // lets any writer advance it). AFTER recovery: next_seq advances
      // past the cleared wedge.
      const afterWedge = await readCurrentJson(storage, currentJsonKey);
      expect(afterWedge!.json.next_seq).toBe(1); // ← INVERT: expect advance past 1.

      // CURRENT (buggy): the wedge-probe row is NOT readable (its commit
      // never landed). AFTER recovery: the probe row reads back.
      const ids = await readAllRowIds(storage);
      expect(ids).not.toContain("wedge-probe"); // ← INVERT: expect to contain it.
      // The original good row is still readable regardless (folds from
      // log seq 0, below the orphan).
      expect(ids).toContain("first");
    });
  }
});
