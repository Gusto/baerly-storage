/** Reads and mutation selection must use authoritative snapshot-plus-log membership. */

import {
  type DocumentData,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  type StorageListEntry,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { compact } from "./compactor.ts";
import { Db } from "./db.ts";
import { createObservabilityContext, runWithContext } from "./observability/index.ts";
import { runAllWithMeta, serializeManifestPointer } from "./query.ts";

const APP = "a";
const TENANT = "t";
const COLL = "c";
const PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;

/** Write-tick maintenance off, so reads retain the seeded snapshot and tail. */
const MAINTENANCE_OFF = createObservabilityContext({ maintenance: { disabled: true } });

const offTick = async <R>(fn: () => Promise<R>): Promise<R> =>
  await runWithContext(MAINTENANCE_OFF, fn);

/**
 * A pass-through view of `inner` that parks the first `get` / `delete`
 * `match` accepts until `release()`.
 */
const holdOnce = (
  inner: Storage,
  match: (op: "get" | "delete", key: string) => boolean,
): { storage: Storage; reached: Promise<void>; release: () => void } => {
  let armed = true;
  let arrive!: () => void;
  const reached = new Promise<void>((r) => {
    arrive = r;
  });
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const gate = async (op: "get" | "delete", key: string): Promise<void> => {
    if (armed && match(op, key)) {
      armed = false;
      arrive();
      await released;
    }
  };
  const storage: Storage = {
    async get(key, opts) {
      await gate("get", key);
      return inner.get(key, opts);
    },
    put: (key, body, opts) => inner.put(key, body, opts),
    async delete(key, opts) {
      await gate("delete", key);
      return inner.delete(key, opts);
    },
    list: (prefix, opts) => inner.list(prefix, opts),
  };
  return { storage, reached, release };
};

/**
 * A pass-through view of `inner` that parks every `delete` `match` accepts
 * until `release()`; `reached` resolves when the first one arrives.
 */
const holdDeletes = (
  inner: Storage,
  match: (key: string) => boolean,
): { storage: Storage; reached: Promise<void>; release: () => void } => {
  let arrive!: () => void;
  const reached = new Promise<void>((r) => {
    arrive = r;
  });
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const storage: Storage = {
    get: (key, opts) => inner.get(key, opts),
    put: (key, body, opts) => inner.put(key, body, opts),
    async delete(key, opts) {
      if (match(key)) {
        arrive();
        await released;
      }
      return inner.delete(key, opts);
    },
    list: (prefix, opts) => inner.list(prefix, opts),
  };
  return { storage, reached, release };
};

const ids = (rows: readonly DocumentData[]): string[] =>
  rows.map((r) => r["_id"] as string).toSorted();

describe("reads return every live matching row with declared indexes", () => {
  test("a row re-inserted while a delete's stale-marker DELETE was in flight is still found", async () => {
    // A commits `D` for `x`, then DELETEs `x`'s `by_id` marker. B's
    // re-insert lands in between: its marker PUT finds the marker still
    // present (412, swallowed), then B commits `I`. A's DELETE then
    // removes the only marker for B's live row.
    const inner = new MemoryStorage();
    const config = {
      collections: {
        [COLL]: {
          indexes: [
            { name: "by_id", on: "_id" },
            { name: "by_by", on: "by" },
          ],
        },
      },
    };
    const aGate = holdOnce(inner, (op, key) => op === "delete" && key.includes("/index/by_id/"));
    const a = Db.create({ storage: aGate.storage, app: APP, tenant: TENANT, config });
    const b = Db.create({ storage: inner, app: APP, tenant: TENANT, config });
    await offTick(() => b.collection(COLL).insert({ _id: "x", by: "B1" }));

    const deleting = offTick(() => a.collection(COLL).delete("x"));
    await aGate.reached;
    await offTick(() => b.collection(COLL).insert({ _id: "x", by: "B2" }));
    aGate.release();
    await deleting;

    const fullScan = Db.create({ storage: inner, app: APP, tenant: TENANT }).collection(COLL);
    await expect(fullScan.get("x")).resolves.toEqual({ _id: "x", by: "B2" });
    await expect(b.collection(COLL).get("x")).resolves.toEqual({ _id: "x", by: "B2" });
    await expect(b.collection(COLL).where({ by: "B2" }).all()).resolves.toEqual([
      { _id: "x", by: "B2" },
    ]);
  });

  test.each(["update by id", "batch update", "delete by id", "batch delete"] as const)(
    "%s acts on a row re-inserted while a delete's stale-marker DELETE was in flight",
    async (verb) => {
      // The interleaving the indexed same-_id RMW property can only reach
      // by chance, fixed: A's post-commit DELETEs of `x`'s markers (issued
      // in parallel, so every one is held) land after B's re-insert, so B's
      // live row has no `by_id` or `by_by` marker left. A verb that took
      // membership from markers would act on nothing.
      const inner = new MemoryStorage();
      const config = {
        collections: {
          [COLL]: {
            indexes: [
              { name: "by_id", on: "_id" },
              { name: "by_by", on: "by" },
            ],
          },
        },
      };
      const aGate = holdDeletes(inner, (key) => key.includes("/index/"));
      const a = Db.create({ storage: aGate.storage, app: APP, tenant: TENANT, config });
      const b = Db.create({ storage: inner, app: APP, tenant: TENANT, config });
      await offTick(() => b.collection(COLL).insert({ _id: "x", by: "B" }));

      const deleting = offTick(() => a.collection(COLL).delete("x"));
      await aGate.reached;
      await offTick(() => b.collection(COLL).insert({ _id: "x", by: "B" }));
      aGate.release();
      await deleting;
      const markers: string[] = [];
      for await (const entry of inner.list(`${PREFIX}/index/`)) {
        markers.push(entry.key);
      }
      expect(markers, "the race leaves the live row with no marker").toEqual([]);

      const rows = b.collection(COLL);
      await offTick(async () => {
        if (verb === "update by id") {
          await rows.update("x", { n: 1 });
          await expect(rows.get("x")).resolves.toEqual({ _id: "x", by: "B", n: 1 });
        } else if (verb === "batch update") {
          await expect(rows.where({ by: "B" }).update({ n: 1 })).resolves.toEqual({
            modified: 1,
          });
          await expect(rows.get("x")).resolves.toEqual({ _id: "x", by: "B", n: 1 });
        } else if (verb === "delete by id") {
          await expect(rows.delete("x")).resolves.toEqual({ deleted: 1 });
          await expect(rows.get("x")).resolves.toBeUndefined();
        } else {
          await expect(rows.where({ by: "B" }).delete()).resolves.toEqual({ deleted: 1 });
          await expect(rows.get("x")).resolves.toBeUndefined();
        }
      });
    },
  );

  test("a read's tail does not cover a matching row committed between its LIST and its tail probe", async () => {
    // The walk LISTs `by_status/open/` (empty), then probes the log tail.
    // B's insert of an `open` row commits in between, so the probe walks
    // past B's entry while the row it carries was never a candidate.
    const inner = new MemoryStorage();
    const config = { collections: { [COLL]: { indexes: [{ name: "by_status", on: "status" }] } } };
    const b = Db.create({ storage: inner, app: APP, tenant: TENANT, config });
    await offTick(() => b.collection(COLL).insert({ _id: "seed", status: "closed" }));
    const readerGate = holdOnce(inner, (op, key) => op === "get" && /\/log\/\d+\.json$/.test(key));
    const reader = Db.create({ storage: readerGate.storage, app: APP, tenant: TENANT, config });
    const openRows = {
      wire: { clauses: [{ op: "eq" as const, field: "status", value: "open" }] },
      order: undefined,
      limit: undefined,
    };

    const reading = runAllWithMeta(reader.collectionReadContext(COLL), openRows);
    await readerGate.reached;
    await offTick(() => b.collection(COLL).insert({ _id: "x", status: "open" }));
    readerGate.release();
    const raced = await reading;

    // `seed` is seq 0 and `x` is seq 1, so a tail of 2 covers `x`.
    const head = await readCurrentJson(inner, `${PREFIX}/current.json`);
    const coversX = raced.manifestPointer === serializeManifestPointer(head!.json, 2);
    const returnsX = ids(raced.rows).includes("x");
    expect({ coversX, returnsX }).toEqual({ coversX: true, returnsX: true });
  });

  test("a read finds a row omitted by a synthetic lagging marker LIST", async () => {
    // Synthetic lagging LIST coverage, beyond the strong listing guarantees
    // of S3 and R2. Reads must not depend on marker enumeration at all.
    const inner = new MemoryStorage();
    const created = new Set<string>();
    let lagging = false;
    const storage: Storage = {
      get: (key, opts) => inner.get(key, opts),
      async put(key, body, opts) {
        const result = await inner.put(key, body, opts);
        if (lagging) {
          created.add(key);
        }
        return result;
      },
      delete: (key, opts) => inner.delete(key, opts),
      async *list(prefix, opts): AsyncIterable<StorageListEntry> {
        for await (const item of inner.list(prefix, opts)) {
          if (!created.has(item.key)) {
            yield item;
          }
        }
      },
    };
    const config = { collections: { [COLL]: { indexes: [{ name: "by_status", on: "status" }] } } };
    const db = Db.create({ storage, app: APP, tenant: TENANT, config });
    await offTick(() => db.collection(COLL).insert({ _id: "seed", status: "closed" }));
    lagging = true;
    await offTick(() => db.collection(COLL).insert({ _id: "x", status: "open" }));

    const fullScan = Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL);
    await expect(fullScan.where({ status: "open" }).all()).resolves.toEqual([
      { _id: "x", status: "open" },
    ]);
    await expect(db.collection(COLL).where({ status: "open" }).all()).resolves.toEqual([
      { _id: "x", status: "open" },
    ]);
  });
});

const removeMarkers = async (storage: Storage): Promise<void> => {
  for await (const marker of storage.list(`${PREFIX}/index/`)) {
    await storage.delete(marker.key);
  }
};

const seedWithoutMarkers = async (fold: boolean | "mixed") => {
  const inner = new MemoryStorage();
  const db = Db.create({
    storage: inner,
    app: APP,
    tenant: TENANT,
    config: {
      collections: {
        [COLL]: {
          indexes: [
            { name: "by_id", on: "_id" },
            { name: "by_status_rank", on: ["status", "rank"] },
            { name: "by_rank", on: "rank" },
          ],
        },
      },
    },
  });
  await offTick(async () => {
    for (const [id, status, rank] of [
      ["a", "open", 3],
      ["b", "closed", 2],
      ["c", "open", 1],
      ["d", "open", 4],
    ] as const) {
      await db.collection(COLL).insert({ _id: id, status, rank });
    }
  });
  if (fold) {
    const result = await compact(
      { storage: inner, currentJsonKey: `${PREFIX}/current.json` },
      {
        minEntriesToCompact: 1,
      },
    );
    expect(result.written).toBe(true);
  }
  if (fold === "mixed") {
    await offTick(() => db.collection(COLL).insert({ _id: "e", status: "closed", rank: 8 }));
  }
  await removeMarkers(inner);
  return { inner, rows: db.collection(COLL) };
};

for (const [fold, location] of [
  [false, "tail"],
  [true, "snapshot"],
  ["mixed", "snapshot plus tail"],
] as const) {
  describe(`missing markers in ${location}`, () => {
    test("predicate, order and limit apply to complete membership without LIST", async () => {
      const { inner, rows } = await seedWithoutMarkers(fold);
      inner.list = () => {
        throw new Error("reads must not LIST markers");
      };
      await expect(rows.get("a")).resolves.toEqual({ _id: "a", status: "open", rank: 3 });
      await expect(
        rows.where({ status: "open" }).order({ rank: "asc" }).limit(2).all(),
      ).resolves.toEqual([
        { _id: "c", status: "open", rank: 1 },
        { _id: "a", status: "open", rank: 3 },
      ]);
      await expect(
        rows
          .where((q) => q.in("rank", [1, 4]))
          .order({ rank: "desc" })
          .all(),
      ).resolves.toEqual([
        { _id: "d", status: "open", rank: 4 },
        { _id: "c", status: "open", rank: 1 },
      ]);
      await expect(rows.where((q) => q.gte("rank", 2).lt("rank", 4)).count()).resolves.toBe(2);
      await expect(rows.where({ status: "missing" }).all()).resolves.toEqual([]);
    });

    test.each(["replace", "delete"] as const)(
      "%s by id selects a row with no marker",
      async (verb) => {
        const { rows } = await seedWithoutMarkers(fold);
        await offTick(async () => {
          if (verb === "replace") {
            await rows.replace("a", { status: "replaced", rank: 9 });
            await expect(rows.get("a")).resolves.toEqual({ _id: "a", status: "replaced", rank: 9 });
          } else {
            await expect(rows.delete("a")).resolves.toEqual({ deleted: 1 });
            await expect(rows.get("a")).resolves.toBeUndefined();
          }
        });
      },
    );

    test("update, replace and delete select live rows with missing markers", async () => {
      const { rows } = await seedWithoutMarkers(fold);
      await offTick(async () => {
        await expect(
          rows.where({ status: "open" }).order({ rank: "asc" }).limit(2).update({ changed: true }),
        ).resolves.toEqual({ modified: 2 });
        await expect(rows.replace("d", { status: "replaced", rank: 5 })).resolves.toBeUndefined();
        await expect(rows.where({ status: "open" }).delete()).resolves.toEqual({ deleted: 2 });
      });
      await expect(rows.order({ rank: "asc" }).all()).resolves.toEqual([
        { _id: "b", status: "closed", rank: 2 },
        { _id: "d", status: "replaced", rank: 5 },
        ...(fold === "mixed" ? [{ _id: "e", status: "closed", rank: 8 }] : []),
      ]);
    });
  });
}
