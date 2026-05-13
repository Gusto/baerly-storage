/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through the rebuild reconciler. */

/**
 * Phase-8 — unit tests for `rebuildIndex`.
 *
 * Asserts the four invariants the command must honour:
 *
 *   1. A healthy in-sync index → `{ added: 0, removed: 0 }`.
 *   2. An orphan index key → `{ removed: 1 }` and the key is gone.
 *   3. A missing index key → `{ added: 1 }` and the key is present.
 *   4. Re-running on its own output is the no-op of invariant (1).
 */

import { describe, expect, test } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  InMemoryMetricsRecorder,
  MemoryStorage,
  type Storage,
} from "@baerly/protocol";
import { allIndexKeysFor, type IndexDefinition } from "./indexes.ts";
import { rebuildIndex } from "./rebuild-index.ts";
import { ServerWriter } from "./server-writer.ts";

const CURRENT_JSON_KEY = "app/x/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/x/tenant/t/manifests/tickets";
const COLLECTION = "tickets";
const BY_STATUS: IndexDefinition = { name: "by_status", on: "status" };

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    writer_fence: { epoch: 0, owner: "rebuild-test", claimed_at: "" },
  });
};

const listIndexKeys = async (storage: Storage): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of storage.list(`${LOG_PREFIX}/index/${BY_STATUS.name}/`)) {
    out.push(entry.key);
  }
  return out.toSorted();
};

describe("rebuildIndex — healthy index", () => {
  test("re-running on a writer-built index is a no-op", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_JSON_KEY,
      options: { indexes: [BY_STATUS] },
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "a",
      body: { _id: "a", status: "open" },
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "b",
      body: { _id: "b", status: "closed" },
    });
    const before = await listIndexKeys(storage);
    const result = await rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(2);
    expect(await listIndexKeys(storage)).toEqual(before);
  });
});

describe("rebuildIndex — orphan cleanup", () => {
  test("removes index keys that point at a no-longer-live doc", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_JSON_KEY,
      options: { indexes: [BY_STATUS] },
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "a",
      body: { _id: "a", status: "open" },
    });
    // Inject an orphan: a key for a doc that never existed in the log.
    const [orphanKey] = allIndexKeysFor(
      LOG_PREFIX,
      [BY_STATUS],
      { _id: "ghost", status: "wip" },
      "ghost",
    );
    if (orphanKey === undefined) throw new Error("test bug: failed to construct orphan key");
    await storage.put(orphanKey, new Uint8Array(0), {
      ifNoneMatch: "*",
      contentType: "application/json",
    });
    expect(await listIndexKeys(storage)).toHaveLength(2);
    const result = await rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS);
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
    expect(result.kept).toBe(1);
    expect(await listIndexKeys(storage)).toHaveLength(1);
  });
});

describe("rebuildIndex — missing-key repair", () => {
  test("PUTs index keys that should exist but don't", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    // Write a doc WITHOUT the writer's index path (no indexes
    // declared) so no index key lands.
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_JSON_KEY,
      // Intentionally empty — simulates a doc written before the
      // operator declared the index in baerly.config.ts.
      options: {},
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "a",
      body: { _id: "a", status: "open" },
    });
    expect(await listIndexKeys(storage)).toEqual([]);

    const result = await rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(0);
    expect(await listIndexKeys(storage)).toHaveLength(1);
  });

  test("idempotence: a second rebuild on the output of the first is a no-op", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_JSON_KEY,
      options: {},
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "a",
      body: { _id: "a", status: "open" },
    });
    await rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS);
    const second = await rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS);
    expect(second.added).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.kept).toBe(1);
  });
});

describe("rebuildIndex — error surface", () => {
  test("throws InvalidResponse when current.json is missing", async () => {
    const storage = new MemoryStorage();
    await expect(rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS)).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });
});

describe("rebuildIndex — options bag", () => {
  test("accepts a MetricsRecorder without throwing (additive signature)", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: CURRENT_JSON_KEY,
      options: { indexes: [BY_STATUS] },
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "a",
      body: { _id: "a", status: "open" },
    });
    const metrics = new InMemoryMetricsRecorder();
    const result = await rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS, { metrics });
    // Signature compiles; no current metric emissions required from
    // rebuildIndex in this dispatch (the sweep-counter wiring lands
    // later). The call body MUST still produce a sane result.
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
  });

  test("accepts an AbortSignal in the options bag (additive signature)", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const result = await rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS, {
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ added: 0, removed: 0, kept: 0 });
  });

  test("opts defaults to {} — every existing positional caller still compiles", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    // No 4th argument — proves the prior call shape is preserved.
    const result = await rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS);
    expect(result).toEqual({ added: 0, removed: 0, kept: 0 });
  });
});
