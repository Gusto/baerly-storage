/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; the HTTP body wraps the
   server's `{ _id }` response and re-encodes it as JSON. */

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BaerlyAppConfig,
  CURRENT_JSON_SCHEMA_VERSION,
  MemoryStorage,
  createCurrentJson,
  type Storage,
  type Verifier,
} from "@baerly/protocol";
import { getRequestListener } from "@hono/node-server";
import { LocalFsStorage } from "@baerly/dev";
import { baerlyNode } from "@baerly/adapter-node";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { wrapCountingStorage, type CountingStorage } from "../fixtures/counting-storage.ts";

interface Variant {
  readonly label: "memory" | "local-fs";
  readonly build: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

const VARIANTS: ReadonlyArray<Variant> = [
  {
    label: "memory",
    build: async () => ({ storage: new MemoryStorage() }),
  },
  {
    label: "local-fs",
    build: async () => {
      const root = await mkdtemp(join(tmpdir(), "baerly-http-cost-"));
      return {
        storage: new LocalFsStorage({ root }),
        cleanup: async () => {
          await rm(root, { recursive: true, force: true }).catch(() => {});
        },
      };
    },
  },
];

const SECRET = "dev-test-secret";
const APP = "tickets";
const TENANT = "t";
const TABLE = "tickets";

/**
 * Bootstrap the `current.json` for one (app, tenant, table) triple.
 * `Writer.commit()` throws `InvalidResponse` when the file is
 * missing — production code provisions it via `claimWriter` /
 * `createCurrentJson` at deploy time; tests do the same. Mirrors
 * `packages/adapter-node/src/server-routes.test.ts`.
 */
const provisionTable = async (storage: Storage): Promise<void> => {
  const key = `app/${APP}/tenant/${TENANT}/manifests/${TABLE}/current.json`;
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "http-cost-shape-test", claimed_at: "" },
    tail_bytes: 0,
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

for (const variant of VARIANTS) {
  describe(`HTTP cost shape (${variant.label})`, () => {
    let server: Server;
    let baseUrl: string;
    let counting: CountingStorage;
    let cleanup: (() => Promise<void>) | undefined;
    let priorDisable: string | undefined;

    beforeAll(async () => {
      // This suite measures the LOGICAL per-verb storage-op cost (a
      // write = 3 PUTs). In-band maintenance is amortized background
      // work whose op cost is covered separately (the write-tick /
      // drain-rate tests) — and on the Node adapter it would fire on
      // the occasional boundary-crossing write, perturbing the count.
      // Disable it for the duration so the per-verb assertions stay
      // pinned to the logical write cost.
      priorDisable = process.env["BAERLY_MAINTENANCE_DISABLE"];
      process.env["BAERLY_MAINTENANCE_DISABLE"] = "1";
      const made = await variant.build();
      cleanup = made.cleanup;
      // Provision the `tickets` table BEFORE wrapping with the
      // counter so the createCurrentJson PUT doesn't pollute the
      // per-verb counts. Provisioning itself is out of scope for
      // the per-verb cost-shape assertions — production deploys
      // call this once at bootstrap.
      await provisionTable(made.storage);
      counting = wrapCountingStorage(made.storage);
      const verifier: Verifier = async (req) => {
        const auth = req.headers.get("authorization") ?? "";
        return auth === `Bearer ${SECRET}` ? { tenantPrefix: TENANT, identity: null } : null;
      };
      // `tenant` mirrors `TENANT` (the prefix the local verifier
      // pins each authorized request to). `auth` is placeholder —
      // the explicit `verifier:` override wins in `resolveVerifier`.
      // `target: "node"` is required on `BaerlyAppConfig` but only
      // read by `baerly deploy` / `baerly doctor`; the runtime
      // adapter ignores it.
      const config: BaerlyAppConfig = {
        app: APP,
        tenant: TENANT,
        target: "node",
        auth: "none",
        collections: {},
      };
      const requestHandler = baerlyNode({
        config,
        storage: counting.storage,
        verifier,
      }).fetch;
      server = createServer(getRequestListener(requestHandler));
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no port");
      }
      baseUrl = `http://127.0.0.1:${addr.port}`;
      // Warmup write so the per-verb assertions measure steady-state
      // cost only — the first write into a fresh prefix may include
      // one-time bootstrap ops (e.g. creating directory entries on
      // local-fs). Counters are reset after the warmup succeeds.
      const provision = await fetch(`${baseUrl}/v1/c/${TABLE}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ doc: { _id: "provision-warmup", title: "warmup" } }),
      });
      expect(provision.status).toBe(201);
      counting.reset();
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cleanup?.();
      if (priorDisable === undefined) {
        delete process.env["BAERLY_MAINTENANCE_DISABLE"];
      } else {
        process.env["BAERLY_MAINTENANCE_DISABLE"] = priorDisable;
      }
    });

    test("POST insert costs exactly 3 PUTs (content + log + CAS), 0 deletes, 0 lists", async () => {
      counting.reset();
      const res = await fetch(`${baseUrl}/v1/c/${TABLE}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ doc: { title: "Login broken", status: "open" } }),
      });
      expect(res.status).toBe(201);
      expect(counting.puts).toBe(3);
      expect(counting.deletes).toBe(0);
      expect(counting.lists).toBe(0);
    });

    test("GET by id costs 0 Class A ops", async () => {
      const insert = await fetch(`${baseUrl}/v1/c/${TABLE}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ doc: { title: "read-cost", status: "open" } }),
      });
      expect(insert.status).toBe(201);
      const { _id } = (await insert.json()) as { _id: string };
      counting.reset();
      for (let i = 0; i < 11; i++) {
        const r = await fetch(`${baseUrl}/v1/c/${TABLE}/${_id}`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        expect(r.status).toBe(200);
      }
      expect(counting.classAOps).toBe(0);
    });

    test("PATCH update costs exactly 3 PUTs, 0 deletes, 0 lists", async () => {
      const insert = await fetch(`${baseUrl}/v1/c/${TABLE}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ doc: { title: "patch-cost", status: "open" } }),
      });
      const { _id } = (await insert.json()) as { _id: string };
      counting.reset();
      const res = await fetch(`${baseUrl}/v1/c/${TABLE}/${_id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ patch: { status: "in-progress" } }),
      });
      expect(res.status).toBe(200);
      expect(counting.puts).toBe(3);
      expect(counting.deletes).toBe(0);
      expect(counting.lists).toBe(0);
    });

    test("DELETE costs exactly 2 PUTs (tombstone + CAS), 0 deletes, 0 lists", async () => {
      const insert = await fetch(`${baseUrl}/v1/c/${TABLE}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ doc: { title: "delete-cost", status: "open" } }),
      });
      const { _id } = (await insert.json()) as { _id: string };
      counting.reset();
      const res = await fetch(`${baseUrl}/v1/c/${TABLE}/${_id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.status).toBe(204);
      expect(counting.puts).toBe(2);
      expect(counting.deletes).toBe(0);
      expect(counting.lists).toBe(0);
    });

    test("401 with no Authorization header writes 0 storage ops", async () => {
      counting.reset();
      const res = await fetch(`${baseUrl}/v1/c/${TABLE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { title: "no-auth" } }),
      });
      expect(res.status).toBe(401);
      expect(counting.classAOps).toBe(0);
    });

    test("401 with bad bearer writes 0 storage ops", async () => {
      counting.reset();
      const res = await fetch(`${baseUrl}/v1/c/${TABLE}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-secret",
        },
        body: JSON.stringify({ doc: { title: "bad-auth" } }),
      });
      expect(res.status).toBe(401);
      expect(counting.classAOps).toBe(0);
    });
  });
}
