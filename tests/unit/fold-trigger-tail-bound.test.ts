/**
 * The write tick bounds the live tail by entry count, not only by the
 * tail-to-snapshot bytes ratio. Under the ratio alone a snapshot of many
 * documents settles at a tail of about `snapshot_bytes / mean_entry_bytes`
 * entries, and every read and write GETs each one. The count arm folds
 * once the tail reaches the profile's `foldAtTailEntries`, so a point read
 * replays at most that many entries on top of its fixed GETs.
 *
 * Covers a profile whose per-pass cap equals its trigger (cf-free, both
 * 20) and profiles whose cap exceeds it (cf-paid and Node, cap 200 over a
 * trigger of 64).
 */

import { describe, expect, test } from "vitest";
import {
  MAINTENANCE_FOLD_AT_TAIL_ENTRIES,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_CF_PAID,
  MAINTENANCE_PROFILE_NODE,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  WRITE_TICK_FOLD_AT_TAIL_ENTRIES,
} from "@baerly/protocol";
import { Db } from "@baerly/server";
import { runWithContext } from "@baerly/server/observability";
import { createObservabilityContext } from "@baerly/server/_internal/observability";
import { type MaintenanceProfile, runMaintenancePass } from "@baerly/server/_internal/maintenance";

const APP = "tailbound";
const TENANT = "t";
const COLL = "docs";
const CURRENT_JSON_KEY = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;

/** 200 documents of ~1.5 KB: a ~300 KiB snapshot, inside every profile's `C` and `E`. */
const DOCS = 200;
const BLOB = "x".repeat(1500);
/** Updates after the seed: enough for the bytes ratio alone to let the tail pass 150. */
const WRITES = 300;
/**
 * A point read GETs `current.json`, the snapshot, each tail entry, and the
 * one missing `log/<seq>` that ends its forward probe.
 */
const POINT_READ_FIXED_GETS = 3;

const countingGets = (inner: Storage): { storage: Storage; gets: () => number } => {
  let gets = 0;
  return {
    storage: {
      get: (key, opts) => {
        gets += 1;
        return inner.get(key, opts);
      },
      put: (key, body, opts) => inner.put(key, body, opts),
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
    },
    gets: () => gets,
  };
};

interface AfterWrite {
  /** Committed entries past `log_seq_start`. */
  readonly tail: number;
  /** GETs of a point read issued after the write and its tick. */
  readonly readGets: number;
}

/**
 * Seed `DOCS` documents folded into one snapshot (tail 0), then drive
 * `WRITES` same-size updates through the write tick under `profile`.
 */
const driveUpdates = async (profile: MaintenanceProfile): Promise<AfterWrite[]> => {
  const inner = new MemoryStorage();
  const docs = Db.create({ storage: inner, app: APP, tenant: TENANT }).collection(COLL);
  await runWithContext(
    createObservabilityContext({ maintenance: { disabled: true } }),
    async () => {
      for (let i = 0; i < DOCS; i++) {
        await docs.insert({ _id: `d${i}`, n: i, blob: BLOB });
      }
    },
  );
  await runMaintenancePass(
    { storage: inner, currentJsonKey: CURRENT_JSON_KEY },
    { compact: { minEntriesToCompact: 1 } },
  );
  const seeded = await readCurrentJson(inner, CURRENT_JSON_KEY);
  // The seed's inserts are seqs 0 .. DOCS - 1, all folded.
  expect(seeded?.json.log_seq_start).toBe(DOCS);

  const counted = countingGets(inner);
  const reader = Db.create({ storage: counted.storage, app: APP, tenant: TENANT }).collection(COLL);
  const ctx = createObservabilityContext({
    maintenance: { options: { profile, phasesPerTick: "single" } },
  });
  const after: AfterWrite[] = [];
  for (let i = 0; i < WRITES; i++) {
    await runWithContext(ctx, () => docs.update(`d${i % DOCS}`, { n: DOCS + i }));
    const cur = await readCurrentJson(inner, CURRENT_JSON_KEY);
    const before = counted.gets();
    await expect(reader.get("d0")).resolves.toMatchObject({ _id: "d0" });
    after.push({
      tail: DOCS + i + 1 - (cur?.json.log_seq_start ?? 0),
      readGets: counted.gets() - before,
    });
  }
  return after;
};

describe("the write tick bounds the live tail by entry count", () => {
  for (const [name, profile, q] of [
    ["cf-free (cap = trigger)", MAINTENANCE_PROFILE_CF_FREE, WRITE_TICK_FOLD_AT_TAIL_ENTRIES],
    ["cf-paid (cap > trigger)", MAINTENANCE_PROFILE_CF_PAID, MAINTENANCE_FOLD_AT_TAIL_ENTRIES],
    ["node (cap > trigger)", MAINTENANCE_PROFILE_NODE, MAINTENANCE_FOLD_AT_TAIL_ENTRIES],
  ] as const) {
    test(`${name}: the tail, and a point read's replay, stay within ${q} entries`, async () => {
      expect(profile.foldAtTailEntries).toBe(q);
      // A trigger above the pass cap could not bring the tail back under it.
      expect(q).toBeLessThanOrEqual(profile.maxFoldEntriesPerPass);
      const after = await driveUpdates(profile);
      const worstTail = Math.max(...after.map((a) => a.tail));
      const worstRead = Math.max(...after.map((a) => a.readGets));
      // At most `q`: a tick the hard-GC guard gives to GC leaves a tail of
      // `q`, and the next write's tick folds it.
      const lastTails = after
        .slice(-30)
        .map((a) => a.tail)
        .join(",");
      expect(worstTail, `tail after the last 30 writes: ${lastTails}`).toBeLessThanOrEqual(q);
      expect(worstRead).toBeLessThanOrEqual(q + POINT_READ_FIXED_GETS);
      // The bound is not met by folding on every write.
      expect(worstTail).toBeGreaterThanOrEqual(q - 1);
    });
  }
});

describe("the count arm skips a fold that cannot land", () => {
  /**
   * A small host: `C` = 16 KiB, a 10-entry pass and a count arm of 4.
   * Production Node runs both phases per tick.
   */
  const SMALL_C = 16 * 1024;
  const SMALL: MaintenanceProfile = {
    ...MAINTENANCE_PROFILE_NODE,
    maxFoldBytes: SMALL_C,
    maxFoldEntriesPerPass: 10,
    foldAtTailEntries: 4,
  };
  const SEED_DOCS = 10;
  const SEED_BLOB = "x".repeat(1000);
  const UNTICKED = createObservabilityContext({ maintenance: { disabled: true } });

  interface TickTraffic {
    readonly snapshotGets: number;
    readonly snapshotPuts: number;
  }

  test("a tail whose first pass rebuilds past C costs its ticks no snapshot GET or rebuild until a write makes it fit", async () => {
    const inner = new MemoryStorage();
    let snapshotGets = 0;
    let snapshotPuts = 0;
    const storage: Storage = {
      get: (key, opts) => {
        if (key.includes("/snapshot/")) {
          snapshotGets += 1;
        }
        return inner.get(key, opts);
      },
      put: (key, body, opts) => {
        if (key.includes("/snapshot/")) {
          snapshotPuts += 1;
        }
        return inner.put(key, body, opts);
      },
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
    };
    const docs = Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL);

    // Seed on a larger host: a ~10 KiB snapshot under SMALL's C, then one
    // update that grows d0 so the snapshot folded through it is past it.
    // That is the state a host move, or a lowered C, leaves behind.
    await runWithContext(UNTICKED, async () => {
      for (let i = 0; i < SEED_DOCS; i++) {
        await docs.insert({ _id: `d${i}`, n: i, blob: SEED_BLOB });
      }
    });
    await runMaintenancePass(
      { storage: inner, currentJsonKey: CURRENT_JSON_KEY },
      { compact: { minEntriesToCompact: 1 } },
    );
    await runWithContext(UNTICKED, () => docs.update("d0", { blob: "x".repeat(8000) }));
    const seeded = (await readCurrentJson(inner, CURRENT_JSON_KEY))!.json;
    expect(seeded.log_seq_start).toBe(SEED_DOCS);
    expect(seeded.snapshot_bytes).toBeLessThan(SMALL_C);

    // On SMALL, same-size updates are admitted (the run past C stays
    // shorter than a pass). Each write's tick is captured and run on its
    // own, so its traffic is measured apart from the write's own read.
    const ticks: Array<() => Promise<void>> = [];
    const ctx = createObservabilityContext({
      maintenance: {
        options: { profile: SMALL, phasesPerTick: "both" },
        dispatch: (task) => {
          ticks.push(task);
        },
      },
    });
    const writeAndTick = async (run: () => Promise<unknown>): Promise<TickTraffic> => {
      await runWithContext(ctx, run);
      const gets = snapshotGets;
      const puts = snapshotPuts;
      for (const tick of ticks.splice(0)) {
        await tick();
      }
      return { snapshotGets: snapshotGets - gets, snapshotPuts: snapshotPuts - puts };
    };

    const stuck: TickTraffic[] = [];
    for (let i = 0; i < 6; i++) {
      stuck.push(await writeAndTick(() => docs.update("d1", { n: 2 + i })));
    }
    // The tail (7 entries) passed the count arm (4), and nothing folded.
    await expect(readCurrentJson(inner, CURRENT_JSON_KEY)).resolves.toMatchObject({
      json: { log_seq_start: SEED_DOCS },
    });
    expect(stuck).toEqual(Array.from({ length: 6 }, () => ({ snapshotGets: 0, snapshotPuts: 0 })));

    // A write that brings the snapshot back within C ends the run, and the
    // count arm folds the whole tail on that write's tick.
    const unstuck = await writeAndTick(() => docs.update("d0", { blob: SEED_BLOB }));
    expect(unstuck.snapshotPuts).toBe(1);
    await expect(readCurrentJson(inner, CURRENT_JSON_KEY)).resolves.toMatchObject({
      json: { log_seq_start: SEED_DOCS + 8 },
    });
  });
});
