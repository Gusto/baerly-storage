/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; the HTTP body wraps the
   server's `{ _id }` response and re-encodes it as JSON. */

/**
 * Node listener — CRUD route tests over a real `http.Server`
 * driven by `createApp` → `getRequestListener`. The `withServer`
 * helper boots `createServer(getRequestListener(app.fetch)).listen(0)`
 * so each test gets an isolated socket and an isolated
 * `MemoryStorage`-backed `Db`.
 *
 * Covers the full status-code matrix from `contract.ts:57-69`:
 *   - 200 OK (read / list / patch)
 *   - 201 Created (insert)
 *   - 204 No Content (delete)
 *   - 400 SchemaError (bad `?where=`, bad JSON body)
 *   - 401 Unauthorized (verifier returned null)
 *   - 404 NotFound (no such row)
 *   - 413 PayloadTooLarge (oversized body, enforced during the
 *     `node:http` stream pump so the Node process never materializes
 *     a multi-MiB body for the router to reject after the fact)
 */

import { getRequestListener } from "@hono/node-server";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type BaerlyConfig,
  CURRENT_JSON_SCHEMA_VERSION,
  MemoryStorage,
  createCurrentJson,
  type SchemaValidator,
  type Storage,
  type Verifier,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";

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
 * `Writer.commit()` throws `InvalidResponse` when the file is
 * missing — production code provisions it via `claimWriter` /
 * `createCurrentJson` at deploy time; the cascade test fixtures do
 * the same. Mirrors `tests/fixtures/collection-api-cascade.ts`.
 */
const provisionTable = async (storage: Storage, table: string): Promise<void> => {
  const key = `app/tickets/tenant/acme/manifests/${table}/current.json`;
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "server-routes-test", claimed_at: "" },
  });
};

const withServer = async <T>(
  verifier: Verifier,
  body: (baseUrl: string, storage: Storage) => Promise<T>,
  opts: { config?: BaerlyConfig } = {},
): Promise<T> => {
  const storage = new MemoryStorage();
  const app = createApp({
    app: "tickets",
    storage,
    verifier,
    ...(opts.config !== undefined && { config: opts.config }),
  });
  const server = createServer(getRequestListener(app.fetch));
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

describe("createApp routes", () => {
  test("GET /v1/healthz returns { ok: true } without consulting the verifier", async () => {
    await withServer(denyVerifier, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/healthz`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
    });
  });

  test("returns 401 with Unauthorized envelope when the verifier returns null", async () => {
    await withServer(denyVerifier, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/c/tickets`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as BaseEnvelope;
      expect(body.error?.code).toBe("Unauthorized");
      expect(body.error?.message).toBe("Missing or invalid Authorization header");
    });
  });

  test("POST → GET round-trips a document", async () => {
    await withServer(trivialVerifier, async (baseUrl, storage) => {
      await provisionTable(storage, "tickets");
      const insertRes = await fetch(`${baseUrl}/v1/c/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { title: "first", status: "open" } }),
      });
      expect(insertRes.status).toBe(201);
      const inserted = (await insertRes.json()) as BaseEnvelope;
      expect(typeof inserted._id).toBe("string");
      const id = inserted._id!;

      const readRes = await fetch(`${baseUrl}/v1/c/tickets/${id}`);
      expect(readRes.status).toBe(200);
      const read = (await readRes.json()) as { data: { _id: string; title: string } };
      expect(read.data._id).toBe(id);
      expect(read.data.title).toBe("first");
    });
  });

  test("PATCH on unknown id returns 404; PATCH on known id returns 200 { modified: 1 }", async () => {
    await withServer(trivialVerifier, async (baseUrl, storage) => {
      await provisionTable(storage, "tickets");
      const missingRes = await fetch(`${baseUrl}/v1/c/tickets/does-not-exist`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { status: "closed" } }),
      });
      expect(missingRes.status).toBe(404);

      const insertRes = await fetch(`${baseUrl}/v1/c/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { title: "patchme", status: "open" } }),
      });
      const { _id: id } = (await insertRes.json()) as BaseEnvelope;
      const patchRes = await fetch(`${baseUrl}/v1/c/tickets/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { status: "closed" } }),
      });
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as { modified: number };
      expect(patched.modified).toBe(1);
    });
  });

  test("DELETE returns 204 the first time, 404 the second time", async () => {
    await withServer(trivialVerifier, async (baseUrl, storage) => {
      await provisionTable(storage, "tickets");
      const insertRes = await fetch(`${baseUrl}/v1/c/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { title: "deleteme" } }),
      });
      const { _id: id } = (await insertRes.json()) as BaseEnvelope;

      const firstRes = await fetch(`${baseUrl}/v1/c/tickets/${id}`, { method: "DELETE" });
      expect(firstRes.status).toBe(204);

      const secondRes = await fetch(`${baseUrl}/v1/c/tickets/${id}`, { method: "DELETE" });
      expect(secondRes.status).toBe(404);
    });
  });

  test("POST with body over 1 MiB returns 413 PayloadTooLarge", async () => {
    await withServer(trivialVerifier, async (baseUrl) => {
      // 1.5 MiB filler — comfortably over the 1-MiB cap. No table
      // provisioning needed: the body-size guard short-circuits
      // before any Storage I/O. `fetch()` here sets `Content-Length`,
      // so the router's pre-check fires before the stream pump runs;
      // the chunked-transfer test below exercises the pump path.
      const filler = "x".repeat(1.5 * 1024 * 1024);
      const res = await fetch(`${baseUrl}/v1/c/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { title: "huge", filler } }),
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as BaseEnvelope;
      expect(body.error?.code).toBe("PayloadTooLarge");
    });
  });

  test("chunked POST over 1 MiB returns 413 PayloadTooLarge from the stream pump", async () => {
    await withServer(trivialVerifier, async (baseUrl) => {
      // `fetch()` would auto-set `Content-Length` and trigger the
      // router's pre-materialization check at `router.ts:readJsonBody`
      // header path. To exercise `readNodeStream`'s in-pump cap (the
      // load-bearing OOM guard) we use `node:http` directly with
      // `Transfer-Encoding: chunked` and no `Content-Length`.
      const url = new URL(baseUrl);
      const status = await new Promise<{ code: number; envCode: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: url.hostname,
            port: url.port,
            method: "POST",
            path: "/v1/c/tickets",
            headers: {
              "content-type": "application/json",
              "transfer-encoding": "chunked",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BaseEnvelope;
              resolve({ code: res.statusCode ?? 0, envCode: parsed.error?.code ?? "" });
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        // Write 1.5 MiB across many small chunks so the cap trips
        // mid-pump (not on the first chunk). 96 KiB × 16 = 1.5 MiB.
        const chunk = "x".repeat(96 * 1024);
        req.write(`{"doc":{"filler":"`);
        for (let i = 0; i < 16; i += 1) {
          req.write(chunk);
        }
        req.write(`"}}`);
        req.end();
      });
      expect(status.code).toBe(413);
      expect(status.envCode).toBe("PayloadTooLarge");
    });
  });

  test("GET /v1/c/:collection?where=notjson returns 400 SchemaError", async () => {
    await withServer(trivialVerifier, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/c/tickets?where=notjson`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as BaseEnvelope;
      expect(body.error?.code).toBe("SchemaError");
    });
  });

  test("GET /v1/c/:collection?where=<malformed wire> returns 400 (wire validator rejects)", async () => {
    await withServer(trivialVerifier, async (baseUrl) => {
      // Post-redesign `?where=` carries a wire-form predicate; the
      // wire validator rejects anything lacking a `clauses` array.
      const where = encodeURIComponent(JSON.stringify({ $or: 1 }));
      const res = await fetch(`${baseUrl}/v1/c/tickets?where=${where}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as BaseEnvelope;
      expect(body.error?.code).toBe("InvalidConfig");
    });
  });

  test("GET / without dev option returns 401 (Unauthorized — falls through to verifier path)", async () => {
    // Without `dev`, the listener has no `GET /` handler. The
    // request flows to the verifier; `denyVerifier` answers 401.
    // (With `trivialVerifier` the router itself would 404.)
    await withServer(denyVerifier, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(401);
    });
  });

  test("GET /v1/c/:collection?where=<json> returns matching subset", async () => {
    await withServer(trivialVerifier, async (baseUrl, storage) => {
      await provisionTable(storage, "tickets");
      // Seed three rows; two open, one closed.
      for (const ticket of [
        { title: "a", status: "open" },
        { title: "b", status: "open" },
        { title: "c", status: "closed" },
      ]) {
        const res = await fetch(`${baseUrl}/v1/c/tickets`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: ticket }),
        });
        expect(res.status).toBe(201);
      }

      const where = encodeURIComponent(
        JSON.stringify({ clauses: [{ op: "eq", field: "status", value: "open" }] }),
      );
      const listRes = await fetch(`${baseUrl}/v1/c/tickets?where=${where}`);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { data: Array<{ status: string }> };
      expect(list.data).toHaveLength(2);
      for (const row of list.data) {
        expect(row.status).toBe("open");
      }
    });
  });
});

describe("createApp config wiring", () => {
  // StandardSchema-shaped validator that rejects `status === "invalid"`.
  // Hand-written to keep this test free of zod/valibot test deps;
  // exercises the same `~standard.validate` seam those libraries
  // expose at runtime.
  const statusValidator: SchemaValidator = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (input) => {
        const doc = input as { status?: unknown };
        if (doc.status === "invalid") {
          return { issues: [{ path: ["status"], message: "status must not be 'invalid'" }] };
        }
        return { value: input };
      },
    },
  };
  const configWithSchema: BaerlyConfig = {
    collections: { tickets: { schema: statusValidator } },
  };

  test("server-side schema fires on POST when collections.<table>.schema is declared", async () => {
    await withServer(
      trivialVerifier,
      async (baseUrl, storage) => {
        await provisionTable(storage, "tickets");

        const goodRes = await fetch(`${baseUrl}/v1/c/tickets`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: { title: "ok", status: "open" } }),
        });
        expect(goodRes.status).toBe(201);

        const badRes = await fetch(`${baseUrl}/v1/c/tickets`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: { title: "bad", status: "invalid" } }),
        });
        expect(badRes.status).toBe(400);
        const body = (await badRes.json()) as BaseEnvelope;
        expect(body.error?.code).toBe("SchemaError");
      },
      { config: configWithSchema },
    );
  });

  test("declared schema has no effect when config is not passed (regression guard)", async () => {
    // Without `config`, the same "invalid" doc that's rejected above
    // commits silently — the test pins the bug the wiring fixes:
    // declaring schemas in baerly.config.ts is inert through the
    // adapter path unless the adapter is told about them.
    await withServer(trivialVerifier, async (baseUrl, storage) => {
      await provisionTable(storage, "tickets");
      const res = await fetch(`${baseUrl}/v1/c/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { title: "bad", status: "invalid" } }),
      });
      expect(res.status).toBe(201);
    });
  });
});

describe("createApp dev landing", () => {
  const withDevServer = async <T>(body: (baseUrl: string) => Promise<T>): Promise<T> => {
    const storage = new MemoryStorage();
    // `denyVerifier` proves the landing-page short-circuit runs
    // ahead of the verifier — a 401 here would mean the dev path
    // wasn't taken.
    const app = createApp({
      app: "tickets",
      storage,
      verifier: denyVerifier,
      dev: { app: "tickets", uiUrl: "http://localhost:5173" },
    });
    const server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    try {
      return await body(`http://127.0.0.1:${address.port}`);
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

  test("GET / with dev option returns 200 HTML containing the UI link", async () => {
    await withDevServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html).toContain("<code>tickets</code>");
      expect(html).toContain(`href="http://localhost:5173"`);
    });
  });

  test("GET /favicon.ico with dev option returns 204 with empty body", async () => {
    await withDevServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/favicon.ico`);
      expect(res.status).toBe(204);
      await expect(res.text()).resolves.toBe("");
    });
  });

  test("POST / with dev option falls through to the verifier (no method-bypass)", async () => {
    await withDevServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`, { method: "POST", body: "" });
      // denyVerifier answers 401 — the dev short-circuit is GET-only.
      expect(res.status).toBe(401);
    });
  });
});
