import { describe, expect, test } from "vitest";
import { MemoryStorage, readCurrentJson } from "@baerly/protocol";
import { Writer } from "@baerly/server/_internal/testing";
import { ensureTable } from "./ensure-table.ts";

const keyFor = (app: string, tenant: string, table: string): string =>
  `app/${app}/tenant/${tenant}/manifests/${table}/current.json`;

describe("ensureTable", () => {
  test("creates current.json with a valid CurrentJson shape on first call", async () => {
    const storage = new MemoryStorage();
    await ensureTable(storage, { app: "helpdesk", tenant: "acme", table: "tickets" });

    const read = await readCurrentJson(storage, keyFor("helpdesk", "acme", "tickets"));
    expect(read).not.toBeNull();
    expect(read?.json).toMatchObject({
      schema_version: 3,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0 },
      tail_bytes: 0,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
  });

  test("is idempotent — a second call does not throw", async () => {
    const storage = new MemoryStorage();
    await ensureTable(storage, { app: "helpdesk", tenant: "acme", table: "tickets" });
    await expect(
      ensureTable(storage, { app: "helpdesk", tenant: "acme", table: "tickets" }),
    ).resolves.toBeUndefined();
  });

  test("preserves an existing manifest's state across re-entry", async () => {
    const storage = new MemoryStorage();
    const key = keyFor("helpdesk", "acme", "tickets");
    await ensureTable(storage, { app: "helpdesk", tenant: "acme", table: "tickets" });

    // Commit one mutation. Under single-write commit this lands log/0 but
    // does NOT advance the stored tail_hint (compactor-only). Advance the
    // manifest's log_seq_start directly to simulate a compactor fold so
    // we can prove ensureTable's re-entry preserves an ADVANCED manifest.
    const writer = new Writer({ storage, currentJsonKey: key });
    await writer.commit({
      op: "I",
      collection: "tickets",
      docId: "t1",
      body: { _id: "t1", title: "first" },
    });
    const { casUpdateCurrentJson } = await import("@baerly/protocol");
    await casUpdateCurrentJson(storage, key, (c) => ({ ...c, tail_hint: 1, log_seq_start: 1 }));

    const before = await readCurrentJson(storage, key);
    expect(before?.json.tail_hint).toBe(1);
    expect(before?.json.log_seq_start).toBe(1);

    // Re-entry must not overwrite the advanced manifest.
    await ensureTable(storage, { app: "helpdesk", tenant: "acme", table: "tickets" });
    const after = await readCurrentJson(storage, key);
    expect(after?.json.tail_hint).toBe(1);
    expect(after?.json.log_seq_start).toBe(1);
  });

  test("Writer.commit succeeds end-to-end after ensureTable", async () => {
    const storage = new MemoryStorage();
    await ensureTable(storage, { app: "helpdesk", tenant: "acme", table: "tickets" });

    const writer = new Writer({
      storage,
      currentJsonKey: keyFor("helpdesk", "acme", "tickets"),
    });
    const result = await writer.commit({
      op: "I",
      collection: "tickets",
      docId: "t1",
      body: { _id: "t1", title: "hello" },
    });
    expect(result.entry.seq).toBe(0);
  });

  test("scopes per (app, tenant, table) — sibling tables do not collide", async () => {
    const storage = new MemoryStorage();
    await ensureTable(storage, { app: "helpdesk", tenant: "acme", table: "tickets" });
    await ensureTable(storage, { app: "helpdesk", tenant: "acme", table: "users" });
    await ensureTable(storage, { app: "helpdesk", tenant: "beta", table: "tickets" });

    await expect(
      readCurrentJson(storage, keyFor("helpdesk", "acme", "tickets")),
    ).resolves.not.toBeNull();
    await expect(
      readCurrentJson(storage, keyFor("helpdesk", "acme", "users")),
    ).resolves.not.toBeNull();
    await expect(
      readCurrentJson(storage, keyFor("helpdesk", "beta", "tickets")),
    ).resolves.not.toBeNull();
  });
});
