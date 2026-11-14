/**
 * Declared indexes are validated no-ops: a collection that declares them
 * issues exactly the storage calls of one that does not, for every write
 * verb and every read, and nothing is ever written under
 * `<collection>/index/`. The request-count grid measures undeclared
 * collections only and leans on this test for the rest.
 */

import { describe, expect, test } from "vitest";
import { MemoryStorage, type Storage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { runWithContext } from "@baerly/server/observability";
import { createObservabilityContext } from "@baerly/server/_internal/observability";
import type { InternalBoundedMaintenanceOptions } from "../../packages/server/src/maintenance-options.ts";
import { listIndexObjects } from "../fixtures/legacy-index-markers.ts";

const APP = "inert";
const TENANT = "t";
const COLL = "tickets";
const PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;

const INDEXES = [
  { name: "by_status", on: "status" },
  { name: "by_rank", on: "rank" },
  { name: "by_status_rank", on: ["status", "rank"] },
];

/** Every storage call, in issue order, as `"<op> <key>"`. */
const recording = (inner: Storage): { storage: Storage; calls: string[] } => {
  const calls: string[] = [];
  const storage: Storage = {
    get: (key, opts) => {
      calls.push(`get ${key}`);
      return inner.get(key, opts);
    },
    put: (key, body, opts) => {
      calls.push(`put ${key}`);
      return inner.put(key, body, opts);
    },
    delete: (key, opts) => {
      calls.push(`delete ${key}`);
      return inner.delete(key, opts);
    },
    list: (prefix, opts) => {
      calls.push(`list ${prefix}`);
      return inner.list(prefix, opts);
    },
  };
  return { storage, calls };
};

type Step = readonly [label: string, run: (db: Db) => Promise<unknown>];

const tickets = (db: Db) => db.collection(COLL);

/**
 * Every write verb on `I` / `U` / `D`, then every read shape, with a
 * write tick inline (maintenance on) so a fold also runs inside the trace.
 */
const STEPS: readonly Step[] = [
  ["insert a", (db) => tickets(db).insert({ _id: "a", status: "open", rank: 1 })],
  ["insert b", (db) => tickets(db).insert({ _id: "b", status: "open", rank: 2 })],
  ["insert c", (db) => tickets(db).insert({ _id: "c", status: "closed", rank: 3 })],
  ["update(id) changing indexed fields", (db) => tickets(db).update("a", { status: "closed" })],
  [
    "where().update() changing indexed fields",
    (db) => tickets(db).where({ status: "open" }).update({ rank: 9 }),
  ],
  ["replace", (db) => tickets(db).replace("c", { status: "open", rank: 5 })],
  ["delete(id)", (db) => tickets(db).delete("b")],
  ["insert again after delete", (db) => tickets(db).insert({ _id: "b", status: "new", rank: 0 })],
  ["where().delete()", (db) => tickets(db).where({ status: "open" }).delete()],
  ["get", (db) => tickets(db).get("a")],
  ["indexed equality", (db) => tickets(db).where({ status: "closed" }).all()],
  ["composite equality", (db) => tickets(db).where({ status: "closed", rank: 1 }).all()],
  [
    "$in",
    (db) =>
      tickets(db)
        .where((q) => q.in("rank", [0, 1]))
        .all(),
  ],
  [
    "range, order, limit",
    (db) =>
      tickets(db)
        .where((q) => q.gte("rank", 0))
        .order({ rank: "desc" })
        .limit(1)
        .all(),
  ],
  ["count", (db) => tickets(db).where({ status: "new" }).count()],
];

const trace = async (declared: boolean) => {
  const inner = new MemoryStorage();
  const { storage, calls } = recording(inner);
  const db = Db.create({
    storage,
    app: APP,
    tenant: TENANT,
    config: { collections: { [COLL]: declared ? { indexes: INDEXES } : {} } },
  });
  const perStep: Record<string, { calls: string[]; result: unknown }> = {};
  // Ticks run inline and fold from a 2-entry tail, so the trace covers
  // the write tick as well as each route.
  const ctx = createObservabilityContext({
    maintenance: { options: { foldAtTailEntries: 2 } as InternalBoundedMaintenanceOptions },
  });
  for (const [label, run] of STEPS) {
    const from = calls.length;
    const result = await runWithContext(ctx, () => run(db));
    perStep[label] = { calls: calls.slice(from), result };
  }
  return { perStep, inner };
};

describe("declared indexes change no storage call", () => {
  test("a collection declaring 3 indexes issues exactly the calls of an undeclared one", async () => {
    const undeclared = await trace(false);
    const declared = await trace(true);
    for (const [label] of STEPS) {
      expect({ label, ...declared.perStep[label] }).toEqual({
        label,
        ...undeclared.perStep[label],
      });
    }
  });

  test("no step writes, reads or lists anything under index/", async () => {
    const { perStep, inner } = await trace(true);
    for (const [label] of STEPS) {
      expect({
        label,
        indexCalls: perStep[label]!.calls.filter((call) => call.includes(`${PREFIX}/index/`)),
      }).toEqual({ label, indexCalls: [] });
    }
    await expect(listIndexObjects(inner, PREFIX)).resolves.toEqual([]);
  });

  // The marker writer used to refuse both: an array in an indexed field
  // threw SchemaError, and a value whose marker key passed the 1024-byte
  // key limit threw InvalidConfig before the commit.
  test("a row with an array and an overlong value in declared fields writes and reads back", async () => {
    const db = Db.create({
      storage: new MemoryStorage(),
      app: APP,
      tenant: TENANT,
      config: { collections: { [COLL]: { indexes: INDEXES } } },
    });
    const long = "x".repeat(1100);
    const row = { _id: "arr", status: ["open", "triage"], rank: 1 };
    await tickets(db).insert(row);
    await tickets(db).insert({ _id: "long", status: long, rank: 2 });
    await expect(tickets(db).update("arr", { status: ["closed"] })).resolves.toEqual({
      modified: 1,
    });
    await expect(tickets(db).get("arr")).resolves.toEqual({ ...row, status: ["closed"] });
    await expect(tickets(db).where({ status: long }).all()).resolves.toEqual([
      { _id: "long", status: long, rank: 2 },
    ]);
  });
});
