/**
 * The `db.read.*` read-work counters `runReadRows` records: decoded
 * entries (snapshot rows plus log entries), live documents after the fold
 * and returned rows after predicate / order / limit. Each case pins a
 * shape where the three units diverge.
 */

import { type Collection, type DocumentData, MemoryStorage, type Storage } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { compact } from "./compactor.ts";
import { Db } from "./db.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";

const APP = "test";
const TENANT = "t";
const COLL = "items";
const CURRENT_JSON_KEY = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;

interface Item extends DocumentData {
  _id: string;
  n: number;
}

const makeDb = (storage: Storage = new MemoryStorage()): Db =>
  Db.create({ storage, app: APP, tenant: TENANT });

const seed = async (db: Db, count: number): Promise<void> => {
  const items = db.collection(COLL) as Collection<Item>;
  for (let i = 0; i < count; i++) {
    await items.insert({ _id: `id-${i}`, n: i });
  }
};

interface ReadWork {
  readonly decoded: number | undefined;
  readonly live: number | undefined;
  readonly returned: number | undefined;
}

/** Run `work` in its own observability scope and read back its read-work counters. */
const readWork = async <R>(work: () => Promise<R>): Promise<{ result: R; work: ReadWork }> => {
  const ctx = createObservabilityContext();
  const result = await runWithContext(ctx, work);
  const summary = ctx.recorder.summarize();
  return {
    result,
    work: {
      decoded: summary["db.read.decoded_entries_total"],
      live: summary["db.read.live_documents_total"],
      returned: summary["db.read.returned_rows_total"],
    },
  };
};

describe("read-work metrics", () => {
  test("a small result over a large collection reports the whole fold as input", async () => {
    const db = makeDb();
    await seed(db, 20);
    const items = db.collection(COLL) as Collection<Item>;

    const byId = await readWork(() => items.get("id-7"));
    expect(byId.result?.n).toBe(7);
    expect(byId.work).toEqual({ decoded: 20, live: 20, returned: 1 });

    const filtered = await readWork(() => items.where({ n: 3 }).all());
    expect(filtered.result).toHaveLength(1);
    expect(filtered.work).toEqual({ decoded: 20, live: 20, returned: 1 });

    const limited = await readWork(() => items.order({ n: "desc" }).limit(2).all());
    expect(limited.result.map((row) => row.n)).toEqual([19, 18]);
    expect(limited.work).toEqual({ decoded: 20, live: 20, returned: 2 });

    // `count()` returns no rows; its returned-rows unit is the rows it counts.
    const counted = await readWork(() => items.where((q) => q.lt("n", 5)).count());
    expect(counted.result).toBe(5);
    expect(counted.work).toEqual({ decoded: 20, live: 20, returned: 5 });

    // A counting pass honours `limit` as `all()` does.
    const limitedCount = await readWork(() =>
      items
        .where((q) => q.lt("n", 5))
        .limit(3)
        .count(),
    );
    expect(limitedCount.result).toBe(3);
    expect(limitedCount.work).toEqual({ decoded: 20, live: 20, returned: 3 });
    await expect(items.limit(7).count()).resolves.toBe(7);
    await expect(items.limit(50).count()).resolves.toBe(20);
  });

  test("updates and deletes decode more entries than live documents", async () => {
    const db = makeDb();
    await seed(db, 3);
    const items = db.collection(COLL) as Collection<Item>;
    await items.update("id-0", { n: 100 });
    await items.update("id-0", { n: 200 });
    await items.delete("id-1");

    // 3 inserts + 2 updates + 1 delete in the log; `id-0` and `id-2` live.
    const all = await readWork(() => items.all());
    expect(all.result.map((row) => row._id).toSorted()).toEqual(["id-0", "id-2"]);
    expect(all.work).toEqual({ decoded: 6, live: 2, returned: 2 });
  });

  test("decoded entries count snapshot rows plus the log tail above them", async () => {
    const storage = new MemoryStorage();
    const db = makeDb(storage);
    await seed(db, 4);
    await compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, { minEntriesToCompact: 1 });
    const items = db.collection(COLL) as Collection<Item>;
    await items.update("id-0", { n: 100 });
    await items.delete("id-1");

    // 4 snapshot rows + 2 tail entries; `id-1` is gone.
    const all = await readWork(() => items.all());
    expect(all.result).toHaveLength(3);
    expect(all.work).toEqual({ decoded: 6, live: 3, returned: 3 });
  });

  test("empty reads report zero output, and zero input only when nothing is stored", async () => {
    const db = makeDb();
    const items = db.collection(COLL) as Collection<Item>;

    // Never provisioned: no `current.json`, nothing decoded.
    const unprovisioned = await readWork(() => items.all());
    expect(unprovisioned.result).toEqual([]);
    expect(unprovisioned.work).toEqual({ decoded: 0, live: 0, returned: 0 });

    // Every row deleted: the log is still decoded, nothing is live.
    await seed(db, 2);
    await items.where({}).delete();
    const allDeleted = await readWork(() => items.all());
    expect(allDeleted.result).toEqual([]);
    expect(allDeleted.work).toEqual({ decoded: 4, live: 0, returned: 0 });

    // Live rows the predicate rejects.
    await seed(db, 2);
    const noMatch = await readWork(() => items.where({ n: 99 }).all());
    expect(noMatch.result).toEqual([]);
    expect(noMatch.work).toEqual({ decoded: 6, live: 2, returned: 0 });
  });

  test("a write verb's pre-commit read reports the fold it ran", async () => {
    const db = makeDb();
    await seed(db, 5);
    const items = db.collection(COLL) as Collection<Item>;

    // Insert's `_id` check folds the whole collection and matches nothing.
    const inserted = await readWork(() => items.insert({ _id: "id-new", n: 5 }));
    expect(inserted.result).toEqual({ _id: "id-new" });
    expect(inserted.work).toEqual({ decoded: 5, live: 5, returned: 0 });
  });

  test("reads in one request sum onto its canonical line", async () => {
    const db = makeDb();
    await seed(db, 3);
    const items = db.collection(COLL) as Collection<Item>;

    const both = await readWork(async () => {
      await items.get("id-0");
      return await items.all();
    });
    expect(both.work).toEqual({ decoded: 6, live: 6, returned: 4 });
  });
});
