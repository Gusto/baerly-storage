/**
 * Declared indexes never change a read or a mutation's selection: both take
 * membership from the snapshot plus the committed log. A bucket upgraded
 * from a release that wrote index markers keeps them as inert objects, and
 * reads over a deliberately wrong legacy corpus (stale, ghost and missing
 * markers) still return the model's rows without LISTing anything.
 */

import { MemoryStorage, readCurrentJson, type DocumentData, type Storage } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  legacyIndexMarkerKeys,
  seedLegacyIndexMarkers,
} from "../../../tests/fixtures/legacy-index-markers.ts";
import { compact } from "./compactor.ts";
import { Db } from "./db.ts";
import { collectionReadContext } from "./db-read-seams.ts";
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
 * A pass-through view of `inner` that parks the first `get` `match` accepts
 * until `release()`.
 */
const holdOnce = (
  inner: Storage,
  match: (op: "get", key: string) => boolean,
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
  const storage: Storage = {
    async get(key, opts) {
      if (armed && match("get", key)) {
        armed = false;
        arrive();
        await released;
      }
      return inner.get(key, opts);
    },
    put: (key, body, opts) => inner.put(key, body, opts),
    delete: (key, opts) => inner.delete(key, opts),
    list: (prefix, opts) => inner.list(prefix, opts),
  };
  return { storage, reached, release };
};

const ids = (rows: readonly DocumentData[]): string[] =>
  rows.map((r) => r["_id"] as string).toSorted();

describe("reads return every live matching row with declared indexes", () => {
  test("a read's tail covers a matching row committed while it probes", async () => {
    // B's insert of an `open` row commits while the reader's tail probe is
    // parked on its first log GET, so the probe walks past B's entry; the
    // row it carries is in the fold, whatever indexes the reader declares.
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

    const reading = runAllWithMeta(collectionReadContext(reader, COLL), openRows);
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
});

const INDEXES = [
  { name: "by_id", on: "_id" },
  { name: "by_status_rank", on: ["status", "rank"] },
  { name: "by_rank", on: "rank" },
] as const;

/**
 * A legacy corpus that disagrees with the log everywhere it can: `a` and
 * `c` have no marker, `b` is marked under a value it never held, `d` under
 * both its value and a stale one, and `ghost` (never written) is marked.
 */
const seedWrongLegacyMarkers = async (storage: Storage): Promise<void> => {
  const keys = (body: DocumentData) =>
    legacyIndexMarkerKeys(PREFIX, INDEXES, body, body["_id"] as string);
  await seedLegacyIndexMarkers(storage, [
    ...keys({ _id: "b", status: "open", rank: 7 }),
    ...keys({ _id: "d", status: "open", rank: 4 }),
    ...keys({ _id: "d", status: "closed", rank: 1 }),
    ...keys({ _id: "ghost", status: "open", rank: 2 }),
  ]);
};

const seedOverLegacyMarkers = async (fold: boolean | "mixed") => {
  const inner = new MemoryStorage();
  const db = Db.create({
    storage: inner,
    app: APP,
    tenant: TENANT,
    config: { collections: { [COLL]: { indexes: [...INDEXES] } } },
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
  await seedWrongLegacyMarkers(inner);
  return { inner, rows: db.collection(COLL) };
};

for (const [fold, location] of [
  [false, "tail"],
  [true, "snapshot"],
  ["mixed", "snapshot plus tail"],
] as const) {
  describe(`legacy markers over rows in ${location}`, () => {
    test("predicate, order and limit apply to complete membership without LIST", async () => {
      const { inner, rows } = await seedOverLegacyMarkers(fold);
      inner.list = () => {
        throw new Error("reads must not LIST");
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
      "%s by id selects a row the legacy markers miss",
      async (verb) => {
        const { rows } = await seedOverLegacyMarkers(fold);
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

    test("update, replace and delete select live rows, not legacy markers", async () => {
      const { rows } = await seedOverLegacyMarkers(fold);
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
