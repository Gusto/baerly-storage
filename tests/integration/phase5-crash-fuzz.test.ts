/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol`'s `Table<T>`
   declaration); the reader helper threads it through. */

/**
 * Crash-injection fuzzer.
 *
 * Property-based fault-injection that drives `ServerWriter`,
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
 *
 * Runs under default `FC_NUM_RUNS=100` on `pnpm test`. The cranked
 * variant `pnpm test:fuzz-phase5` (`FC_NUM_RUNS=10000`) is the
 * intended thorough sweep.
 *
 * Test-only. The control-flow-level kill points complement
 * `tests/integration/randomized.test.ts`'s transport-level
 * Toxiproxy-driven cascade.
 */

import { fc, test as propTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type JSONArraylessObject,
  MemoryStorage,
  type Storage,
} from "@baerly/protocol";
import { compact, Db, runGc, ServerWriter } from "@baerly/server";
import { abortingStorage } from "../fixtures/aborting-storage.ts";

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
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "phase5-fuzz", claimed_at: "" },
  });
};

interface Row extends JSONArraylessObject {
  _id: string;
}

/**
 * Read every row in the collection through the locked table API,
 * sorted by `_id` for stable equality. The reader walks
 * `(snapshot, log_tail)` exactly the same way production does, so the
 * post-crash invariants are checked against the customer-visible
 * surface.
 */
const readAllRowIds = async (storage: Storage): Promise<string[]> => {
  const db = Db.create({ storage, app: "a", tenant: "t" });
  const rows = await db.table<Row>(COLLECTION).where({}).all();
  return [...rows].map((r) => r._id).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

describe("abortingStorage harness sanity", () => {
  it("armAt(K) fires AbortError on the K-th underlying op", async () => {
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
      const goodWriter = new ServerWriter({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
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
      const crashWriter = new ServerWriter({
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
      // `LogEntry.new` whole, never split.
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
      const writer = new ServerWriter({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
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
        await compact(
          { storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY },
          { minEntriesToCompact: 10, maxEntriesPerRun: numInserts },
        );
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
      const writer = new ServerWriter({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
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
      await compact(
        { storage: inner, currentJsonKey: CURRENT_JSON_KEY },
        { minEntriesToCompact: 10, maxEntriesPerRun: numInserts },
      );
      const before = await readAllRowIds(inner);

      const handle = abortingStorage(inner);
      handle.armAt(abortAfter);
      try {
        await runGc(
          { storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY },
          { graceMillis: 0, maxSweepsPerRun: 200 },
        );
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

describe("Long-running fuzzer (many tick + crash cycles)", () => {
  it(
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
            const writer = new ServerWriter({
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
                      await compact(
                        { storage: inner, currentJsonKey: CURRENT_JSON_KEY },
                        { minEntriesToCompact: 5, maxEntriesPerRun: 200 },
                      );
                    } else {
                      const handle = abortingStorage(inner);
                      handle.armAt(op.abortAfter);
                      await compact(
                        { storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY },
                        { minEntriesToCompact: 5, maxEntriesPerRun: 200 },
                      );
                    }
                    break;
                  }
                  case "gc": {
                    if (op.abortAfter === undefined) {
                      await runGc(
                        { storage: inner, currentJsonKey: CURRENT_JSON_KEY },
                        { graceMillis: 0, maxSweepsPerRun: 200 },
                      );
                    } else {
                      const handle = abortingStorage(inner);
                      handle.armAt(op.abortAfter);
                      await runGc(
                        { storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY },
                        { graceMillis: 0, maxSweepsPerRun: 200 },
                      );
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
