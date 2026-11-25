/**
 * `baerlyWorker()` fetch-handler route tests. Runs under the
 * `cloudflare-pool` vitest project (workerd + miniflare) so the
 * `ExecutionContext` / `R2Bucket` types resolve and the R2 binding
 * is real.
 *
 * Covers the CRUD surface end-to-end through the
 * `r2BindingStorage` → `Db` → `createRouter` pipeline.
 */

import { describe, expect, test } from "vitest";
import {
  type BaerlyAppConfig,
  BaerlyError,
  type SchemaValidator,
  type Verifier,
} from "@baerly/protocol";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { baerlyWorker, type BaerlyEnv } from "./worker.ts";
import { mockExecutionContext } from "../../../tests/fixtures/mock-execution-context.ts";
import { provisionCollection } from "../../../tests/fixtures/log-state.ts";
import { trivialVerifier, denyVerifier } from "../../../tests/fixtures/test-verifier.ts";
import { getBinding } from "../../../tests/fixtures/r2-bucket.ts";

/**
 * Baseline `BaerlyAppConfig` for the route tests. Cases that exercise
 * a real `verifier:` override don't care about `auth` — the override
 * wins in `resolveVerifier`. Cases that exercise `config.auth`
 * synthesis (the dedicated suite below) declare their own config
 * inline.
 */
const baseConfig: BaerlyAppConfig = {
  app: "tickets",
  tenant: "acme",
  target: "cloudflare",
  auth: "none",
  collections: {},
};

const makeEnv = (bucket: R2Bucket): BaerlyEnv => ({
  BUCKET: bucket,
  APP: "tickets",
});

const makeCtx = (): ExecutionContext => mockExecutionContext();

/**
 * `worker.fetch` is typed against `Request<unknown,
 * IncomingRequestCfProperties>` (Workers-Types-style) — the inbound
 * request shape Cloudflare hands to the runtime. Our tests construct
 * plain WHATWG `Request`s; the cast bridges the typing gap and is
 * benign because the worker code never reads `request.cf`.
 */
const asWorkersRequest = (r: Request): Request<unknown, IncomingRequestCfProperties> =>
  r as unknown as Request<unknown, IncomingRequestCfProperties>;

interface BaseEnvelope {
  readonly error?: { readonly code: string; readonly message: string };
  readonly data?: unknown;
  readonly _id?: string;
}

/**
 * Bootstrap the `current.json` for one (app, tenant, table) triple.
 * `Writer.commit()` throws `InvalidResponse` when the file is
 * missing — production code provisions it via
 * `createCurrentJson` at deploy time. Same shape as the cascade
 * fixtures in `tests/fixtures/collection-api-cascade.ts`. The miniflare
 * R2 binding is shared across tests in this suite, so an already-
 * provisioned key surfaces as `WriteConflict` — adopt it.
 */
const provisionTable = async (bucket: R2Bucket, table: string, tenant = "acme"): Promise<void> => {
  const storage = r2BindingStorage(bucket);
  const key = `app/tickets/tenant/${tenant}/manifests/${table}/current.json`;
  try {
    await provisionCollection(storage, key, "worker-routes-test");
  } catch (error) {
    if (error instanceof BaerlyError && error.code === "WriteConflict") {
      return;
    }
    throw error;
  }
};

/**
 * Pick a fresh table name per test so the shared miniflare R2
 * binding doesn't accumulate state across cases.
 */
const freshTable = (() => {
  let n = 0;
  return (prefix: string): string => `${prefix}-${++n}-${Date.now().toString(36)}`;
})();

describe("baerlyWorker routes", () => {
  test("baerlyWorker without a config is a type error", () => {
    // The `config` field is required on `BaerlyWorkerOptions` — the
    // adapter needs `config.auth` / `config.tenant` to synthesize a
    // `Verifier` when none is supplied, and `config.collections`
    // for schema/index wiring. Omitting it must fail at type-check
    // time.
    // @ts-expect-error config is required
    baerlyWorker(() => ({}));
  });
});

describe("baerlyWorker config wiring", () => {
  // StandardSchema-shaped validator that rejects `status === "invalid"`.
  // Hand-written so this suite stays free of zod/valibot deps; same
  // `~standard.validate` seam those libraries expose at runtime.
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

  test("server-side schema fires on POST when collections.<table>.schema is declared", async () => {
    const bucket = getBinding();
    const table = freshTable("tickets");
    await provisionTable(bucket, table);
    const config: BaerlyAppConfig = {
      ...baseConfig,
      collections: { [table]: { schema: statusValidator } },
    };
    const worker = baerlyWorker(() => ({ verifier: trivialVerifier, config }));
    const env = makeEnv(bucket);

    const goodRes = await worker.fetch!(
      asWorkersRequest(
        new Request(`https://x/v1/c/${table}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: { title: "ok", status: "open" } }),
        }),
      ),
      env,
      makeCtx(),
    );
    expect(goodRes.status).toBe(201);

    const badRes = await worker.fetch!(
      asWorkersRequest(
        new Request(`https://x/v1/c/${table}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: { title: "bad", status: "invalid" } }),
        }),
      ),
      env,
      makeCtx(),
    );
    expect(badRes.status).toBe(400);
    const body = (await badRes.json()) as BaseEnvelope;
    expect(body.error?.code).toBe("SchemaError");
  });

  test("declared schema has no effect when config is not passed (regression guard)", async () => {
    // Pins the bug the wiring fixes: declaring schemas in
    // baerly.config.ts is inert through the adapter path unless
    // the adapter is told about them.
    const bucket = getBinding();
    const table = freshTable("tickets");
    await provisionTable(bucket, table);
    const worker = baerlyWorker(() => ({ verifier: trivialVerifier, config: baseConfig }));
    const env = makeEnv(bucket);

    const res = await worker.fetch!(
      asWorkersRequest(
        new Request(`https://x/v1/c/${table}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: { title: "bad", status: "invalid" } }),
        }),
      ),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(201);
  });
});

describe("baerlyWorker dev landing", () => {
  test("GET / with dev option returns 200 HTML containing the UI link", async () => {
    // denyVerifier proves the dev short-circuit runs ahead of auth —
    // a 401 here would mean the landing path wasn't taken.
    const worker = baerlyWorker(() => ({
      verifier: denyVerifier,
      config: baseConfig,
      dev: { app: "tickets", uiUrl: "http://localhost:5173" },
    }));
    const res = await worker.fetch!(
      asWorkersRequest(new Request("https://x/")),
      makeEnv(getBinding()),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<code>tickets</code>");
    expect(html).toContain(`href="http://localhost:5173"`);
  });

  test("GET /favicon.ico with dev option returns 204 with empty body", async () => {
    const worker = baerlyWorker(() => ({
      verifier: denyVerifier,
      config: baseConfig,
      dev: { app: "tickets", uiUrl: "http://localhost:5173" },
    }));
    const res = await worker.fetch!(
      asWorkersRequest(new Request("https://x/favicon.ico")),
      makeEnv(getBinding()),
      makeCtx(),
    );
    expect(res.status).toBe(204);
    await expect(res.text()).resolves.toBe("");
  });

  test("GET / without dev option falls through to the verifier (401)", async () => {
    const worker = baerlyWorker(() => ({ verifier: denyVerifier, config: baseConfig }));
    const res = await worker.fetch!(
      asWorkersRequest(new Request("https://x/")),
      makeEnv(getBinding()),
      makeCtx(),
    );
    expect(res.status).toBe(401);
  });

  test("POST / with dev option falls through to the verifier (no method-bypass)", async () => {
    const worker = baerlyWorker(() => ({
      verifier: denyVerifier,
      config: baseConfig,
      dev: { app: "tickets", uiUrl: "http://localhost:5173" },
    }));
    const res = await worker.fetch!(
      asWorkersRequest(new Request("https://x/", { method: "POST", body: "" })),
      makeEnv(getBinding()),
      makeCtx(),
    );
    expect(res.status).toBe(401);
  });

  test("GET /v1/spec serves the static IR when the verifier throws", async () => {
    const throwingVerifier: Verifier = async () => {
      throw new Error("jwks unavailable");
    };
    const worker = baerlyWorker(() => ({
      config: { ...baseConfig, collections: { notes: {} } },
      verifier: throwingVerifier,
    }));
    const res = await worker.fetch!(
      asWorkersRequest(new Request("https://example.com/v1/spec")),
      makeEnv(getBinding()),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["specVersion"]).toBe("1");
    expect("collections" in body).toBe(false);
  });

  test("GET /v1/spec serves the static IR when auth resolution fails", async () => {
    const worker = baerlyWorker(() => ({
      config: { ...baseConfig, auth: "shared-secret", collections: { notes: {} } },
    }));
    const res = await worker.fetch!(
      asWorkersRequest(new Request("https://example.com/v1/spec")),
      makeEnv(getBinding()),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["specVersion"]).toBe("1");
    expect("collections" in body).toBe(false);
  });
});
