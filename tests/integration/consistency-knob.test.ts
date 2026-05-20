/* eslint-disable no-underscore-dangle -- `_id` is the locked PK
   field on document shapes (see `@baerly/protocol/src/table-api.ts`'s
   `Table<T>` / `Query<T>` declarations); assertions surface it by
   name. */

/**
 * Multi-instance contention cases for the `consistency` read knob
 * (ticket 34). Reuses `getOrCreateMemoryStorageForBucket` so two
 * `Db` instances over the same bucket share a backing store but
 * NOT a per-isolate `currentJsonCache` slot — exactly the production
 * shape where each Worker request mints a fresh `Db`.
 */

import { describe, expect, test } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  getOrCreateMemoryStorageForBucket,
  uuid,
} from "@baerly/protocol";
import { Db, ServerWriter } from "@baerly/server";

const APP = "consistency-knob";
const TENANT = "t";
const COLL = "items";
const currentJsonKey = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;
const seedCurrent = () => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  next_seq: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
});

describe("read consistency knob — multi-instance contention", () => {
  test("eventual returns the cached (pre-advance) view; strong re-reads", async () => {
    const bucket = `cons-${uuid().slice(0, 8)}`;
    const sA = getOrCreateMemoryStorageForBucket(bucket);
    const sB = getOrCreateMemoryStorageForBucket(bucket);
    await createCurrentJson(sA, currentJsonKey, seedCurrent());
    const dbB = Db.create({ storage: sB, app: APP, tenant: TENANT });
    const w = new ServerWriter({ storage: sA, currentJsonKey });

    // 1. Seed: writer A inserts r1.
    await w.commit({ op: "I", collection: COLL, docId: "r1", body: { _id: "r1" } });
    // 2. Reader B strong-anchors the cache against the post-seed view.
    const strong1 = await dbB.table(COLL).consistency("strong").all();
    expect(strong1.map((r) => r["_id"] as string)).toEqual(["r1"]);
    // 3. Writer A advances current.json with a second insert.
    await w.commit({ op: "I", collection: COLL, docId: "r2", body: { _id: "r2" } });
    // 4. Reader B with eventual returns the pre-advance view — the
    //    cache slot is still pinned to the generation that contained
    //    only r1.
    const eventual1 = await dbB.table(COLL).consistency("eventual").all();
    expect(eventual1.map((r) => r["_id"] as string)).toEqual(["r1"]);
    // 5. Strong re-anchors against the now-current generation;
    //    subsequent eventual reflects it.
    const strong2 = await dbB.table(COLL).consistency("strong").all();
    expect(strong2.map((r) => r["_id"] as string).toSorted()).toEqual(["r1", "r2"]);
    const eventual2 = await dbB.table(COLL).consistency("eventual").all();
    expect(eventual2.map((r) => r["_id"] as string).toSorted()).toEqual(["r1", "r2"]);
  });

  test("first-ever eventual read anchors (returns live view, not empty)", async () => {
    // Cold-cache path: no strong read has run yet on this isolate;
    // the cache slot is null. The contract is "may be one pointer
    // behind reality," not "empty on cold start" — so the first
    // eventual read MUST anchor (fall through to a strong-style
    // GET) and surface the live row set rather than `[]`.
    const bucket = `cons-cold-${uuid().slice(0, 8)}`;
    const sA = getOrCreateMemoryStorageForBucket(bucket);
    const sB = getOrCreateMemoryStorageForBucket(bucket);
    await createCurrentJson(sA, currentJsonKey, seedCurrent());
    const dbB = Db.create({ storage: sB, app: APP, tenant: TENANT });
    const w = new ServerWriter({ storage: sA, currentJsonKey });

    await w.commit({ op: "I", collection: COLL, docId: "r1", body: { _id: "r1" } });

    // First read on dbB is `eventual` — no prior strong anchor.
    const rows = await dbB.table(COLL).consistency("eventual").all();
    expect(rows.map((r) => r["_id"] as string)).toEqual(["r1"]);
  });
});
