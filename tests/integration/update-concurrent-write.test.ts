/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; tests reference it by name. */

/**
 * `update` / `replace` / `delete` racing a concurrent same-`_id` write
 * (EvalPlanQual semantics, `docs/spec/sync-protocol.md` §"Update and delete:
 * decided on the newest row version").
 *
 * Each test pauses one verb after its read, lets a peer commit to the same
 * `_id`, then releases it, so the peer's entry lands in the verb's commit
 * window `[read tail, own seq)`. Two pause points cover both places the
 * writer re-decides: the verb's own `current.json` read at the start of
 * `Writer.commit` (the window is read before any index marker), and the
 * committing `log/<seq>` create (the peer wins the slot, so the decision
 * re-runs on the lost-race path).
 *
 * The storm at the bottom is the regression oracle: concurrent
 * single-row and batch updates, replaces, deletes and re-inserts on a small
 * `_id` pool, checked against the committed log (`assertEvalPlanQualHistory`).
 */

import { describe, expect, test } from "vitest";
import {
  type Collection,
  type DocumentData,
  type IndexDefinition,
  type Storage,
} from "@baerly/protocol";
import { allIndexKeysFor, Db } from "@baerly/server";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import {
  APP,
  bootstrap,
  COLLECTION,
  CURRENT_JSON_KEY,
  makeVariants,
  TABLE_PREFIX,
  TENANT,
} from "../fixtures/maintenance-harness.ts";
import {
  assertEvalPlanQualHistory,
  jitterStorage,
  RMW_IDS,
  rmwOpsFromPrng,
  runRmwOps,
  seedRmwRows,
  seededPrng,
} from "../fixtures/same-id-rmw.ts";

const BY_STATUS: IndexDefinition = { name: "by_status", on: "status" };
/** Projects a key only a rebased post-image carries: the peer's `status` with this write's `n`. */
const BY_STATUS_N: IndexDefinition = { name: "by_status_n", on: ["status", "n"] };
const INDEXES = [BY_STATUS, BY_STATUS_N];

/**
 * Wrap `inner` so the `n`-th call matching `when` waits until `release()`.
 * `paused` resolves once that call is reached.
 */
const pauseAt = (inner: Storage, when: (op: "get" | "put", key: string) => boolean, n = 1) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => (reached = resolve));
  let hits = 0;
  const hold = async (op: "get" | "put", key: string): Promise<void> => {
    if (when(op, key) && ++hits === n) {
      reached();
      await gate;
    }
  };
  const storage: Storage = {
    get: async (k, o) => (await hold("get", k), await inner.get(k, o)),
    put: async (k, b, o) => (await hold("put", k), await inner.put(k, b, o)),
    delete: (k, o) => inner.delete(k, o),
    list: (p, o) => inner.list(p, o),
  };
  return { storage, paused, release };
};

/** The verb's `Writer.commit` Step 1 read: the 2nd `current.json` GET (the 1st is its read). */
const atCommitStart = (inner: Storage) =>
  pauseAt(inner, (op, key) => op === "get" && key === CURRENT_JSON_KEY, 2);
/** The verb's committing `log/<seq>` create. */
const atLogCreate = (inner: Storage) =>
  pauseAt(inner, (op, key) => op === "put" && key.startsWith(`${TABLE_PREFIX}/log/`));

const settle = <T>(p: Promise<T>): Promise<{ ok: T } | { code: string | undefined }> =>
  p.then(
    (ok) => ({ ok }),
    (error: unknown) => ({ code: (error as { code?: string }).code }),
  );

/** Write-tick maintenance off, so no fold moves the log under the paused verb. */
const quiet = async <T>(fn: () => Promise<T>): Promise<T> =>
  await runWithContext(createObservabilityContext({ maintenance: { disabled: true } }), fn);

for (const variant of makeVariants("baerly-update-race-")) {
  describe(`update / replace / delete vs a concurrent same-_id write [${variant.label}]`, () => {
    const setup = async (indexed = false) => {
      const { storage } = await variant.build();
      await bootstrap(storage, "update-race");
      const coll = (s: Storage) =>
        Db.create({
          storage: s,
          app: APP,
          tenant: TENANT,
          ...(indexed && { config: { collections: { [COLLECTION]: { indexes: INDEXES } } } }),
        }).collection(COLLECTION) as Collection<DocumentData>;
      for (const i of [0, 1, 2, 3]) {
        await coll(storage).insert({ _id: `r${i}`, n: 0, status: "open" });
      }
      return { storage, coll };
    };
    const idsOf = async (rows: Promise<DocumentData[]>): Promise<string[]> => {
      const all = await rows;
      return all.map((r) => r["_id"] as string).toSorted();
    };
    const ids = (c: { all(): Promise<DocumentData[]> }) => idsOf(c.all());

    test("update(id) after a concurrent delete commits nothing and reports modified: 0", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const upd = settle(coll(gated.storage).update("r1", { n: 3 }));
        await gated.paused;
        await expect(coll(storage).delete("r1")).resolves.toEqual({ deleted: 1 });
        gated.release();
        await expect(upd).resolves.toEqual({ ok: { modified: 0 } });
        await expect(ids(coll(storage))).resolves.toEqual(["r0", "r2", "r3"]);
      });
    });

    test("where().update() skips a row a concurrent delete removed, and updates the rest", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const upd = settle(coll(gated.storage).where({ n: 0 }).update({ n: 3 }));
        await gated.paused;
        await coll(storage).delete("r1");
        gated.release();
        await expect(upd).resolves.toEqual({ ok: { modified: 3 } });
        const rows = await coll(storage).all();
        expect(rows.map((r) => [r["_id"], r["n"]]).toSorted()).toEqual([
          ["r0", 3],
          ["r2", 3],
          ["r3", 3],
        ]);
      });
    });

    test("a batch row deleted during an earlier row's commit is skipped too", async () => {
      // r3's delete lands in r0's commit window, so r3's own window is empty.
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const upd = settle(coll(gated.storage).where({ n: 0 }).update({ n: 3 }));
        await gated.paused;
        await coll(storage).delete("r3");
        gated.release();
        await expect(upd).resolves.toEqual({ ok: { modified: 3 } });
        await expect(ids(coll(storage))).resolves.toEqual(["r0", "r1", "r2"]);
      });
    });

    test("update(id) after a concurrent delete and re-insert leaves the new row alone", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const upd = settle(coll(gated.storage).update("r1", { n: 3 }));
        await gated.paused;
        await coll(storage).delete("r1");
        await coll(storage).insert({ _id: "r1", fresh: true });
        gated.release();
        await expect(upd).resolves.toEqual({ ok: { modified: 0 } });
        await expect(coll(storage).get("r1")).resolves.toEqual({ _id: "r1", fresh: true });
      });
    });

    test("update(id) racing an update to another field keeps both fields", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const upd = settle(coll(gated.storage).update("r1", { a: 1 }));
        await gated.paused;
        await coll(storage).update("r1", { b: 2 });
        gated.release();
        await expect(upd).resolves.toEqual({ ok: { modified: 1 } });
        await expect(coll(storage).get("r1")).resolves.toEqual({
          _id: "r1",
          n: 0,
          status: "open",
          a: 1,
          b: 2,
        });
      });
    });

    test("the patch re-applies to the newest version on the lost create race too", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atLogCreate(storage);
        const upd = settle(coll(gated.storage).update("r1", { a: 1 }));
        await gated.paused;
        // The peer wins the slot the paused create targets.
        await coll(storage).update("r1", { b: 2 });
        gated.release();
        await expect(upd).resolves.toEqual({ ok: { modified: 1 } });
        await expect(coll(storage).get("r1")).resolves.toEqual({
          _id: "r1",
          n: 0,
          status: "open",
          a: 1,
          b: 2,
        });
      });
    });

    test("a delete that wins the create race makes the update skip the row", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atLogCreate(storage);
        const upd = settle(coll(gated.storage).update("r1", { a: 1 }));
        await gated.paused;
        await coll(storage).delete("r1");
        gated.release();
        await expect(upd).resolves.toEqual({ ok: { modified: 0 } });
        await expect(coll(storage).get("r1")).resolves.toBeUndefined();
      });
    });

    test("where(p).update() re-evaluates p on the newest version and skips a row that no longer matches", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const upd = settle(coll(gated.storage).where({ status: "open" }).update({ tagged: true }));
        await gated.paused;
        await coll(storage).update("r1", { status: "closed" });
        gated.release();
        await expect(upd).resolves.toEqual({ ok: { modified: 3 } });
        await expect(coll(storage).get("r1")).resolves.toEqual({
          _id: "r1",
          n: 0,
          status: "closed",
        });
        await expect(idsOf(coll(storage).where({ tagged: true }).all())).resolves.toEqual([
          "r0",
          "r2",
          "r3",
        ]);
      });
    });

    test("where(p).update() applies to a row whose newest version still matches p", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const upd = settle(coll(gated.storage).where({ status: "open" }).update({ tagged: true }));
        await gated.paused;
        await coll(storage).update("r1", { n: 9 });
        gated.release();
        await expect(upd).resolves.toEqual({ ok: { modified: 4 } });
        await expect(coll(storage).get("r1")).resolves.toEqual({
          _id: "r1",
          n: 9,
          status: "open",
          tagged: true,
        });
      });
    });

    test("replace after a concurrent delete throws NotFound and leaves the row deleted", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const rep = settle(coll(gated.storage).replace("r1", { _id: "r1", replaced: true }));
        await gated.paused;
        await coll(storage).delete("r1");
        gated.release();
        await expect(rep).resolves.toEqual({ code: "NotFound" });
        await expect(coll(storage).get("r1")).resolves.toBeUndefined();
      });
    });

    test("replace after a concurrent delete that won its create race throws NotFound", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atLogCreate(storage);
        const rep = settle(coll(gated.storage).replace("r1", { _id: "r1", replaced: true }));
        await gated.paused;
        await coll(storage).delete("r1");
        gated.release();
        await expect(rep).resolves.toEqual({ code: "NotFound" });
        await expect(coll(storage).get("r1")).resolves.toBeUndefined();
      });
    });

    test("replace racing an update stays last-writer-wins", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const rep = settle(coll(gated.storage).replace("r1", { _id: "r1", replaced: true }));
        await gated.paused;
        await coll(storage).update("r1", { b: 2 });
        gated.release();
        await expect(rep).resolves.toEqual({ ok: undefined });
        await expect(coll(storage).get("r1")).resolves.toEqual({ _id: "r1", replaced: true });
      });
    });

    for (const [label, pause] of [
      ["before its window read", atCommitStart],
      ["on the lost create race", atLogCreate],
    ] as const) {
      test(`two racing deletes of one row: one reports deleted 1, the other 0 (${label})`, async () => {
        await quiet(async () => {
          const { storage, coll } = await setup();
          const gated = pause(storage);
          const del = settle(coll(gated.storage).delete("r1"));
          await gated.paused;
          await expect(coll(storage).delete("r1")).resolves.toEqual({ deleted: 1 });
          gated.release();
          await expect(del).resolves.toEqual({ ok: { deleted: 0 } });
          await expect(ids(coll(storage))).resolves.toEqual(["r0", "r2", "r3"]);
        });
      });
    }

    test("delete(id) after a concurrent delete and re-insert leaves the new row alone", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const del = settle(coll(gated.storage).delete("r1"));
        await gated.paused;
        await coll(storage).delete("r1");
        await coll(storage).insert({ _id: "r1", fresh: true });
        gated.release();
        await expect(del).resolves.toEqual({ ok: { deleted: 0 } });
        await expect(coll(storage).get("r1")).resolves.toEqual({ _id: "r1", fresh: true });
      });
    });

    test("delete(id) racing an update still deletes the row", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const del = settle(coll(gated.storage).delete("r1"));
        await gated.paused;
        await coll(storage).update("r1", { b: 2 });
        gated.release();
        await expect(del).resolves.toEqual({ ok: { deleted: 1 } });
        await expect(coll(storage).get("r1")).resolves.toBeUndefined();
      });
    });

    test("where(p).delete() re-evaluates p on the newest version and skips a row that no longer matches", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atCommitStart(storage);
        const del = settle(coll(gated.storage).where({ status: "open" }).delete());
        await gated.paused;
        await coll(storage).update("r1", { status: "closed" });
        gated.release();
        await expect(del).resolves.toEqual({ ok: { deleted: 3 } });
        await expect(coll(storage).all()).resolves.toEqual([{ _id: "r1", n: 0, status: "closed" }]);
      });
    });

    test("where(p).delete() deletes a row whose newest version still matches p", async () => {
      await quiet(async () => {
        const { storage, coll } = await setup();
        const gated = atLogCreate(storage);
        const del = settle(coll(gated.storage).where({ status: "open" }).delete());
        await gated.paused;
        // The peer wins the slot the batch's first delete targets.
        await coll(storage).update("r0", { n: 9 });
        gated.release();
        await expect(del).resolves.toEqual({ ok: { deleted: 4 } });
        await expect(coll(storage).all()).resolves.toEqual([]);
      });
    });

    // Before its markers, the rebase writes only the rebased post-image's
    // markers. On the lost create race the markers of the abandoned
    // post-image are already down and stay as benign orphans (never a
    // DELETE: it could remove a marker a later writer re-PUT).
    for (const [label, pause, orphans] of [
      ["before its index markers", atCommitStart, []],
      [
        "on the lost create race",
        atLogCreate,
        allIndexKeysFor(TABLE_PREFIX, [BY_STATUS_N], { _id: "r1", n: 1, status: "open" }, "r1"),
      ],
    ] as const) {
      test(`a rebased post-image is indexed under the concurrently changed value (${label})`, async () => {
        await quiet(async () => {
          const { storage, coll } = await setup(true);
          const gated = pause(storage);
          const upd = settle(coll(gated.storage).update("r1", { n: 1 }));
          await gated.paused;
          await coll(storage).update("r1", { status: "closed" });
          gated.release();
          await expect(upd).resolves.toEqual({ ok: { modified: 1 } });
          // Read through the indexes (the planner picks one for these
          // equalities), and check the bucket holds the live rows' markers,
          // the `(closed, 1)` key only the rebased post-image projects
          // included.
          await expect(coll(storage).where({ status: "closed" }).all()).resolves.toEqual([
            { _id: "r1", n: 1, status: "closed" },
          ]);
          await expect(coll(storage).where({ status: "closed", n: 1 }).all()).resolves.toEqual([
            { _id: "r1", n: 1, status: "closed" },
          ]);
          await expect(idsOf(coll(storage).where({ status: "open" }).all())).resolves.toEqual([
            "r0",
            "r2",
            "r3",
          ]);
          const markers: string[] = [];
          for await (const entry of storage.list(`${TABLE_PREFIX}/index/`)) {
            markers.push(entry.key);
          }
          const live = await coll(storage).all();
          const expected = live.flatMap((row) =>
            allIndexKeysFor(TABLE_PREFIX, INDEXES, row, row["_id"] as string),
          );
          expect(markers.toSorted()).toEqual([...expected, ...orphans].toSorted());
        });
      });
    }

    test(
      "storm: concurrent single-row and batch read-modify-writes on shared _ids",
      { timeout: 120_000 },
      async () => {
        const seeds = Number(process.env["RMW_STORM_SEEDS"] ?? 25);
        for (let seed = 1; seed <= seeds; seed++) {
          await quiet(async () => {
            const { storage } = await variant.build();
            await bootstrap(storage, "rmw-storm");
            const rand = seededPrng(seed);
            await seedRmwRows(storage);
            const ops = rmwOpsFromPrng(rand, 14);
            const results = await runRmwOps(jitterStorage(storage, rand), ops, storage);
            await assertEvalPlanQualHistory(storage, ops, results, `seed ${seed}`);
          });
        }
        expect(RMW_IDS.length).toBeGreaterThan(0);
      },
    );
  });
}
