// Gates the read-path Class A cost claim in docs/about/cost-model.md:
// reads fold snapshots and logs without PUT, DELETE or LIST, including
// predicates on declared indexes and multi-value $in queries. Every terminal
// verifies its answer and a GET floor so a vacuous read cannot pass.

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

    test(`indexed ${terminal.name} costs zero Class A ops`, async () => {
      const counting = wrapCountingStorage(await seed(true));

      await terminal.read(dbFor(counting.storage, true));

      expect({
        puts: counting.puts,
        deletes: counting.deletes,
        lists: counting.lists,
      }).toEqual({ puts: 0, deletes: 0, lists: 0 });
      expect(counting.billableClassAOps).toBe(0);
      expect(counting.gets).toBeGreaterThan(0);
    });
  }

  test("an indexed $in predicate costs zero Class A ops", async () => {
    const counting = wrapCountingStorage(await seed(true));

    const rows = await dbFor(counting.storage, true)
      .collection(COLL)
      .where((q) => q.in("tag", [...TAGS]))
      .all();

    expect(rows, "the $in union must resolve every seeded doc").toHaveLength(SEEDED);
    expect(counting.lists).toBe(0);
    expect(counting.billableClassAOps).toBe(0);
    expect(counting.gets).toBeGreaterThan(0);
    expect({ puts: counting.puts, deletes: counting.deletes }).toEqual({ puts: 0, deletes: 0 });
  });
});
