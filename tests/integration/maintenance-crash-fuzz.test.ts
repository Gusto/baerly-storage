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
 * variant `pnpm test:fuzz-maintenance` (`FC_NUM_RUNS=10000`) is the
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
 * (`pnpm test:fuzz-maintenance`) each property runs multiple minutes.
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
    logStateCurrentJson({ writer_fence: { epoch: 0, owner: "maintenance-fuzz", claimed_at: "" } }),
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
      // current.json is intercepted so that a concurrent CAS-advance
      // lands FIRST — invalidating the fold's captured ETag. The fold
      // then PUTs its snapshot (orphan) and loses the CAS-advance.
      //
      // Under single-write commit the writer no longer touches
      // current.json, so the racing CAS-advance is now a CONCURRENT FOLD
      // (the compactor is the sole current.json CAS-writer besides
      // bootstrap). The racing fold runs over the plain `inner` storage
      // (not `racingStorage`) so it doesn't re-enter the interceptor.
      let interleaved = false;
      const racingStorage: Storage = {
        get: (k, o) => inner.get(k, o),
        delete: (k, o) => inner.delete(k, o),
        list: (p, o) => inner.list(p, o),
        async put(k, b, o) {
          // The fold's CAS-advance is a guarded PUT to current.json
          // (`ifMatch` set). Just before it lands, slip a concurrent fold
          // in so the captured ETag is now stale.
          if (k === CURRENT_JSON_KEY && o?.ifMatch !== undefined && !interleaved) {
            interleaved = true;
            await compact({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
              minEntriesToCompact: 5,
              maxEntriesPerRun: numInserts,
            } as InternalCompactOptions);
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
 * Mirrors the variant table in `maintenance-e2e.test.ts`; the
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

describe("single-write commit — win-or-lose-cleanly", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      await c();
    }
  });

  for (const variant of BUG_VARIANTS) {
    /**
     * ── Arm 1: the orphan-at-tail is now a COMMITTED write. ─────────
     *
     * Under single-write commit, the numbered `log/<seq>` create IS the
     * commit. A writer that crashed right after its `log/<seq>` PUT
     * landed a DURABLE, committed entry — no `current.json` CAS follows
     * it. The next writer reads the same (stale) `tail_hint`, forward-
     * probes, finds `log/<seq>` occupied by a FOREIGN session, probes
     * `seq+1`, and commits there with NO throw. The formerly "orphaned"
     * row is now part of the durable history.
     */
    test(`[${variant.label}] orphan-at-tail is a committed write; next writer probes forward and commits`, async () => {
      const { storage, cleanup } = await variant.build();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }

      const tablePrefix = TABLE_PREFIX;
      const currentJsonKey = CURRENT_JSON_KEY;
      await provision(storage);

      // 1) One clean single-input commit lands at seq 0.
      const goodWriter = new Writer({ storage, currentJsonKey });
      await goodWriter.commit({
        op: "I",
        collection: COLLECTION,
        docId: "first",
        body: { _id: "first", kind: "good" },
      });

      // 2) A FOREIGN writer commits a durable entry at seq 1 but its
      //    `current.json` is never touched (single-write commit: the
      //    numbered create IS the commit). Model it directly: PUT a
      //    foreign-session log entry at seq 1 via `If-None-Match: "*"`.
      //    Under the OLD two-write protocol this was an "orphan that
      //    wedges every future writer"; under single-write commit it is a
      //    committed write that the next writer probes past.
      const orphanEntry = {
        lsn: "00000000000000_FOREIGN_zzzzzzzzzz",
        commit_ts: new Date().toISOString(),
        op: "I",
        collection: COLLECTION,
        doc_id: "orphan-doc",
        session: "FOREIGN0",
        seq: 1,
        after: { _id: "orphan-doc", kind: "orphan" },
      };
      const orphanBytes = encodeJsonBytes(orphanEntry.after);
      const orphanVersion = await versionFromContent(orphanBytes);
      await storage.put(`${tablePrefix}/content/${orphanVersion}.json`, orphanBytes, {
        ifNoneMatch: "*",
        contentType: "application/json",
      });
      await storage.put(`${tablePrefix}/log/1.json`, encodeJsonBytes(orphanEntry), {
        ifNoneMatch: "*",
        contentType: "application/json",
      });

      // The committed entry IS durable at seq 1.
      const seqsAfterCrash = await durableLogSeqs(storage, tablePrefix);
      expect(seqsAfterCrash).toContain(1);

      // 3) A fresh writer (new session) commits. It reads the same stale
      //    tail_hint, probes, finds log/1 occupied by a FOREIGN session,
      //    probes seq 2, and commits there with NO throw.
      const freshWriter = new Writer({
        storage,
        currentJsonKey,
        options: { maxRetries: 3, initialBackoffMs: 0, random: () => 0 },
      });
      await freshWriter.commit({
        op: "I",
        collection: COLLECTION,
        docId: "wedge-probe",
        body: { _id: "wedge-probe", kind: "probe" },
      });

      // The discovered tail advanced: log/2 now exists (no hole).
      const seqsAfterProbe = await durableLogSeqs(storage, tablePrefix);
      expect(seqsAfterProbe).toContain(2);
      expect(seqsAfterProbe).toEqual([0, 1, 2]);

      // A full read sees BOTH the orphan-since-committed row AND the probe.
      const ids = await readAllRowIds(storage);
      expect(ids).toContain("orphan-doc");
      expect(ids).toContain("wedge-probe");
      expect(ids).toContain("first");
    });

    /**
     * ── Arm 2: two writers race log/N; exactly one wins, loser probes. ─
     *
     * Plan-A exactly-one-winner: both writers see `tail_hint=N` and both
     * `If-None-Match:"*"` create `log/N`. One wins; the loser sees a
     * FOREIGN 412, probes `N+1`, and commits there. No hole, no wedge.
     */
    test(`[${variant.label}] two writers race log/N: one wins, loser probes N+1`, async () => {
      const { storage, cleanup } = await variant.build();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }
      const currentJsonKey = CURRENT_JSON_KEY;
      const tablePrefix = TABLE_PREFIX;
      await provision(storage);

      const opts = { maxRetries: 5, initialBackoffMs: 0, random: () => 0 } as const;
      const w1 = new Writer({ storage, currentJsonKey, options: opts });
      const w2 = new Writer({ storage, currentJsonKey, options: opts });

      // Both start from tail_hint=0 (fresh) and contend on log/0.
      const [r1, r2] = await Promise.allSettled([
        w1.commit({ op: "I", collection: COLLECTION, docId: "race-a", body: { _id: "race-a" } }),
        w2.commit({ op: "I", collection: COLLECTION, docId: "race-b", body: { _id: "race-b" } }),
      ]);
      // BOTH must succeed — the loser re-probes forward and commits.
      expect(r1.status).toBe("fulfilled");
      expect(r2.status).toBe("fulfilled");

      // Dense at 0,1 — no hole, no wedge.
      const seqs = await durableLogSeqs(storage, tablePrefix);
      expect(seqs).toEqual([0, 1]);
      const ids = await readAllRowIds(storage);
      expect(ids).toContain("race-a");
      expect(ids).toContain("race-b");
    });

    /**
     * ── Arm 3: reader sees a committed prefix above a stale hint. ──────
     *
     * Commit `log/N` while `tail_hint` stays below `N` (no compactor run,
     * so no durable hint refresh). A reader still sees `log/N` via the
     * forward-probe — the hint is a non-authoritative lower bound.
     */
    test(`[${variant.label}] reader sees committed prefix above a stale tail_hint`, async () => {
      const { storage, cleanup } = await variant.build();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }
      const currentJsonKey = CURRENT_JSON_KEY;
      await provision(storage);

      // Commit three entries through the writer (single-write commit
      // advances NO durable tail_hint — only the compactor does). We do
      // NOT run the compactor, so the stored hint stays at 0.
      const w = new Writer({ storage, currentJsonKey });
      for (const id of ["r0", "r1", "r2"]) {
        await w.commit({ op: "I", collection: COLLECTION, docId: id, body: { _id: id } });
      }

      // The stored hint is still the stale lower bound (no compactor ran).
      const cur = await readCurrentJson(storage, currentJsonKey);
      expect(cur!.json.tail_hint).toBe(0);

      // A reader still sees the full committed prefix via the forward-probe.
      const ids = await readAllRowIds(storage);
      expect(ids).toEqual(["r0", "r1", "r2"]);
    });

    /**
     * ── Arm 4: lost-ack / false-412 (the sharpest trap). ──────────────
     *
     * The writer PUTs `log/N` and the create SUCCEEDS on the backend, but
     * the RESPONSE is DROPPED (a NetworkError thrown AFTER the durable
     * write lands). The writer retries WITHIN THE SAME `commit()` (same
     * session), gets a 412, reads back the occupant → OWN session, OWN
     * seq → ADOPTS → returns success. The logical write lands at EXACTLY
     * `N` and is NOT duplicated at `N+1`. Without adoption a dropped ack
     * double-commits.
     */
    test(`[${variant.label}] lost-ack: dropped response on log/N adopts, lands at exactly N`, async () => {
      const { storage, cleanup } = await variant.build();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }
      const currentJsonKey = CURRENT_JSON_KEY;
      const tablePrefix = TABLE_PREFIX;
      await provision(storage);

      // Wrap storage so the FIRST PUT to a log/<seq> key writes through
      // to the backend (the create lands durably) but THEN throws a
      // NetworkError — the ack is lost. Subsequent ops pass through.
      let dropped = false;
      const lossy: Storage = {
        get: (k, o) => storage.get(k, o),
        delete: (k, o) => storage.delete(k, o),
        list: (p, o) => storage.list(p, o),
        async put(k, b, o) {
          if (!dropped && /\/log\/\d+\.json$/.test(k)) {
            dropped = true;
            // The write LANDS first, then the ack is dropped.
            await storage.put(k, b, o);
            throw new BaerlyError("NetworkError", "injected dropped ack on log PUT");
          }
          return storage.put(k, b, o);
        },
      };

      const w = new Writer({
        storage: lossy,
        currentJsonKey,
        options: { maxRetries: 5, initialBackoffMs: 0, random: () => 0 },
      });
      // The writer's own retry inside commit() must adopt the lost-ack
      // write and return success — NOT throw, NOT double-commit.
      const result = await w.commit({
        op: "I",
        collection: COLLECTION,
        docId: "lost-ack",
        body: { _id: "lost-ack" },
      });
      expect(result.entry.seq).toBe(0);

      // EXACTLY one log entry — landed at N (=0), NOT duplicated at N+1.
      const seqs = await durableLogSeqs(storage, tablePrefix);
      expect(seqs).toEqual([0]);
      const ids = await readAllRowIds(storage);
      expect(ids).toEqual(["lost-ack"]);
    });

    /**
     * ── Arm 5: density invariant — no interior holes. ─────────────────
     *
     * Across a crash-injected run of single-input commits, the log must
     * stay dense: `∀ seq: log/<seq+1> exists ⟹ log/<seq> exists`. Every
     * writer honors first-empty-slot via the forward-probe; the storage
     * layer can't enforce this, so assert it directly.
     */
    propTest.prop({
      seeds: fc.integer({ min: 2, max: 12 }),
      abortAfter: fc.integer({ min: 1, max: 10 }),
    })(
      `[${variant.label}] density invariant: no interior log holes under crash injection`,
      async ({ seeds, abortAfter }) => {
        const { storage, cleanup } = await variant.build();
        if (cleanup !== undefined) {
          cleanups.push(cleanup);
        }
        const currentJsonKey = CURRENT_JSON_KEY;
        const tablePrefix = TABLE_PREFIX;
        await provision(storage);

        const w = new Writer({
          storage,
          currentJsonKey,
          options: { maxRetries: 5, initialBackoffMs: 0, random: () => 0 },
        });
        for (let i = 0; i < seeds; i++) {
          const id = `d-${i}`;
          await w.commit({ op: "I", collection: COLLECTION, docId: id, body: { _id: id } });
        }

        // Inject a crash mid-commit, then a recovery commit. The recovery
        // writer must NOT fill a hole — it commits at the dense tail.
        const handle = abortingStorage(storage);
        const crashWriter = new Writer({ storage: handle.storage, currentJsonKey });
        handle.armAt(abortAfter);
        try {
          await crashWriter.commit({
            op: "I",
            collection: COLLECTION,
            docId: "crash-doc",
            body: { _id: "crash-doc" },
          });
        } catch {
          // Expected on most arming points.
        }
        await w.commit({
          op: "I",
          collection: COLLECTION,
          docId: "recover-doc",
          body: { _id: "recover-doc" },
        });

        // DENSITY: the durable seqs form a contiguous prefix [0, max].
        const seqs = await durableLogSeqs(storage, tablePrefix);
        expect(seqs.length).toBeGreaterThan(0);
        for (let j = 0; j < seqs.length; j++) {
          expect(seqs[j]).toBe(j);
        }
      },
      PROP_TIMEOUT_MS,
    );
  }
});
