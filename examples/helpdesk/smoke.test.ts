import { createServer, request as httpRequest } from "node:http";
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

  // Regression: aborting a long-poll /v1/since used to crash the
  // server when `pipeline()` rejected with ERR_STREAM_UNABLE_TO_PIPE
  // on a dead socket. Probe via /v1/healthz after the abort: a crash
  // would surface as a fetch ECONNREFUSED here.
  test("aborting an in-flight /v1/since does not crash the server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helpdesk-smoke-abort-"));
    try {
      const storage = new LocalFsStorage({ root: dir });
      await ensureTable(storage, { app: "helpdesk", tenant: "smoke", table: "tickets" });
      const listener = createListener({
        app: "helpdesk",
        storage,
        verifier: sharedSecret({ secret: "smoke", tenantPrefix: "smoke" }),
        // Short budget so a pre-fix pipeline() rejection (which fires
        // only after the long-poll resolves) lands within this test's
        // wall-clock budget.
        sinceTimeoutMs: 1500,
        sincePollIntervalMs: 50,
      });
      const server = createServer(listener);
      await new Promise<void>((r) => server.listen(0, r));

      const rejections: unknown[] = [];
      const onRejection = (err: unknown): void => {
        rejections.push(err);
      };
      process.on("unhandledRejection", onRejection);

      try {
        const port = (server.address() as AddressInfo).port;

        // Open and abort a long-poll via low-level http.request so we
        // can destroy() the socket mid-flight (fetch's AbortController
        // tears the socket down the same way under the hood; using
        // http.request keeps the abort path explicit).
        const clientReq = httpRequest({
          host: "127.0.0.1",
          port,
          method: "GET",
          path: "/v1/since?table=tickets&cursor=",
          headers: { authorization: "Bearer smoke" },
        });
        clientReq.on("error", () => {});
        clientReq.end();
        await new Promise<void>((r) => setTimeout(r, 100));
        clientReq.destroy();

        // Wait past the (configured) long-poll budget so a regression
        // where pipeline() rejects post-resolve has time to surface.
        await new Promise<void>((r) => setTimeout(r, 1800));

        const probe = await fetch(`http://127.0.0.1:${port}/v1/healthz`);
        expect(probe.status).toBe(200);
        expect(await probe.json()).toEqual({ ok: true });
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onRejection);
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
