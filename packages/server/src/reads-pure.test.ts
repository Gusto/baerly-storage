/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; test seeds doc bodies with it. */

/**
 * Guard: reads NEVER tick maintenance.
 *
 * In-band maintenance dispatches exclusively from the WRITE path
 * (`Writer.#singleAttemptCommit`). The read terminals (`first`, `all`,
 * `count`) route through `runRead` / `runAllWithMeta` in `query.ts`,
 * which has zero references to `dispatchMaintenance` or
 * `runBoundedMaintenance`:
 *
 *   grep -n "dispatchMaintenance\|runBoundedMaintenance" \
 *     packages/server/src/query.ts
 *   → (no output)
 *
 * These tests assert the behavioral contract: even when a collection
 * is OVER the fold-trigger ratio (derived tail estimate ≥ snapshot_bytes AND
 * derived estimate ≥ MAINTENANCE_MIN_LIVE_BYTES) — the exact condition that
 * would cause the write-tick to fire maintenance — repeated reads
 * through the collection API produce ZERO Class A (mutating) storage
 * ops and leave `current.json` byte-identical.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  casUpdateCurrentJson,
  createCurrentJson,
  type CurrentJson,
  MAINTENANCE_MIN_LIVE_BYTES,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import { Db } from "./db.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { Writer } from "./writer.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

const APP = "test";
const TENANT = "t";
const COLL = "items";

const currentJsonKey = (): string => `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;

const makeDb = (storage: Storage): Db => Db.create({ storage, app: APP, tenant: TENANT });

/**
 * Provision a MemoryStorage with N real writes through the Writer
 * so log entries and content keys are physically present, then
 * patch `current.json` to make the state OVER the fold-trigger ratio:
 *
 *   mean_entry_bytes = RATIO_TRIPPING_MEAN  (≥ the byte floor)
 *   snapshot_bytes = 0                        (ratio = ∞ ≥ target 1.0)
 *
 * This is the same seeding pattern used by `maintenance.test.ts`
 * (cf. `seedLog` + `patchCurrent` there).
 */
const seedOverRatio = async (n: number): Promise<MemoryStorage> => {
  const storage = new MemoryStorage();
  const key = currentJsonKey();
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "reads-pure-test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
  const writer = new Writer({ storage, currentJsonKey: key });
  for (let i = 0; i < n; i++) {
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: `d${i}`,
      body: { _id: `d${i}`, value: i },
    });
  }
  // Force the gate-driving bytes fields into an over-ratio state.
  // snapshot_bytes=0 ⇒ denominator is clamped to MAINTENANCE_MIN_LIVE_BYTES;
  // mean_entry_bytes=RATIO_TRIPPING_MEAN ⇒ derived ratio = 1.0 = TARGET → gate trips.
  await casUpdateCurrentJson(
    storage,
    key,
    (cur): CurrentJson => ({
      ...cur,
      mean_entry_bytes: MAINTENANCE_MIN_LIVE_BYTES,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    }),
  );
  return storage;
};

// ── Counting proxy (Class A = PUT + DELETE; Class B = GET + LIST) ──────
//
// Reuses the same shape as the `countingStorage` helper in
// `maintenance.test.ts`. "Class A" follows the S3 pricing vocabulary:
// PUT / COPY / POST / DELETE = mutating ops that cost more.

interface CountingProxy {
  readonly storage: Storage;
  readonly classA: () => number;
  readonly report: () => Record<string, number>;
}

const countingProxy = (inner: Storage): CountingProxy => {
  const counts = { get: 0, put: 0, delete: 0, list: 0 };
  const wrapper: Storage = {
    async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
      counts.get += 1;
      return inner.get(key, opts);
    },
    async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
      counts.put += 1;
      return inner.put(key, body, opts);
    },
    async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
      counts.delete += 1;
      return inner.delete(key, opts);
    },
    list(
      prefix: string,
      opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
    ): AsyncIterable<StorageListEntry> {
      counts.list += 1;
      return inner.list(prefix, opts);
    },
  };
  return {
    storage: wrapper,
    classA: (): number => counts.put + counts.delete,
    report: (): Record<string, number> => ({ ...counts }),
  };
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("reads are pure — never tick maintenance", () => {
  test(
    "many reads over an over-ratio collection produce ZERO Class A ops",
    { timeout: 30_000 },
    async () => {
      // 60 entries — well over the CLOUDFLARE_FREE_TIER minEntriesToCompact
      // of 50, so a write would fold. The patchCurrent in seedOverRatio
      // sets mean_entry_bytes = RATIO_TRIPPING_MEAN, snapshot_bytes = 0
      // ⇒ ratio = 1.0 ≥ MAINTENANCE_TARGET_RATIO = 1.0.
      const inner = await seedOverRatio(60);
      const proxy = countingProxy(inner);
      const db = makeDb(proxy.storage);

      // Take a snapshot of current.json BEFORE the reads.
      const beforeBody = await inner.get(currentJsonKey());
      expect(beforeBody).not.toBeNull();
      const beforeText = new TextDecoder().decode(beforeBody!.body);

      // Many reads through all three terminals: all(), first(), count().
      // If reads dispatched maintenance even probabilistically at
      // 60/60=100% ratio, some of these would produce PUT ops.
      const ROUNDS = 20;
      for (let i = 0; i < ROUNDS; i++) {
        await db.collection(COLL).where({}).all();
        await db.collection(COLL).where({}).first();
        await db.collection(COLL).count();
      }

      // Assert: ZERO mutating ops across all reads.
      const classAOps = proxy.classA();
      expect(classAOps, `Expected 0 Class A ops; got ${JSON.stringify(proxy.report())}`).toBe(0);

      // Assert: current.json is byte-identical — no fold happened.
      const afterBody = await inner.get(currentJsonKey());
      expect(afterBody).not.toBeNull();
      const afterText = new TextDecoder().decode(afterBody!.body);
      expect(afterText, "current.json was mutated by a read — reads are not pure").toBe(beforeText);
    },
  );

  test(
    "current.json fields are unchanged after reads (no fold advanced log_seq_start / tail_hint)",
    { timeout: 30_000 },
    async () => {
      const inner = await seedOverRatio(60);
      const proxy = countingProxy(inner);
      const db = makeDb(proxy.storage);

      const key = currentJsonKey();
      const beforeResult = await readCurrentJson(inner, key);
      expect(beforeResult).not.toBeNull();
      const before = beforeResult!.json;

      // Multiple read calls.
      await db.collection(COLL).where({}).all();
      await db.collection(COLL).where({}).first();
      await db.collection(COLL).count();
      await db.collection(COLL).where({}).all();

      const afterResult = await readCurrentJson(inner, key);
      expect(afterResult).not.toBeNull();
      const after = afterResult!.json;

      // None of the fold-visible fields should have moved.
      expect(after.log_seq_start, "log_seq_start advanced — reads folded").toBe(
        before.log_seq_start,
      );
      expect(after.tail_hint, "tail_hint changed — reads wrote a log entry").toBe(before.tail_hint);
      expect(after.tail_hint, "tail_hint changed — reads mutated current.json").toBe(
        before.tail_hint,
      );
      expect(after.snapshot_bytes, "snapshot_bytes changed — reads mutated current.json").toBe(
        before.snapshot_bytes,
      );
      expect(after.snapshot, "snapshot pointer changed — reads wrote a snapshot").toEqual(
        before.snapshot,
      );
    },
  );

  test(
    "reads with an observability context that HAS a maintenance dispatch spy — spy is never called",
    { timeout: 30_000 },
    async () => {
      // This is the STRONGEST form of the guard: even when the per-request
      // context carries a live maintenance config with a spy dispatch,
      // the read path must never consult or invoke it.
      // Maintenance dispatch lives ONLY in Writer.#singleAttemptCommit
      // (via `getCurrentContext()?.maintenance`), not in query.ts.
      const inner = await seedOverRatio(60);
      const proxy = countingProxy(inner);
      const db = makeDb(proxy.storage);

      const dispatchSpy = vi.fn<(task: () => Promise<void>) => void | Promise<void>>(() => {
        // If this is ever called from a read, the test will fail.
        return Promise.resolve();
      });

      const ctx = createObservabilityContext({
        maintenance: {
          dispatch: dispatchSpy,
          // disabled: false (default) — maintenance is enabled, so the
          // spy WOULD be called if any read consulted the context.
        },
      });

      await runWithContext(ctx, async () => {
        for (let i = 0; i < 15; i++) {
          await db.collection(COLL).where({}).all();
          await db.collection(COLL).where({}).first();
          await db.collection(COLL).count();
        }
      });

      // The dispatch spy must never have been called.
      expect(
        dispatchSpy,
        "dispatch spy was called — a read path consulted the maintenance context",
      ).not.toHaveBeenCalled();

      // Class A ops are still zero.
      expect(proxy.classA(), `Expected 0 Class A ops; got ${JSON.stringify(proxy.report())}`).toBe(
        0,
      );
    },
  );
});
