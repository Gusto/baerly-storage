import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import { createListener } from "@baerly/adapter-node";
import { sharedSecret } from "@baerly/server/auth";
import { LocalFsStorage, ensureTable } from "@baerly/dev";
import { createBaerlyClient } from "@baerly/client";
import type { Ticket } from "./types.ts";

describe("helpdesk smoke", () => {
  test("server + client CRUD round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helpdesk-smoke-"));
    try {
      const storage = new LocalFsStorage({ root: dir });
      await ensureTable(storage, { app: "helpdesk", tenant: "smoke", table: "tickets" });
      const listener = createListener({
        app: "helpdesk",
        storage,
        verifier: sharedSecret({ secret: "smoke", tenantPrefix: "smoke" }),
      });
      const server = createServer(listener);
      await new Promise<void>((r) => server.listen(0, r));
      try {
        const port = (server.address() as AddressInfo).port;
        const client = createBaerlyClient({
          baseUrl: `http://127.0.0.1:${port}`,
          headers: { Authorization: "Bearer smoke" },
        });
        const tickets = client.table<Ticket>("tickets");

        const { _id } = await tickets.insert({
          title: "smoke",
          status: "open",
          assignee: "qa",
          priority: "med",
          created_at: "2026-05-12T00:00:00Z",
        });
        expect(_id).toMatch(/.+/);

        const all = await tickets.where({}).all();
        expect(all).toHaveLength(1);
        expect(all[0]?._id).toBe(_id);

        const one = await tickets.where({ _id }).first();
        expect(one?.title).toBe("smoke");

        await tickets.where({ _id }).update({ status: "closed" });
        expect((await tickets.where({ _id }).first())?.status).toBe("closed");

        expect(await tickets.where({ status: "closed" }).count()).toBe(1);
        expect(await tickets.where({ status: "open" }).count()).toBe(0);

        const { deleted } = await tickets.where({ _id }).delete();
        expect(deleted).toBe(1);
        expect(await tickets.where({}).count()).toBe(0);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
