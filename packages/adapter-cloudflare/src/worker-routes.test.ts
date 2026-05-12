/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   ticket-06 contract: miniflare's vitest pool sets the global, this file
   reads it. `_id` is the locked primary-key field on document shapes. */

/**
 * `baerlyWorker()` fetch-handler route tests. Runs under the
 * `cloudflare-pool` vitest project (workerd + miniflare) so the
 * `ExecutionContext` / `R2Bucket` types resolve and the R2 binding
 * is real.
 *
 * Covers the Phase-6 CRUD surface end-to-end through the
 * `r2BindingStorage` → `Db` → `createRouter` pipeline.
 */

import { describe, expect, it } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  BaerlyError,
  type Verifier,
} from "@baerly/protocol";
import { r2BindingStorage } from "./r2-binding-storage";
import { baerlyWorker, type Env } from "./worker";

const trivialVerifier: Verifier = async () => ({
  tenantPrefix: "acme",
  identity: { kind: "test" },
});
const denyVerifier: Verifier = async () => null;

const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error("worker-routes.test: globalThis.__BAERLY_R2_BINDING__ missing");
  }
  return bucket;
};

const makeEnv = (bucket: R2Bucket): Env => ({
  BUCKET: bucket,
  APP: "tickets",
  TENANT: "", // ignored when a verifier is supplied
});

const makeCtx = (): ExecutionContext => ({
  waitUntil(): void {},
  passThroughOnException(): void {},
  props: {},
});

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
 * `ServerWriter.commit()` throws `InvalidResponse` when the file is
 * missing — production code provisions it via `claimWriter` /
 * `createCurrentJson` at deploy time. Same shape as the cascade
 * fixtures in `tests/fixtures/table-api-cascade.ts`. The miniflare
 * R2 binding is shared across tests in this suite, so an already-
 * provisioned key surfaces as `Conflict` — adopt it.
 */
const provisionTable = async (bucket: R2Bucket, table: string): Promise<void> => {
  const storage = r2BindingStorage(bucket);
  const key = `app/tickets/tenant/acme/manifests/${table}/current.json`;
  try {
    await createCurrentJson(storage, key, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      writer_fence: { epoch: 0, owner: "worker-routes-test", claimed_at: "" },
    });
  } catch (e) {
    if (e instanceof BaerlyError && e.code === "Conflict") return;
    throw e;
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
  it("GET /v1/healthz returns { ok: true } without consulting the verifier", async () => {
    const worker = baerlyWorker({ verifier: denyVerifier });
    const res = await worker.fetch!(
      asWorkersRequest(new Request("https://x/v1/healthz")),
      makeEnv(getBinding()),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 401 with Unauthorized envelope when the verifier returns null", async () => {
    const worker = baerlyWorker({ verifier: denyVerifier });
    const res = await worker.fetch!(
      asWorkersRequest(new Request("https://x/v1/t/tickets")),
      makeEnv(getBinding()),
      makeCtx(),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as BaseEnvelope;
    expect(body.error?.code).toBe("Unauthorized");
  });

  it("POST → GET round-trips a document", async () => {
    const bucket = getBinding();
    const table = freshTable("tickets");
    await provisionTable(bucket, table);
    const worker = baerlyWorker({ verifier: trivialVerifier });
    const env = makeEnv(bucket);

    const insertRes = await worker.fetch!(
      asWorkersRequest(
        new Request(`https://x/v1/t/${table}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: { title: "first", status: "open" } }),
        }),
      ),
      env,
      makeCtx(),
    );
    expect(insertRes.status).toBe(201);
    const inserted = (await insertRes.json()) as BaseEnvelope;
    const id = inserted._id;
    expect(typeof id).toBe("string");

    const readRes = await worker.fetch!(
      asWorkersRequest(new Request(`https://x/v1/t/${table}/${id!}`)),
      env,
      makeCtx(),
    );
    expect(readRes.status).toBe(200);
    const read = (await readRes.json()) as { data: { _id: string; title: string } };
    expect(read.data._id).toBe(id);
    expect(read.data.title).toBe("first");
  });

  it("PATCH on unknown id returns 404 with the HttpErrorEnvelope shape", async () => {
    const bucket = getBinding();
    const table = freshTable("tickets");
    await provisionTable(bucket, table);
    const worker = baerlyWorker({ verifier: trivialVerifier });
    const env = makeEnv(bucket);
    const res = await worker.fetch!(
      asWorkersRequest(
        new Request(`https://x/v1/t/${table}/does-not-exist`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patch: { status: "closed" } }),
        }),
      ),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as BaseEnvelope;
    expect(body.error?.code).toBeDefined();
  });

  it("DELETE returns 204 the first time, 404 the second time", async () => {
    const bucket = getBinding();
    const table = freshTable("tickets");
    await provisionTable(bucket, table);
    const worker = baerlyWorker({ verifier: trivialVerifier });
    const env = makeEnv(bucket);

    const insertRes = await worker.fetch!(
      asWorkersRequest(
        new Request(`https://x/v1/t/${table}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: { title: "deleteme" } }),
        }),
      ),
      env,
      makeCtx(),
    );
    const { _id: id } = (await insertRes.json()) as BaseEnvelope;

    const firstRes = await worker.fetch!(
      asWorkersRequest(new Request(`https://x/v1/t/${table}/${id!}`, { method: "DELETE" })),
      env,
      makeCtx(),
    );
    expect(firstRes.status).toBe(204);

    const secondRes = await worker.fetch!(
      asWorkersRequest(new Request(`https://x/v1/t/${table}/${id!}`, { method: "DELETE" })),
      env,
      makeCtx(),
    );
    expect(secondRes.status).toBe(404);
  });

  it("GET /v1/t/:table?where=<json> returns the predicate-matched subset", async () => {
    const bucket = getBinding();
    const table = freshTable("tickets");
    await provisionTable(bucket, table);
    const worker = baerlyWorker({ verifier: trivialVerifier });
    const env = makeEnv(bucket);

    for (const ticket of [
      { title: "a", status: "open" },
      { title: "b", status: "open" },
      { title: "c", status: "closed" },
    ]) {
      const res = await worker.fetch!(
        asWorkersRequest(
          new Request(`https://x/v1/t/${table}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ doc: ticket }),
          }),
        ),
        env,
        makeCtx(),
      );
      expect(res.status).toBe(201);
    }

    const where = encodeURIComponent(JSON.stringify({ status: "open" }));
    const listRes = await worker.fetch!(
      asWorkersRequest(new Request(`https://x/v1/t/${table}?where=${where}`)),
      env,
      makeCtx(),
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: Array<{ status: string }> };
    expect(list.data).toHaveLength(2);
    for (const row of list.data) expect(row.status).toBe("open");
  });

  it("GET /v1/t/:table?where=notjson returns 400 SchemaError", async () => {
    const worker = baerlyWorker({ verifier: trivialVerifier });
    const res = await worker.fetch!(
      asWorkersRequest(new Request("https://x/v1/t/tickets?where=notjson")),
      makeEnv(getBinding()),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as BaseEnvelope;
    expect(body.error?.code).toBe("SchemaError");
  });
});
