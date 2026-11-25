/**
 * Node listener — `createApp` config wiring over a real `http.Server`
 * driven by `createApp` → `getRequestListener`. The `withServer` helper
 * boots `createServer(getRequestListener(app.fetch)).listen(0)` so each
 * test gets an isolated socket and an isolated `MemoryStorage`-backed
 * `Db`. The CRUD / status-code matrix is covered by the shared HTTP
 * conformance cascade (`tests/fixtures/http-conformance-cascade.ts`).
 */

import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type BaerlyConfig,
  MemoryStorage,
  type SchemaValidator,
  type Storage,
  type Verifier,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";
import { provisionCollection } from "../../../tests/fixtures/log-state.ts";
import { trivialVerifier } from "../../../tests/fixtures/test-verifier.ts";

interface BaseEnvelope {
  readonly error?: { readonly code: string; readonly message: string };
  readonly data?: unknown;
  readonly _id?: string;
}

/**
 * Bootstrap the `current.json` for one (app, tenant, table) triple.
 * `Writer.commit()` throws `InvalidResponse` when the file is
 * missing — production code provisions it via
 * `createCurrentJson` at deploy time; the cascade test fixtures do
 * the same. Mirrors `tests/fixtures/collection-api-cascade.ts`.
 */
const provisionTable = async (storage: Storage, table: string): Promise<void> => {
  const key = `app/tickets/tenant/acme/manifests/${table}/current.json`;
  await provisionCollection(storage, key, "server-routes-test");
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
