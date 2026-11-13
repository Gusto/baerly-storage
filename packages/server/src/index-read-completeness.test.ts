/**
 * Index-routed reads must return every live row that matches the
 * predicate, and the tail a read reports must not cover a matching row it
 * did not return. Each case compares an index-routed read against the
 * full fold of the same bucket.
 *
 * All three are `test.fails`: the index walk takes membership from the
 * marker LIST, so a missing or not-yet-listed marker hides a live row.
 * The fix is open (IDX-1); flip each to `test` when it lands.
 */

import {
  type DocumentData,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  type StorageListEntry,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { Db } from "./db.ts";
import { createObservabilityContext, runWithContext } from "./observability/index.ts";
import { runAllWithMeta, serializeManifestPointer } from "./query.ts";

const APP = "a";
const TENANT = "t";
const COLL = "c";
const PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;

/** Write-tick maintenance off, so `current.json` changes only by commit. */
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

const ids = (rows: readonly DocumentData[]): string[] =>
  rows.map((r) => r["_id"] as string).toSorted();

describe("index-routed reads return every live matching row", () => {
  test.fails("a row re-inserted while a delete's stale-marker DELETE was in flight is still found", async () => {
    // A commits `D` for `x`, then DELETEs `x`'s `by_id` marker. B's
    // re-insert lands in between: its marker PUT finds the marker still
    // present (412, swallowed), then B commits `I`. A's DELETE then
    // removes the only marker for B's live row.
    const inner = new MemoryStorage();
    const config = { collections: { [COLL]: { indexes: [{ name: "by_id", on: "_id" }] } } };
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
    await expect(b.collection(COLL).where({ _id: "x" }).all()).resolves.toEqual([
      { _id: "x", by: "B2" },
    ]);
  });

  test.fails("a read's tail does not cover a matching row committed between its LIST and its tail probe", async () => {
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
    expect({ coversX, returnsX }).not.toEqual({ coversX: true, returnsX: false });
  });

  test.fails("an index read finds a row whose marker an eventually consistent LIST has not yet returned", async () => {
    // R2's S3 `ListObjectsV2` is eventually consistent: a just-created
    // marker can be absent from LIST although GET sees it. Model it with
    // a LIST that omits every object created after `lagFrom()`.
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
