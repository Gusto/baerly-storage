/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through the rebuild reconciler. */

/**
 * Unit tests for `rebuildIndex`.
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
  MemoryStorage,
  type Storage,
} from "@baerly/protocol";
import { allIndexKeysFor, type IndexDefinition } from "./indexes.ts";
import { InMemoryMetricsRecorder } from "./observability/in-memory-metrics.ts";
import { rebuildIndex } from "./rebuild-index.ts";
import { Writer } from "./writer.ts";

const CURRENT_JSON_KEY = "app/x/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/x/tenant/t/manifests/tickets";
const COLLECTION = "tickets";
const BY_STATUS: IndexDefinition = { name: "by_status", on: "status" };

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
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
    const writer = new Writer({
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
    await expect(listIndexKeys(storage)).resolves.toEqual(before);
  });
});

describe("rebuildIndex — orphan cleanup", () => {
  test("removes index keys that point at a no-longer-live doc", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const writer = new Writer({
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
    if (orphanKey === undefined) {
      throw new Error("test bug: failed to construct orphan key");
    }
    await storage.put(orphanKey, new Uint8Array(0), {
      ifNoneMatch: "*",
      contentType: "application/json",
    });
    await expect(listIndexKeys(storage)).resolves.toHaveLength(2);
    const result = await rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS);
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
    expect(result.kept).toBe(1);
    await expect(listIndexKeys(storage)).resolves.toHaveLength(1);
  });
});

describe("rebuildIndex — missing-key repair", () => {
  test("PUTs index keys that should exist but don't", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    // Write a doc WITHOUT the writer's index path (no indexes
    // declared) so no index key lands.
    const writer = new Writer({
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
    await expect(listIndexKeys(storage)).resolves.toEqual([]);

    const result = await rebuildIndex(storage, CURRENT_JSON_KEY, BY_STATUS);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(0);
    await expect(listIndexKeys(storage)).resolves.toHaveLength(1);
  });

  test("idempotence: a second rebuild on the output of the first is a no-op", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const writer = new Writer({
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
    const writer = new Writer({
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

describe("rebuildIndex — dry-run", () => {
  const ADMINS_ONLY: IndexDefinition = {
    name: "admins",
    on: "role",
    predicate: { role: "admin" },
  };

  test("dryRun reports drift counts without modifying storage", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    // Seed two docs through a writer that has NO indexes declared
    // — the on-storage state lands the same way a pre-existing
    // collection would look BEFORE the operator declared the
    // (now-tightened) `adminsOnly` index.
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_JSON_KEY,
      options: {},
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "u1",
      body: { _id: "u1", role: "admin" },
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "u2",
      body: { _id: "u2", role: "member" },
    });

    const adminsListPrefix = `${LOG_PREFIX}/index/${ADMINS_ONLY.name}/`;
    const listAdmins = async (): Promise<string[]> => {
      const out: string[] = [];
      for await (const entry of storage.list(adminsListPrefix)) {
        out.push(entry.key);
      }
      return out.toSorted();
    };
    await expect(listAdmins()).resolves.toEqual([]);

    // First dryRun reports what a real rebuild WOULD add — exactly
    // one filter-matching doc lives in the snapshot+log fold.
    const drift = await rebuildIndex(storage, CURRENT_JSON_KEY, ADMINS_ONLY, {
      dryRun: true,
    });
    expect(drift.added).toBe(1);
    expect(drift.removed).toBe(0);
    expect(drift.kept).toBe(0);

    // Storage was not modified — a second dryRun returns the same counts.
    await expect(listAdmins()).resolves.toEqual([]);
    const drift2 = await rebuildIndex(storage, CURRENT_JSON_KEY, ADMINS_ONLY, {
      dryRun: true,
    });
    expect(drift2).toEqual(drift);
    await expect(listAdmins()).resolves.toEqual([]);

    // A real run reconciles; a follow-up dryRun reports zero drift.
    const realRun = await rebuildIndex(storage, CURRENT_JSON_KEY, ADMINS_ONLY);
    expect(realRun.added).toBe(drift.added);
    expect(realRun.removed).toBe(drift.removed);
    const admins = await listAdmins();
    expect(admins.length).toBe(drift.added);
    const drift3 = await rebuildIndex(storage, CURRENT_JSON_KEY, ADMINS_ONLY, {
      dryRun: true,
    });
    expect(drift3).toEqual({ added: 0, removed: 0, kept: drift.added });
  });

  test("dryRun reports orphan-removal counts without deleting", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_JSON_KEY,
      options: { indexes: [ADMINS_ONLY] },
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "u1",
      body: { _id: "u1", role: "admin" },
    });
    // Inject an orphan: a key for a doc that never existed in the log.
    const [orphanKey] = allIndexKeysFor(
      LOG_PREFIX,
      [ADMINS_ONLY],
      { _id: "ghost", role: "admin" },
      "ghost",
    );
    if (orphanKey === undefined) {
      throw new Error("test bug: failed to construct orphan key");
    }
    await storage.put(orphanKey, new Uint8Array(0), {
      ifNoneMatch: "*",
      contentType: "application/json",
    });

    const listAdmins = async (): Promise<string[]> => {
      const out: string[] = [];
      for await (const entry of storage.list(`${LOG_PREFIX}/index/${ADMINS_ONLY.name}/`)) {
        out.push(entry.key);
      }
      return out.toSorted();
    };
    const before = await listAdmins();
    expect(before).toHaveLength(2);

    const drift = await rebuildIndex(storage, CURRENT_JSON_KEY, ADMINS_ONLY, {
      dryRun: true,
    });
    expect(drift.added).toBe(0);
    expect(drift.removed).toBe(1);
    expect(drift.kept).toBe(1);
    // Storage is unchanged after the dry-run.
    await expect(listAdmins()).resolves.toEqual(before);
  });
});

describe("rebuildIndex — filtered index", () => {
  const FILTERED: IndexDefinition = {
    name: "open_only",
    on: "assignee",
    predicate: { status: "open" },
  };

  const listFilteredKeys = async (storage: Storage): Promise<string[]> => {
    const out: string[] = [];
    for await (const entry of storage.list(`${LOG_PREFIX}/index/${FILTERED.name}/`)) {
      out.push(entry.key);
    }
    return out.toSorted();
  };

  test("rebuild over a filtered index emits only filter-matching keys", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    // Writer with NO indexes commits two docs — one open, one closed.
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_JSON_KEY,
      options: {},
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "a",
      body: { _id: "a", status: "open", assignee: "alice" },
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "b",
      body: { _id: "b", status: "closed", assignee: "alice" },
    });
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);

    const result = await rebuildIndex(storage, CURRENT_JSON_KEY, FILTERED);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(0);
    const after = await listFilteredKeys(storage);
    expect(after).toHaveLength(1);
    expect(after[0]!.endsWith("/a.json")).toBe(true);
  });

  test("rebuild over a filtered index removes orphans from docs that fell out of the filter", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const writer = new Writer({
      storage,
      currentJsonKey: CURRENT_JSON_KEY,
      options: { indexes: [FILTERED] },
    });
    await writer.commit({
      op: "I",
      collection: COLLECTION,
      docId: "a",
      body: { _id: "a", status: "open", assignee: "alice" },
    });
    // Inject an orphan: a key for the pre-image of an "open" doc
    // that has since transitioned out of the filter. Simulates a
    // writer that crashed before its U-quadrant DELETE flushed.
    const [orphanKey] = allIndexKeysFor(
      LOG_PREFIX,
      [FILTERED],
      { _id: "a", status: "open", assignee: "ghost" },
      "a",
    );
    if (orphanKey === undefined) {
      throw new Error("test bug: failed to construct orphan key");
    }
    await storage.put(orphanKey, new Uint8Array(0), {
      ifNoneMatch: "*",
      contentType: "application/json",
    });
    // The writer's U DELETEs the live `alice` key in the
    // match→miss quadrant; rebuild must reconcile to `[]` once the
    // doc has transitioned out of the filter.
    await writer.commit({
      op: "U",
      collection: COLLECTION,
      docId: "a",
      body: { _id: "a", status: "closed", assignee: "alice" },
    });
    // After the U, the live `alice` key is DELETEd but the
    // hand-injected `ghost` orphan survives.
    const beforeRebuild = await listFilteredKeys(storage);
    expect(beforeRebuild).toContain(orphanKey);

    const result = await rebuildIndex(storage, CURRENT_JSON_KEY, FILTERED);
    expect(result.added).toBe(0);
    // The orphan is removed (it points at a doc that no longer
    // satisfies the filter).
    await expect(listFilteredKeys(storage)).resolves.toEqual([]);
  });
});
