/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + migrate primitive. */

/**
 * `migrateCollection` — per-row fold + atomic CAS swap of
 * `current.json` under `MemoryStorage`.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  MemoryStorage,
  casUpdateCurrentJson,
  createCurrentJson,
  readCurrentJson,
  type DocumentData,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { loadSnapshotAsMap } from "./compactor.ts";
import { migrateCollection } from "./migrate.ts";
import { ServerWriter } from "./server-writer.ts";

const KEY = "app/a/tenant/t/manifests/c/current.json";
const COLL = "c";

const bootstrap = async (storage: MemoryStorage): Promise<void> => {
  await createCurrentJson(storage, KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "migrate-test", claimed_at: "" },
  });
};

const seedRows = async (storage: MemoryStorage, count: number): Promise<void> => {
  const writer = new ServerWriter({ storage, currentJsonKey: KEY });
  for (let i = 0; i < count; i++) {
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: `d${i}`,
      body: { _id: `d${i}`, n: i, version: 1 },
    });
  }
};

describe("migrateCollection", () => {
  test("bumps a field on every row and stamps migrated_to", async () => {
    const s = new MemoryStorage();
    await bootstrap(s);
    await seedRows(s, 10);

    const result = await migrateCollection({
      storage: s,
      currentJsonKey: KEY,
      collection: COLL,
      transform: (row) => ({ ...row, version: 2 }),
      targetVersion: 1,
    });
    expect(result.noOp).toBe(false);
    expect(result.inputRows).toBe(10);
    expect(result.outputRows).toBe(10);
    expect(result.newSnapshotKey).not.toBeNull();

    const read = await readCurrentJson(s, KEY);
    expect(read).not.toBeNull();
    if (read === null) {
      throw new Error("unreachable");
    }
    expect(read.json.migrated_to).toBe(1);
    expect(read.json.snapshot).toBe(result.newSnapshotKey);
    // log_seq_start advances to next_seq — the whole live log is folded.
    expect(read.json.log_seq_start).toBe(read.json.next_seq);

    const map = await loadSnapshotAsMap(s, read.json.snapshot ?? "", COLL);
    expect(map.size).toBe(10);
    for (const body of map.values()) {
      expect((body as { version: number }).version).toBe(2);
    }
  });

  test("re-run with the same targetVersion short-circuits to a no-op", async () => {
    const s = new MemoryStorage();
    await bootstrap(s);
    await seedRows(s, 5);

    const first = await migrateCollection({
      storage: s,
      currentJsonKey: KEY,
      collection: COLL,
      transform: (row) => ({ ...row, version: 2 }),
      targetVersion: 1,
    });
    expect(first.noOp).toBe(false);

    let invoked = 0;
    const second = await migrateCollection({
      storage: s,
      currentJsonKey: KEY,
      collection: COLL,
      transform: (row) => {
        invoked++;
        return row;
      },
      targetVersion: 1,
    });
    expect(second.noOp).toBe(true);
    expect(second.newSnapshotKey).toBeNull();
    // Short-circuit must happen before the transform runs.
    expect(invoked).toBe(0);
  });

  test("transform returning null deletes rows", async () => {
    const s = new MemoryStorage();
    await bootstrap(s);
    await seedRows(s, 10);

    const result = await migrateCollection({
      storage: s,
      currentJsonKey: KEY,
      collection: COLL,
      transform: (row) => ((row["n"] as number) % 2 === 0 ? row : null),
      targetVersion: 1,
    });
    expect(result.inputRows).toBe(10);
    expect(result.outputRows).toBe(5);

    const read = await readCurrentJson(s, KEY);
    if (read === null) {
      throw new Error("unreachable");
    }
    const map = await loadSnapshotAsMap(s, read.json.snapshot ?? "", COLL);
    expect(map.size).toBe(5);
  });

  test("transform returning a non-object throws SchemaError", async () => {
    const s = new MemoryStorage();
    await bootstrap(s);
    await seedRows(s, 3);

    await expect(
      migrateCollection({
        storage: s,
        currentJsonKey: KEY,
        collection: COLL,
        // Caller bug: returning a number instead of an object.
        transform: (() => 42) as unknown as (
          row: DocumentData,
        ) => DocumentData | null,
        targetVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "SchemaError" });
  });

  test("CAS lost between read and PUT surfaces Conflict", async () => {
    const s = new MemoryStorage();
    await bootstrap(s);
    await seedRows(s, 3);

    // Move current.json's etag forward between the read and the CAS
    // PUT by hooking the snapshot put.
    const originalPut = s.put.bind(s);
    let hooked = false;
    s.put = async (key, body, opts) => {
      if (!hooked && key.includes("/snapshot/")) {
        hooked = true;
        // Mutate current.json after the snapshot lands but before our CAS.
        await casUpdateCurrentJson(s, KEY, (c) => ({ ...c, next_seq: c.next_seq + 0 }));
      }
      return originalPut(key, body, opts);
    };

    await expect(
      migrateCollection({
        storage: s,
        currentJsonKey: KEY,
        collection: COLL,
        transform: (row) => ({ ...row, version: 2 }),
        targetVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "Conflict" });
  });

  test("rejects negative targetVersion as InvalidConfig", async () => {
    const s = new MemoryStorage();
    await bootstrap(s);
    await expect(
      migrateCollection({
        storage: s,
        currentJsonKey: KEY,
        collection: COLL,
        transform: (row) => row,
        targetVersion: -1,
      }),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("missing current.json surfaces InvalidConfig", async () => {
    const s = new MemoryStorage();
    await expect(
      migrateCollection({
        storage: s,
        currentJsonKey: KEY,
        collection: COLL,
        transform: (row) => row,
        targetVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
  });
});
