/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol`'s `Collection<T>`); this
   test threads it through the writer + reader. */

/**
 * Polarity test for index-emit ordering (ADR-008 Q4).
 *
 * The committing write is the `log/<seq>` create. Secondary-index
 * emission (`newKeys` PUT + `staleKeys` DELETE) must happen AFTER that
 * create so the only crash residual is a *committed-but-briefly-
 * unindexed* doc — whose log entry NAMES the docId, so the
 * snapshot+log fold (and `rebuildIndex`) can always re-derive the
 * marker — instead of a *de-indexed committed doc* the fold can't
 * repair.
 *
 * The pre-reorder polarity emits the index BEFORE the commit: a crash
 * after the stale-key DELETE but before the commit de-indexes a
 * committed-OLD-value doc (the commit never landed, so the on-disk
 * value is still the OLD body — but its OLD index key was already
 * deleted). That is a false-NEGATIVE: an index query for the doc's
 * actual committed value misses it, and no log entry exists to drive
 * repair.
 *
 * This file injects a crash across every storage op of a crash-armed
 * `U` commit and asserts the post-reorder invariants for the resulting
 * on-disk state. It is RED against the pre-reorder order (where one
 * abort point de-indexes a committed-old doc) and GREEN after the
 * reorder.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  type IndexDefinition,
  MemoryStorage,
  type Storage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { abortingStorage } from "../../../tests/fixtures/aborting-storage.ts";
import { Db } from "./db.ts";
import { probeTailFrom } from "./log-tail.ts";

const APP = "test";
const TENANT = "t";
const COLL = "tickets";
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;
const BY_STATUS: IndexDefinition = { name: "by_status", on: "status" };

interface Ticket extends DocumentData {
  _id: string;
  status: string;
}

const makeDb = (storage: Storage): Db =>
  Db.create({
    storage,
    app: APP,
    tenant: TENANT,
    config: { collections: { [COLL]: { indexes: [BY_STATUS] } } },
  });

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
    tail_bytes: 0,
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

/**
 * Fold the committed log into a live `(docId -> body)` map by
 * forward-probe (the writer doesn't advance `tail_hint` under
 * single-write commit). This is the PRIMARY-read truth source — index
 * keys are irrelevant here, only the `log/<seq>` entries.
 */
const liveDocs = async (storage: Storage): Promise<Map<string, Ticket>> => {
  const live = new Map<string, Ticket>();
  const probe = await probeTailFrom(storage, TABLE_PREFIX, 0);
  for (let s = 0; s < probe.tail; s++) {
    const got = await storage.get(`${TABLE_PREFIX}/log/${s}.json`);
    if (got === null) {
      continue;
    }
    const entry = JSON.parse(new TextDecoder().decode(got.body)) as {
      op: "I" | "U" | "D";
      doc_id: string;
      after?: Ticket;
    };
    if (entry.op === "D") {
      live.delete(entry.doc_id);
    } else if (entry.after !== undefined) {
      live.set(entry.doc_id, entry.after);
    }
  }
  return live;
};

const TARGET = "target";

describe("index emit happens AFTER the committing log write (polarity)", () => {
  // The crash-armed commit issues a bounded number of storage ops;
  // 12 comfortably covers content PUT + the commit create + pre-image
  // GET + the index PUT/DELETE for one declared index either side of
  // the reorder.
  const ABORT_POINTS = Array.from({ length: 12 }, (_, i) => i + 1);

  for (const abortAfter of ABORT_POINTS) {
    test(`crash at op ${abortAfter}: a committed doc is never de-indexed below its own committed value`, async () => {
      const inner = new MemoryStorage();
      await provision(inner);

      // Seed the target cleanly so the crash-armed write is a `U` with
      // a real on-disk pre-image (status open -> closed).
      const seedDb = makeDb(inner);
      await seedDb.collection(COLL).insert({ _id: TARGET, status: "open" });

      // Crash-armed update: open -> closed.
      const handle = abortingStorage(inner);
      handle.armAt(abortAfter);
      const crashDb = makeDb(handle.storage);
      try {
        await crashDb.collection(COLL).update(TARGET, { status: "closed" });
      } catch (error) {
        // The synthetic AbortError (or a Conflict the abort induced) is
        // expected; rethrow anything else.
        if (
          !(error instanceof Error) ||
          !(error.name === "AbortError" || (error as { code?: string }).code === "Conflict")
        ) {
          throw error;
        }
      }

      // The on-disk truth source: what a PRIMARY (fold-based) read sees.
      const live = await liveDocs(inner);
      const committed = live.get(TARGET);
      // The target is always committed at *some* value (the seed `open`
      // if the update's commit never landed, or `closed` if it did).
      // INVARIANT (a): primary discoverability holds regardless of where
      // the crash fell.
      expect(committed).toBeDefined();
      const committedStatus = committed!.status;
      const otherStatus = committedStatus === "open" ? "closed" : "open";

      // INVARIANT (c): no false-positive. The index query for the value
      // the doc is NOT committed at must never return it — even when
      // both the new and old index keys are transiently present, the
      // index-walk read's `matchesWire` post-filter (query.ts) re-folds
      // each matched docId from snapshot+log and drops the stale row.
      const readDb = makeDb(inner);
      const byOther = (await readDb
        .collection(COLL)
        .where({ status: otherStatus })
        .all()) as Ticket[];
      expect(
        byOther.map((d) => d._id),
        `index query for non-committed status "${otherStatus}" must NOT see the doc (abort op ${abortAfter})`,
      ).not.toContain(TARGET);

      if (committedStatus === "open") {
        // The update's commit never landed: the doc is still committed
        // at the seed value `open`. The reorder guarantees its `open`
        // index key was NEVER deleted (the emit runs only AFTER a
        // committing create) — so an index query for `open` must STILL
        // find it.
        //
        // PRE-REORDER this is RED: the emit ran first, deleting the
        // `open` stale key before the (never-landing) commit, de-
        // indexing a committed-old doc with no log entry to drive
        // repair.
        const byOpen = (await readDb.collection(COLL).where({ status: "open" }).all()) as Ticket[];
        expect(
          byOpen.map((d) => d._id),
          `committed-old doc must keep its index key (abort op ${abortAfter})`,
        ).toContain(TARGET);
      }

      // INVARIANT (d): a COMMITTED row is ALWAYS index-findable — no
      // false-negative. Whatever value the doc is committed at, an
      // index-routed query for that value must return it. This holds
      // whether the commit landed (`closed`) or not (`open`).
      //
      // EMIT-ALL-AFTER is RED here on the `closed` arm: a crash between
      // the `log/<seq>` create (the commit) and the pure emit-after
      // leaves the committed-NEW value with no index marker — the
      // index-walk read seeds candidates only from index-key lists, so
      // it returns empty and disagrees with the primary fold. The
      // HYBRID (newKeys before the commit) makes the `closed` marker land
      // before the commit, so a committed row is always findable.
      const byCommitted = (await readDb
        .collection(COLL)
        .where({ status: committedStatus })
        .all()) as Ticket[];
      expect(
        byCommitted.map((d) => d._id),
        `committed row must be index-findable at its committed value "${committedStatus}" (no false-negative; abort op ${abortAfter})`,
      ).toContain(TARGET);

      // HR-4 — index-vs-full-scan parity under the crash matrix. An
      // index-routed read of the committed value must equal the
      // PRIMARY/full-scan read of the same committed set. Equivalently:
      // the index-walk row set for `committedStatus` is exactly the docs
      // the fold reports at that status. No false-negative (INVARIANT d)
      // AND no false-positive (INVARIANT c) ⇒ set equality.
      const fullScanAtCommitted = [...live.entries()]
        .filter(([, doc]) => doc.status === committedStatus)
        .map(([id]) => id)
        .toSorted();
      const indexAtCommitted = byCommitted.map((d) => d._id).toSorted();
      expect(
        indexAtCommitted,
        `index-routed read must equal full-scan read at "${committedStatus}" (HR-4 parity; abort op ${abortAfter})`,
      ).toEqual(fullScanAtCommitted);

      // INVARIANT (b): a later same-doc write RESTORES the index marker
      // for the committed value — repairing any briefly-unindexed
      // residual (the acceptable post-reorder crash window).
      const repairDb = makeDb(inner);
      // Re-assert the doc at its committed value (idempotent body).
      await repairDb.collection(COLL).update(TARGET, { status: committedStatus });
      const after = await liveDocs(inner);
      const finalStatus = after.get(TARGET)!.status;
      const repaired = (await makeDb(inner)
        .collection(COLL)
        .where({ status: finalStatus })
        .all()) as Ticket[];
      expect(
        repaired.map((d) => d._id),
        `a subsequent write must restore the index marker (abort op ${abortAfter})`,
      ).toContain(TARGET);
    });
  }
});
