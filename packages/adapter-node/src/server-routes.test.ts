/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; the HTTP body wraps the
   server's `{ _id }` response and re-encodes it as JSON. */

/**
 * Node listener — Phase-6 CRUD route tests over a real
 * `http.Server`. The `withServer` helper boots
 * `createServer(listener).listen(0)` so each test gets an
 * isolated socket and an isolated `MemoryStorage`-backed `Db`.
 *
 * Covers the full status-code matrix from `contract.ts:57-69`:
 *   - 200 OK (read / list / patch)
 *   - 201 Created (insert)
 *   - 204 No Content (delete)
 *   - 400 SchemaError (bad `?where=`, oversized body, bad JSON body)
 *   - 401 Unauthorized (verifier returned null)
 *   - 404 Not Found (no such row)
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  MemoryStorage,
  createCurrentJson,
  type Storage,
  type Verifier,
} from "@baerly/protocol";
import { describe, expect, it } from "vitest";
import { createListener } from "./server";

const trivialVerifier: Verifier = async () => ({
  tenantPrefix: "acme",
  identity: { kind: "test" },
});
const denyVerifier: Verifier = async () => null;

interface BaseEnvelope {
  readonly error?: { readonly code: string; readonly message: string };
  readonly data?: unknown;
  readonly _id?: string;
}

/**
 * Bootstrap the `current.json` for one (app, tenant, table) triple.
 * `ServerWriter.commit()` throws `InvalidResponse` when the file is
 * missing — production code provisions it via `claimWriter` /
 * `createCurrentJson` at deploy time; the cascade test fixtures do
 * the same. Mirrors `tests/fixtures/table-api-cascade.ts`.
 */
const provisionTable = async (storage: Storage, table: string): Promise<void> => {
  const key = `app/tickets/tenant/acme/manifests/${table}/current.json`;
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    writer_fence: { epoch: 0, owner: "server-routes-test", claimed_at: "" },
  });
};

const withServer = async <T>(
  verifier: Verifier,
  body: (baseUrl: string, storage: Storage) => Promise<T>,
): Promise<T> => {
  const storage = new MemoryStorage();
  const listener = createListener({ app: "tickets", storage, verifier });
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  try {
    return await body(`http://127.0.0.1:${address.port}`, storage);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
};

describe("createListener routes", () => {
  it("GET /v1/healthz returns { ok: true } without consulting the verifier", async () => {
    await withServer(denyVerifier, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it("returns 401 with Unauthorized envelope when the verifier returns null", async () => {
    await withServer(denyVerifier, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/t/tickets`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as BaseEnvelope;
      expect(body.error?.code).toBe("Unauthorized");
    });
  });

  it("POST → GET round-trips a document", async () => {
    await withServer(trivialVerifier, async (baseUrl, storage) => {
      await provisionTable(storage, "tickets");
      const insertRes = await fetch(`${baseUrl}/v1/t/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { title: "first", status: "open" } }),
      });
      expect(insertRes.status).toBe(201);
      const inserted = (await insertRes.json()) as BaseEnvelope;
      expect(typeof inserted._id).toBe("string");
      const id = inserted._id!;

      const readRes = await fetch(`${baseUrl}/v1/t/tickets/${id}`);
      expect(readRes.status).toBe(200);
      const read = (await readRes.json()) as { data: { _id: string; title: string } };
      expect(read.data._id).toBe(id);
      expect(read.data.title).toBe("first");
    });
  });

  it("PATCH on unknown id returns 404; PATCH on known id returns 200 { data: { modified: 1 } }", async () => {
    await withServer(trivialVerifier, async (baseUrl, storage) => {
      await provisionTable(storage, "tickets");
      const missingRes = await fetch(`${baseUrl}/v1/t/tickets/does-not-exist`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { status: "closed" } }),
      });
      expect(missingRes.status).toBe(404);

      const insertRes = await fetch(`${baseUrl}/v1/t/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { title: "patchme", status: "open" } }),
      });
      const { _id: id } = (await insertRes.json()) as BaseEnvelope;
      const patchRes = await fetch(`${baseUrl}/v1/t/tickets/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { status: "closed" } }),
      });
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as { data: { modified: number } };
      expect(patched.data.modified).toBe(1);
    });
  });

  it("DELETE returns 204 the first time, 404 the second time", async () => {
    await withServer(trivialVerifier, async (baseUrl, storage) => {
      await provisionTable(storage, "tickets");
      const insertRes = await fetch(`${baseUrl}/v1/t/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { title: "deleteme" } }),
      });
      const { _id: id } = (await insertRes.json()) as BaseEnvelope;

      const firstRes = await fetch(`${baseUrl}/v1/t/tickets/${id}`, { method: "DELETE" });
      expect(firstRes.status).toBe(204);

      const secondRes = await fetch(`${baseUrl}/v1/t/tickets/${id}`, { method: "DELETE" });
      expect(secondRes.status).toBe(404);
    });
  });

  it("POST with body over 1 MiB returns 400 SchemaError", async () => {
    await withServer(trivialVerifier, async (baseUrl) => {
      // 1.5 MiB filler — comfortably over the 1-MiB cap. No table
      // provisioning needed: the body-size guard short-circuits
      // before any Storage I/O.
      const filler = "x".repeat(1.5 * 1024 * 1024);
      const res = await fetch(`${baseUrl}/v1/t/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { title: "huge", filler } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as BaseEnvelope;
      expect(body.error?.code).toBe("SchemaError");
    });
  });

  it("GET /v1/t/:table?where=notjson returns 400 SchemaError", async () => {
    await withServer(trivialVerifier, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/t/tickets?where=notjson`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as BaseEnvelope;
      expect(body.error?.code).toBe("SchemaError");
    });
  });

  it("GET /v1/t/:table?where=<$-prefixed-key> returns 400 (predicate validator rejects)", async () => {
    await withServer(trivialVerifier, async (baseUrl) => {
      // `{"$or":1}` — `$`-prefixed keys are rejected by validatePredicate.
      const where = encodeURIComponent(JSON.stringify({ $or: 1 }));
      const res = await fetch(`${baseUrl}/v1/t/tickets?where=${where}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as BaseEnvelope;
      expect(body.error?.code).toBe("InvalidConfig");
    });
  });

  it("GET /v1/t/:table?where=<json> returns matching subset", async () => {
    await withServer(trivialVerifier, async (baseUrl, storage) => {
      await provisionTable(storage, "tickets");
      // Seed three rows; two open, one closed.
      for (const ticket of [
        { title: "a", status: "open" },
        { title: "b", status: "open" },
        { title: "c", status: "closed" },
      ]) {
        const res = await fetch(`${baseUrl}/v1/t/tickets`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: ticket }),
        });
        expect(res.status).toBe(201);
      }

      const where = encodeURIComponent(JSON.stringify({ status: "open" }));
      const listRes = await fetch(`${baseUrl}/v1/t/tickets?where=${where}`);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { data: Array<{ status: string }> };
      expect(list.data).toHaveLength(2);
      for (const row of list.data) expect(row.status).toBe("open");
    });
  });
});
