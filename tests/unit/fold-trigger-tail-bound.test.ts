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
const driveUpdates = async (
  profile: MaintenanceProfile,
  phasesPerTick: "single" | "both",
): Promise<AfterWrite[]> => {
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
    maintenance: { options: { profile, phasesPerTick } },
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
  // Each host's production tick shape: Cloudflare runs one phase per
  // tick, Node runs the fold and GC in the same tick.
  for (const [name, profile, q, phasesPerTick] of [
    [
      "cf-free (cap = trigger)",
      MAINTENANCE_PROFILE_CF_FREE,
      WRITE_TICK_FOLD_AT_TAIL_ENTRIES,
      "single",
    ],
    [
      "cf-paid (cap > trigger)",
      MAINTENANCE_PROFILE_CF_PAID,
      MAINTENANCE_FOLD_AT_TAIL_ENTRIES,
      "single",
    ],
    ["node (cap > trigger)", MAINTENANCE_PROFILE_NODE, MAINTENANCE_FOLD_AT_TAIL_ENTRIES, "both"],
  ] as const) {
    test(`${name}: the tail, and a point read's replay, stay within ${q} entries`, async () => {
      expect(profile.foldAtTailEntries).toBe(q);
      // A trigger above the pass cap could not bring the tail back under it.
      expect(q).toBeLessThanOrEqual(profile.maxFoldEntriesPerPass);
      const after = await driveUpdates(profile, phasesPerTick);
      const worstTail = Math.max(...after.map((a) => a.tail));
      const worstRead = Math.max(...after.map((a) => a.readGets));
      // At most `q`: on one phase per tick, a tick the hard-GC guard gives
      // to GC leaves a tail of `q`, and the next write's tick folds it.
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

  /** Each seed document's `g`: the batch tests select rows by it. */
  const GROUP: Readonly<Record<number, string>> = { 1: "b", 2: "c", 3: "c", 4: "c", 9: "b" };

  /**
   * `storage` over `inner`, counting snapshot GETs and PUTs. `beforeLogPut`
   * runs once, just before the next log-entry PUT after `skipLogPuts`
   * others: the seam for a commit another writer lands between a verb's
   * read and its commit.
   */
  const harness = (inner: MemoryStorage) => {
    const traffic = { snapshotGets: 0, snapshotPuts: 0 };
    let inject: { skip: number; run: () => Promise<void> } | undefined;
    const storage: Storage = {
      get: (key, opts) => {
        if (key.includes("/snapshot/")) {
          traffic.snapshotGets += 1;
        }
        return inner.get(key, opts);
      },
      put: async (key, body, opts) => {
        if (key.includes("/snapshot/")) {
          traffic.snapshotPuts += 1;
        }
        if (inject !== undefined && key.includes("/log/")) {
          if (inject.skip > 0) {
            inject.skip -= 1;
          } else {
            const { run } = inject;
            inject = undefined;
            await run();
          }
        }
        return inner.put(key, body, opts);
      },
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
    };
    return {
      storage,
      traffic,
      beforeLogPut: (run: () => Promise<void>, skipLogPuts = 0): void => {
        inject = { skip: skipLogPuts, run };
      },
    };
  };

  /**
   * Seed `SEED_DOCS` documents folded into one snapshot under `SMALL`'s
   * `C`, then grow `grown` unticked so the snapshot folded through it is
   * past `C` (when `grown` is given), as a host move or a lowered `C`
   * leaves it.
   */
  const seedOverC = async (inner: MemoryStorage, grown?: string): Promise<void> => {
    const docs = Db.create({ storage: inner, app: APP, tenant: TENANT }).collection(COLL);
    await runWithContext(UNTICKED, async () => {
      for (let i = 0; i < SEED_DOCS; i++) {
        await docs.insert({ _id: `d${i}`, n: i, g: GROUP[i] ?? "a", blob: SEED_BLOB });
      }
    });
    await runMaintenancePass(
      { storage: inner, currentJsonKey: CURRENT_JSON_KEY },
      { compact: { minEntriesToCompact: 1 } },
    );
    if (grown !== undefined) {
      await runWithContext(UNTICKED, () => docs.update(grown, { blob: "x".repeat(8000) }));
    }
  };

  /** A writer on `inner` that never ticks: another host's commits. */
  const foreign = (inner: MemoryStorage) => {
    const docs = Db.create({ storage: inner, app: APP, tenant: TENANT }).collection(COLL);
    return (run: (c: typeof docs) => Promise<unknown>) => async (): Promise<void> => {
      await runWithContext(UNTICKED, async () => {
        await run(docs);
      });
    };
  };

  /** Run `run` on `SMALL` with its ticks captured, then run them; returns their snapshot traffic. */
  const writeThenTick = async (
    traffic: { snapshotGets: number; snapshotPuts: number },
    run: () => Promise<unknown>,
  ): Promise<TickTraffic> => {
    const ticks: Array<() => Promise<void>> = [];
    const ctx = createObservabilityContext({
      maintenance: {
        options: { profile: SMALL, phasesPerTick: "both" },
        dispatch: (task) => {
          ticks.push(task);
        },
      },
    });
    await runWithContext(ctx, run);
    const gets = traffic.snapshotGets;
    const puts = traffic.snapshotPuts;
    for (const tick of ticks) {
      await tick();
    }
    return { snapshotGets: traffic.snapshotGets - gets, snapshotPuts: traffic.snapshotPuts - puts };
  };

  test("a commit that finds entries past C landed after its read keeps the count arm off its tick", async () => {
    const inner = new MemoryStorage();
    await seedOverC(inner);
    const { storage, traffic, beforeLogPut } = harness(inner);
    const docs = Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL);
    // The verb's read sees an empty tail, so its decision says a fold
    // lands. Before its commit another writer lands three entries, the
    // first past C. The commit's re-check over that window must say the
    // fold cannot land, or the tick (tail 4, the count arm) rebuilds.
    beforeLogPut(
      foreign(inner)(async (other) => {
        await other.update("d0", { blob: "x".repeat(8000) });
        await other.update("d2", { n: 7 });
        await other.update("d3", { n: 8 });
      }),
    );
    const tick = await writeThenTick(traffic, () => docs.update("d1", { n: 5 }));
    const cur = (await readCurrentJson(inner, CURRENT_JSON_KEY))!.json;
    expect(cur.log_seq_start).toBe(SEED_DOCS);
    // The verb's own commit landed behind the other writer's three.
    await expect(
      inner.get(`${CURRENT_JSON_KEY.replace("/current.json", "")}/log/${SEED_DOCS + 3}.json`),
    ).resolves.not.toBeNull();
    expect(tick).toEqual({ snapshotGets: 0, snapshotPuts: 0 });
  });

  test("in a batch, a row that brings the snapshot back within C folds on its own tick", async () => {
    const inner = new MemoryStorage();
    await seedOverC(inner, "d9");
    await runWithContext(UNTICKED, async () => {
      const docs = Db.create({ storage: inner, app: APP, tenant: TENANT }).collection(COLL);
      await docs.update("d2", { n: 7 });
      await docs.update("d3", { n: 8 });
    });
    const { storage, traffic } = harness(inner);
    const docs = Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL);
    // Rows d1 then d9: d1 stays past C (tail 4, held off), d9 shrinks
    // back within C (tail 5), so its tick folds the whole tail.
    const tick = await writeThenTick(traffic, () =>
      docs.where({ g: "b" }).update({ n: 7, blob: SEED_BLOB }),
    );
    expect(tick.snapshotPuts).toBe(1);
    await expect(readCurrentJson(inner, CURRENT_JSON_KEY)).resolves.toMatchObject({
      json: { log_seq_start: SEED_DOCS + 5 },
    });
  });

  test("in a batch, a row after one re-decided over a window keeps that decision's fold verdict", async () => {
    const inner = new MemoryStorage();
    await seedOverC(inner, "d9");
    const { storage, traffic, beforeLogPut } = harness(inner);
    const docs = Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL);
    // Rows d2, d3, d4, all same-size, so every prefix stays past C. Another
    // writer lands an entry before the second row's commit, which
    // re-decides the remaining rows over that window; the third row (tail
    // 5, past the count arm) must read its own verdict from that decision.
    beforeLogPut(
      foreign(inner)((other) => other.update("d5", { n: 8 })),
      1,
    );
    const tick = await writeThenTick(traffic, () => docs.where({ g: "c" }).update({ n: 7 }));
    await expect(readCurrentJson(inner, CURRENT_JSON_KEY)).resolves.toMatchObject({
      json: { log_seq_start: SEED_DOCS },
    });
    expect(tick).toEqual({ snapshotGets: 0, snapshotPuts: 0 });
  });

  test("on cf-free, each write whose fold cannot land signals a held-off deferral, once", async () => {
    const inner = new MemoryStorage();
    await seedOverC(inner, "d0");
    const docs = Db.create({ storage: inner, app: APP, tenant: TENANT }).collection(COLL);
    const warnings: Array<Readonly<Record<string, unknown>>> = [];
    // cf-free's own pass (20) and count arm (20), with C lowered to SMALL's:
    // the verb refuses this tail at 20 entries, under the bytes arm's
    // 50-entry floor, so no fold tick would ever signal it.
    const ctx = createObservabilityContext({
      maintenance: {
        maxFoldBytes: SMALL_C,
        options: { profile: MAINTENANCE_PROFILE_CF_FREE },
        warn: (event, properties) => {
          if (event === "fold_deferred") {
            warnings.push(properties);
          }
        },
      },
    });
    // Four writes cross a cf-free GC boundary (every 4), so one tick is
    // dispatched and the rest are not: both signal sites run.
    const WRITES_HELD = 4;
    for (let i = 0; i < WRITES_HELD; i++) {
      await runWithContext(ctx, () => docs.update("d1", { n: 2 + i }));
    }
    const held = ctx.recorder
      .snapshot()
      .counters.filter((c) => c.name === "db.compaction.deferred_total");
    expect(held.map((c) => c.labels)).toEqual(
      Array.from({ length: WRITES_HELD }, () => ({
        collection: COLL,
        dimension: "bytes",
        gate: "held-off",
      })),
    );
    expect(ctx.recorder.summarize()["db.compaction.deferred_total"]).toBe(WRITES_HELD);
    expect(ctx.recorder.summarize()["db.compaction.deferred_bytes_total"]).toBe(WRITES_HELD);
    // No storage call stamps `last_warned_seq`, so each held-off write warns.
    expect(warnings).toHaveLength(WRITES_HELD);
    expect(warnings[0]).toMatchObject({
      collection: COLL,
      dimension: "bytes",
      gate: "held-off",
      ceiling_bytes: SMALL_C,
      log_seq_start: SEED_DOCS,
      live_log_tail: 2,
    });
    const cur = (await readCurrentJson(inner, CURRENT_JSON_KEY))!.json;
    expect(cur.log_seq_start).toBe(SEED_DOCS);
    expect(cur.last_warned_seq).toBeUndefined();
  });
});
