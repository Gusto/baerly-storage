/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   miniflare-pool ↔ test contract: `tests/setup/r2-binding.ts` sets the
   global, this file reads it. `_id` is the locked primary-key field on
   document shapes. */

/**
 * `baerlyWorker()` adapter tests. Runs under the `cloudflare-pool`
 * vitest project (workerd + miniflare) so the `ExecutionContext` /
 * `ScheduledController` types resolve and the R2 binding is real.
 */

import {
  type BaerlyAppConfig,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  SHARED_SECRET_MISSING_MESSAGE,
  type Verifier,
} from "@baerly/protocol";
import { getConfig, reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, describe, expect, test } from "vitest";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { baerlyWorker, type BaerlyEnv } from "./worker.ts";
import { mockExecutionContext } from "../../../tests/fixtures/mock-execution-context.ts";

/**
 * Minimal-shape `BaerlyAppConfig` for tests that aren't exercising
 * the resolver branches. Most cases pin a real `Verifier` via
 * `verifier:` so the `auth` field here is effectively a placeholder —
 * the override branch in `resolveVerifier` wins.
 */
const testConfig: BaerlyAppConfig = {
  app: "test-app",
  tenant: "test-tenant",
  target: "cloudflare",
  auth: "none",
  collections: {},
};

const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error("worker.test: globalThis.__BAERLY_R2_BINDING__ missing — wired by vitest pool");
  }
  return bucket;
};

const scheduledOnlyVerifier: Verifier = async () => ({
  tenantPrefix: "x",
  identity: { kind: "scheduled-test" },
});

const makeScheduledEvent = (): ScheduledController => ({
  scheduledTime: Date.UTC(2026, 0, 1, 0, 0, 0),
  cron: "* * * * *",
  noRetry(): void {},
});

const makeNoopCtx = (): ExecutionContext => mockExecutionContext();

describe("baerlyWorker scheduled", () => {
  test("no-ops when `options.scheduled` is unset", async () => {
    const bucket = getBinding();
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const handler = baerlyWorker(() => ({ verifier: scheduledOnlyVerifier, config: testConfig }));
    await expect(
      handler.scheduled!(makeScheduledEvent(), env, makeNoopCtx()),
    ).resolves.toBeUndefined();

    // Nothing was written anywhere.
    const listed = await bucket.list({ prefix: "" });
    expect(listed.objects).toHaveLength(0);
  });

  test("invokes `options.scheduled` with the event/env/ctx triple", async () => {
    const bucket = getBinding();
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const calls: Array<[ScheduledController, BaerlyEnv, ExecutionContext]> = [];
    const handler = baerlyWorker(() => ({
      config: testConfig,
      verifier: scheduledOnlyVerifier,
      scheduled: (event, e, c) => {
        calls.push([event, e, c]);
      },
    }));
    const event = makeScheduledEvent();
    const ctx = makeNoopCtx();
    await handler.scheduled!(event, env, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(event);
    expect(calls[0]![1]).toBe(env);
    expect(calls[0]![2]).toBe(ctx);
  });
});

/**
 * Per-request observability suite. Verifies that the
 * `observability:` option lazy-configures LogTape, the per-request
 * canonical line carries kernel-emitted metrics (class-A ops,
 * cas_attempts, outcome), and the `scheduled()` handler emits its
 * own maintenance canonical line.
 *
 * The collecting sink pattern mirrors Dispatch 2/3: feed a
 * `Sink` capture into the adapter, drive a request, inspect
 * `records[].properties` for the canonical line.
 *
 * Workerd-quirk: a single test process is one isolate, and
 * LogTape's `configure({ reset: true })` re-globals on every call,
 * so an `afterEach(reset)` is enough to isolate cases.
 */
describe("baerlyWorker observability", () => {
  afterEach(async () => {
    await reset();
  });

  const collectingSink = (): { records: LogRecord[]; sink: Sink } => {
    const records: LogRecord[] = [];
    const sink: Sink = (record) => records.push(record);
    return { records, sink };
  };

  const findCanonical = (records: readonly LogRecord[], unit: string): LogRecord | undefined =>
    records.find(
      (r) => r.message.join("") === "canonical" && r.category.join(".") === `baerly.${unit}`,
    );

  test("emits a canonical line for a write request with class_a_ops and outcome=committed", async () => {
    const bucket = getBinding();
    const { records, sink } = collectingSink();
    const tenant = `obs-write-${Date.now().toString(36)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    // Provision current.json for the target table.
    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "obs-write-test", claimed_at: "" },
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });

    const handler = baerlyWorker(() => ({
      config: testConfig,
      verifier,
      observability: { level: "debug", sink },
    }));
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const ctx = mockExecutionContext();

    const res = await handler.fetch!(
      new Request("https://x/v1/c/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "obs-write-1", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    expect(res.status).toBe(201);

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["outcome"]).toBe("committed");
    expect(props["status"]).toBe(201);
    expect(props["method"]).toBe("POST");
    // Storage class-A counter is the load-bearing signal that the
    // tee wiring is in place. Under single-write commit the writer PUTs
    // content + the committing log/<seq> create (no current.json write)
    // ⇒ at least 2 Class A ops per commit.
    const classA = props["db.storage.class_a_ops_total"];
    expect(typeof classA).toBe("number");
    expect(classA).toBeGreaterThanOrEqual(2);
  });

  test("cache-miss read emits a canonical line with class_b_ops>0, outcome=read, cache_status=miss", async () => {
    const bucket = getBinding();
    const tenant = `obs-miss-${Date.now().toString(36)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "obs-miss-test", claimed_at: "" },
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });

    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const makeExec = (): ExecutionContext => mockExecutionContext();

    // Seed one doc via a sink-less handler so the GET below has a
    // body to fetch (per-doc URLs are the only cached shape).
    const seeder = baerlyWorker(() => ({ verifier, config: testConfig }));
    await seeder.fetch!(
      new Request("https://x/v1/c/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "obs-miss-1", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );

    const { records, sink } = collectingSink();
    const handler = baerlyWorker(() => ({
      config: testConfig,
      verifier,
      observability: { level: "debug", sink },
    }));

    // Cold-cache GET (the cache is per-isolate and the tenant key is
    // unique to this test, so this is guaranteed to be a miss).
    const res = await handler.fetch!(
      new Request("https://x/v1/c/c/obs-miss-1", { method: "GET" }) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      env,
      makeExec(),
    );
    expect(res.status).toBe(200);

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["outcome"]).toBe("read");
    // The adapter stamps `cache_status` on every HTTP canonical
    // line — see `worker-cache-discriminator.test.ts` for the full
    // hit/miss/bypass matrix.
    expect(props["cache_status"]).toBe("miss");
    // class-B ops fire on the read path (GETs against current.json).
    expect(props["db.storage.class_b_ops_total"]).toBeGreaterThanOrEqual(1);
  });

  test("cache-hit read still emits a canonical line with cache_status=hit", async () => {
    // The adapter constructs the canonical-line context up front so
    // hits flow through the same `flushCanonicalLine` path as
    // misses, only stamped with `cache_status: "hit"`. Operators
    // distinguish hit vs miss directly from the log stream — no CDN
    // dashboard required. The full coverage matrix (miss-then-hit,
    // bypass) lives in `worker-cache-discriminator.test.ts`.
    const bucket = getBinding();
    const tenant = `obs-hit-${Date.now().toString(36)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "obs-hit-test", claimed_at: "" },
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });

    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const makeExec = (): ExecutionContext => mockExecutionContext();

    // Seed one doc, then warm the cache via a sink-less handler so
    // its canonical lines don't pollute the assertion below.
    const warm = baerlyWorker(() => ({ verifier, config: testConfig }));
    await warm.fetch!(
      new Request("https://x/v1/c/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "obs-hit-1", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    const url = "https://x/v1/c/c/obs-hit-1";
    await warm.fetch!(
      new Request(url, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );

    // Now wire the sink and fire the cache-hit GET.
    const { records, sink } = collectingSink();
    const hit = baerlyWorker(() => ({
      config: testConfig,
      verifier,
      observability: { level: "debug", sink },
    }));
    const res = await hit.fetch!(
      new Request(url, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    expect(res.status).toBe(200);
    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["cache_status"]).toBe("hit");
    expect(props["outcome"]).toBe("read");
    expect(props["status"]).toBe(200);
  });

  test("verifier-rejected 401 emits a canonical http line AND the verifier_rejected warn", async () => {
    // Cross-adapter regression-lock: CF and Node must emit the same
    // wire shape AND the same observability record when the verifier
    // returns null. See `packages/adapter-node/src/server.test.ts`
    // for the Node twin of this assertion.
    const bucket = getBinding();
    const { records, sink } = collectingSink();
    const denyVerifier: Verifier = async () => null;
    const handler = baerlyWorker(() => ({
      config: testConfig,
      verifier: denyVerifier,
      observability: { level: "debug", sink },
    }));
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const ctx = makeNoopCtx();

    const res = await handler.fetch!(
      new Request("https://x/v1/c/c", { method: "GET" }) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("Unauthorized");
    expect(body.error?.message).toBe("Missing or invalid Authorization header");

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["status"]).toBe(401);
    expect(props["outcome"]).toBe("error");
    expect(props["method"]).toBe("GET");
    expect(props["path"]).toBe("/v1/c/c");

    const warn = records.find(
      (r) => r.message.join("") === "verifier_rejected" && r.category.join(".") === "baerly.http",
    );
    expect(warn).toBeDefined();
    expect(warn!.level).toBe("warning");
  });
});

describe("baerlyWorker observability opt-out", () => {
  afterEach(async () => {
    await reset();
  });

  const healthzRequest = (): Request<unknown, IncomingRequestCfProperties> =>
    new Request("https://x/v1/healthz") as Request<unknown, IncomingRequestCfProperties>;

  test("observability:false skips lazy configuration on first fetch", async () => {
    await reset();
    const handler = baerlyWorker(() => ({ config: testConfig, observability: false }));
    const env: BaerlyEnv = { BUCKET: getBinding(), APP: "t" };

    await handler.fetch!(healthzRequest(), env, mockExecutionContext());

    // The worker never called configureObservability: LogTape stays
    // unconfigured so the embedding Worker can own configuration.
    expect(getConfig()).toBeNull();
  });

  test("observability omitted auto-configures on first fetch (default-on)", async () => {
    await reset();
    const handler = baerlyWorker(() => ({ config: testConfig }));
    const env: BaerlyEnv = { BUCKET: getBinding(), APP: "t" };

    await handler.fetch!(healthzRequest(), env, mockExecutionContext());

    expect(getConfig()).not.toBeNull();
  });
});

describe("baerlyWorker factory caching", () => {
  // Trivial verifier that lets every request through — same pattern as
  // `trivialVerifier` in `worker-routes.test.ts`.
  const trivialVerifier: Verifier = async () => ({
    tenantPrefix: "acme",
    identity: { kind: "cache-test" },
  });

  test("baerlyWorker resolves the factory exactly once across N fetches", async () => {
    const bucket = getBinding();
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    let factoryCalls = 0;
    const handler = baerlyWorker(() => {
      factoryCalls += 1;
      return { verifier: trivialVerifier, config: testConfig };
    });

    for (let i = 0; i < 5; i++) {
      await handler.fetch!(
        new Request("https://x/v1/healthz") as Request<unknown, IncomingRequestCfProperties>,
        env,
        makeNoopCtx(),
      );
    }
    expect(factoryCalls).toBe(1);
  });

  test("baerlyWorker.scheduled shares the cache with fetch", async () => {
    const bucket = getBinding();
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    let factoryCalls = 0;
    const handler = baerlyWorker(() => {
      factoryCalls += 1;
      return { verifier: trivialVerifier, config: testConfig };
    });

    await handler.fetch!(
      new Request("https://x/v1/healthz") as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeNoopCtx(),
    );
    await handler.scheduled!(makeScheduledEvent(), env, makeNoopCtx());
    expect(factoryCalls).toBe(1);
  });
});

/**
 * `config.auth` synthesis suite. Asserts the adapter wires the
 * declared posture into a real `Verifier` when no `verifier:`
 * override is supplied. Covers the three end-to-end branches
 * from `resolveVerifier`: `"none"`, `"shared-secret"` happy path,
 * and `"shared-secret"` + missing env (the cached-error path).
 */
describe("baerlyWorker config.auth synthesis", () => {
  const provisionTable = async (bucket: R2Bucket, tenant: string): Promise<void> => {
    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "auth-synth-test", claimed_at: "" },
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
  };

  test('auth: "none" without `verifier:` resolves every request to config.tenant', async () => {
    const bucket = getBinding();
    const tenant = `auth-none-${Date.now().toString(36)}`;
    await provisionTable(bucket, tenant);
    const config: BaerlyAppConfig = {
      app: "t",
      tenant,
      target: "cloudflare",
      auth: "none",
      collections: {},
    };
    const handler = baerlyWorker(() => ({ config }));
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };

    // No Authorization header — `auth: "none"` pins anonymously.
    const res = await handler.fetch!(
      new Request("https://x/v1/c/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "none-1", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeNoopCtx(),
    );
    expect(res.status).toBe(201);

    // The doc landed under `tenant/${tenant}/...` — proves the
    // adapter pinned `config.tenant`.
    const readRes = await handler.fetch!(
      new Request("https://x/v1/c/c/none-1", { method: "GET" }) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      env,
      makeNoopCtx(),
    );
    expect(readRes.status).toBe(200);
  });

  test('auth: "shared-secret" with env.SHARED_SECRET present accepts the bearer and rejects without', async () => {
    const bucket = getBinding();
    const tenant = `auth-ss-${Date.now().toString(36)}`;
    await provisionTable(bucket, tenant);
    const config: BaerlyAppConfig = {
      app: "t",
      tenant,
      target: "cloudflare",
      auth: "shared-secret",
      collections: {},
    };
    const handler = baerlyWorker(() => ({ config }));
    // CF env bindings are read via `(env as Record<string, unknown>)[k]`;
    // augment the env with `SHARED_SECRET` so the resolver picks it up.
    const env = { BUCKET: bucket, APP: "t", SHARED_SECRET: "topsecret" } as unknown as BaerlyEnv;

    const okRes = await handler.fetch!(
      new Request("https://x/v1/c/c", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer topsecret",
        },
        body: JSON.stringify({ doc: { _id: "ss-1", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeNoopCtx(),
    );
    expect(okRes.status).toBe(201);

    const badRes = await handler.fetch!(
      new Request("https://x/v1/c/c", {
        method: "GET",
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeNoopCtx(),
    );
    expect(badRes.status).toBe(401);
  });

  test('auth: "shared-secret" with missing env throws on first fetch and caches the error on subsequent fetches', async () => {
    const bucket = getBinding();
    const tenant = `auth-ss-miss-${Date.now().toString(36)}`;
    const config: BaerlyAppConfig = {
      app: "t",
      tenant,
      target: "cloudflare",
      auth: "shared-secret",
      collections: {},
    };
    // No SHARED_SECRET on the env — `resolveVerifier` throws.
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const handler = baerlyWorker(() => ({ config }));

    // The first fetch surfaces the `InvalidConfig` BaerlyError via the
    // ExportedHandler's default exception-propagation path. We catch it
    // here and assert on the locked message.
    let first: unknown;
    try {
      await handler.fetch!(
        new Request("https://x/v1/c/c") as Request<unknown, IncomingRequestCfProperties>,
        env,
        makeNoopCtx(),
      );
    } catch (error) {
      first = error;
    }
    expect(first).toBeDefined();
    expect((first as Error).message).toBe(SHARED_SECRET_MISSING_MESSAGE);

    // Second fetch re-throws the cached error rather than re-running
    // `resolveVerifier`. Identity-equality on the caught value pins
    // the cached path.
    let second: unknown;
    try {
      await handler.fetch!(
        new Request("https://x/v1/c/c") as Request<unknown, IncomingRequestCfProperties>,
        env,
        makeNoopCtx(),
      );
    } catch (error) {
      second = error;
    }
    expect(second).toBe(first);
  });
});
