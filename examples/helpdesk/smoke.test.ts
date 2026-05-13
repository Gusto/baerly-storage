/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on every Baerly document (see
   `packages/protocol/src/db.ts`). */
import { describe, expect, test } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createListener } from "@baerly/adapter-node";
import { LocalFsStorage } from "@baerly/dev";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type JSONArraylessObject,
  type Verifier,
} from "@baerly/protocol";
import { createBaerlyClient } from "@baerly/client";

interface Ticket extends JSONArraylessObject {
  readonly _id: string;
  readonly title: string;
  readonly status: "open" | "closed";
}

describe("helpdesk smoke", () => {
  test("server + client CRUD round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helpdesk-smoke-"));
    try {
      const storage = new LocalFsStorage({ root: dir });
      await createCurrentJson(storage, "app/helpdesk/tenant/smoke/manifests/tickets/current.json", {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        next_seq: 0,
        writer_fence: { epoch: 0, owner: "smoke", claimed_at: "" },
      });
      const verifier: Verifier = async (req) => {
        if (req.headers.get("authorization") !== "Bearer smoke") return null;
        return { tenantPrefix: "smoke", identity: {} };
      };
      const listener = createListener({ app: "helpdesk", storage, verifier });
      const server = createServer(listener);
      await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
      try {
        const port = (server.address() as AddressInfo).port;
        const client = createBaerlyClient({
          baseUrl: `http://127.0.0.1:${port}`,
          headers: { Authorization: "Bearer smoke" },
        });

        const { _id } = await client.table<Ticket>("tickets").insert({
          title: "smoke",
          status: "open",
        });
        expect(_id).toMatch(/.+/);

        const all = await client.table<Ticket>("tickets").where({}).all();
        expect(all).toEqual([{ _id, title: "smoke", status: "open" }]);

        const one = await client.table<Ticket>("tickets").where({ _id }).first();
        expect(one).toEqual({ _id, title: "smoke", status: "open" });

        await client.table<Ticket>("tickets").where({ _id }).update({ status: "closed" });
        const updated = await client.table<Ticket>("tickets").where({ _id }).first();
        expect(updated?.status).toBe("closed");

        const { deleted } = await client.table<Ticket>("tickets").where({ _id }).delete();
        expect(deleted).toBe(1);

        expect(await client.table<Ticket>("tickets").where({}).count()).toBe(0);
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
