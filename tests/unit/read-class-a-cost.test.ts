// Gates the read-path Class A cost claim in
// `docs/about/cost-model.md` §"Maintenance is write-driven; reads are pure":
//
//   - For unindexed idle reads the expected Class A count is exactly zero.
//   - The read-path exception is an indexed `.where()`: one `ListObjects`
//     per equality value, so `$in` over N values costs N calls.
//
// `packages/server/src/reads-pure.test.ts` guards the neighbouring but
// distinct property — that a read mutates nothing — on a PUT + DELETE
// predicate. That predicate cannot see a LIST, and LIST is Class A on both
// R2 and S3, so it cannot gate the cost claim. This file uses
// `billableClassAOps` (PUT + LIST) for that.
//
// Assertions here pin each counter individually rather than a sum. A sum of
// non-negative counters at zero is also satisfied by a read that did no work
// at all, so every case additionally asserts its terminal resolved the right
// answer, and the unindexed cases assert a GET floor.

import { MemoryStorage, type Storage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { describe, expect, test } from "vitest";
import { wrapCountingStorage } from "../fixtures/counting-storage.ts";

const APP = "read-class-a-cost";
const TENANT = "cost";
const COLL = "notes";
const INDEXES = [{ name: "by_tag", on: "tag" }] as const;

const TAGS = ["x", "y", "z"] as const;
/** 12 docs, 4 per tag value — well under the 50-entry write-tick fold floor. */
const SEEDED = 12;
const PER_TAG = SEEDED / TAGS.length;

const dbFor = (storage: Storage, indexed: boolean): Db =>
  Db.create({
    storage,
    app: APP,
    tenant: TENANT,
    ...(indexed ? { config: { collections: { [COLL]: { indexes: [...INDEXES] } } } } : {}),
  });

const seed = async (indexed: boolean): Promise<MemoryStorage> => {
  const storage = new MemoryStorage();
  const db = dbFor(storage, indexed);
  let ordinal = 0;
  for (let round = 0; round < PER_TAG; round++) {
    for (const tag of TAGS) {
      await db.collection(COLL).insert({ _id: `note-${tag}-${round}`, tag, ordinal });
      ordinal += 1;
    }
  }
  return storage;
};

// Each terminal verifies its own result, so a vacuous read cannot pass.
const TERMINALS = [
  {
    name: "all",
    read: async (db: Db): Promise<void> => {
      const rows = await db.collection(COLL).where({ tag: "x" }).all();
      expect(rows, "all() must resolve every matching doc").toHaveLength(PER_TAG);
    },
  },
  {
    name: "first",
    read: async (db: Db): Promise<void> => {
      const row = await db.collection(COLL).where({ tag: "x" }).first();
      expect(row?.["tag"], "first() must resolve a matching doc").toBe("x");
    },
  },
  {
    name: "count",
    read: async (db: Db): Promise<void> => {
      const total = await db.collection(COLL).where({ tag: "x" }).count();
      expect(total, "count() must resolve every matching doc").toBe(PER_TAG);
    },
  },
] as const;

describe("read-path Class A cost", () => {
  for (const terminal of TERMINALS) {
    test(`unindexed ${terminal.name} costs zero Class A ops`, async () => {
      const counting = wrapCountingStorage(await seed(false));

      await terminal.read(dbFor(counting.storage, false));

      expect({
        puts: counting.puts,
        deletes: counting.deletes,
        lists: counting.lists,
      }).toEqual({ puts: 0, deletes: 0, lists: 0 });
      expect(counting.billableClassAOps).toBe(0);
      expect(counting.gets, "the read must have walked storage to be meaningful").toBeGreaterThan(
        0,
      );
    });

    test(`indexed ${terminal.name} costs exactly one LIST`, async () => {
      const counting = wrapCountingStorage(await seed(true));

      await terminal.read(dbFor(counting.storage, true));

      expect({
        puts: counting.puts,
        deletes: counting.deletes,
        lists: counting.lists,
      }).toEqual({ puts: 0, deletes: 0, lists: 1 });
      expect(counting.billableClassAOps).toBe(1);
    });
  }

  test("an indexed $in walk costs exactly one LIST per equality value", async () => {
    const counting = wrapCountingStorage(await seed(true));

    const rows = await dbFor(counting.storage, true)
      .collection(COLL)
      .where((q) => q.in("tag", [...TAGS]))
      .all();

    expect(rows, "the $in union must resolve every seeded doc").toHaveLength(SEEDED);
    expect(counting.lists, "cost-model.md: $in over N values costs N Class A calls").toBe(
      TAGS.length,
    );
    expect({ puts: counting.puts, deletes: counting.deletes }).toEqual({ puts: 0, deletes: 0 });
  });
});
