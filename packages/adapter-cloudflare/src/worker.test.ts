/**
 * `baerlyWorker()` adapter tests. Runs under the `cloudflare-pool`
 * vitest project (workerd + miniflare) so the `ExecutionContext` /
 * `ScheduledController` types resolve and the R2 binding is real.
 */

import {
  type BaerlyAppConfig,
  BaerlyError,
  SHARED_SECRET_MISSING_MESSAGE,
  type Verifier,
} from "@baerly/protocol";
import { getCurrentContext } from "@baerly/server/observability";
import { getConfig, reset } from "@logtape/logtape";
import { afterEach, describe, expect, test, vi } from "vitest";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { baerlyWorker, type BaerlyEnv } from "./worker.ts";
import { mockExecutionContext } from "../../../tests/fixtures/mock-execution-context.ts";
import { provisionCollection } from "../../../tests/fixtures/log-state.ts";
import { denyVerifier, trivialVerifier } from "../../../tests/fixtures/test-verifier.ts";
import { getBinding } from "../../../tests/fixtures/r2-bucket.ts";
import { collectingSink, findCanonical } from "../../../tests/fixtures/collecting-sink.ts";

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

describe("baerlyWorker ambient context", () => {
  test("the verifier runs inside the request's observability context", async () => {
    const bucket = getBinding();
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const seen: Array<ReturnType<typeof getCurrentContext>> = [];
    const verifier: Verifier = async () => {
      seen.push(getCurrentContext());
      return null;
    };
    const handler = baerlyWorker(() => ({ verifier, config: testConfig }));
    const res = await handler.fetch!(
      new Request("https://x/v1/c/things", {
        headers: { "x-request-id": "req-verifier-ctx" },
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeNoopCtx(),
    );
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
    expect(seen[0]!.request_id).toBe("req-verifier-ctx");
  });
});

describe("baerlyWorker response hardening", () => {
  const env = (): BaerlyEnv => ({ BUCKET: getBinding(), APP: "t" });
  const request = (path: string, headers?: Record<string, string>) =>
    new Request(`https://x${path}`, headers === undefined ? {} : { headers }) as Request<
      unknown,
      IncomingRequestCfProperties
    >;

  test("an x-request-id outside the id charset is replaced with a generated id", async () => {
    const seen: Array<ReturnType<typeof getCurrentContext>> = [];
    const verifier: Verifier = async () => {
      seen.push(getCurrentContext());
      return null;
    };
    const handler = baerlyWorker(() => ({ verifier, config: testConfig }));
    await handler.fetch!(
      request("/v1/c/things", { "x-request-id": "a".repeat(129) }),
      env(),
      makeNoopCtx(),
    );
    expect(seen[0]!.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("sends X-Content-Type-Options: nosniff on healthz and API responses", async () => {
    const handler = baerlyWorker(() => ({ verifier: denyVerifier, config: testConfig }));
    for (const path of ["/v1/healthz", "/v1/c/things", "/v1/spec"]) {
      const res = await handler.fetch!(request(path), env(), makeNoopCtx());
      await res.arrayBuffer();
      expect({ path, nosniff: res.headers.get("x-content-type-options") }).toEqual({
        path,
        nosniff: "nosniff",
      });
    }
  });
});

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
 * cas_attempts, outcome). `scheduled()` emits no canonical line of
 * its own; maintenance outside an HTTP scope falls through to the
 * no-op recorder.
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

  test("emits a canonical line for a write request with class_a_ops and outcome=committed", async () => {
    const bucket = getBinding();
    const { records, sink } = collectingSink();
    const tenant = `obs-write-${Date.now().toString(36)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    // Provision current.json for the target table.
    const storage = r2BindingStorage(bucket);
    await provisionCollection(
      storage,
      `app/t/tenant/${tenant}/manifests/c/current.json`,
      "obs-write-test",
    );

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
    // A nonzero Class-A count proves storage-observability reaches the
    // adapter's canonical line; exact write cost is owned by server tests.
    const classA = props["db.storage.class_a_ops_total"];
    expect(typeof classA).toBe("number");
    expect(classA).toBeGreaterThanOrEqual(1);
  });

  test("point read emits a canonical line with storage work and outcome=read", async () => {
    const bucket = getBinding();
    const tenant = `obs-miss-${Date.now().toString(36)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const storage = r2BindingStorage(bucket);
    await provisionCollection(
      storage,
      `app/t/tenant/${tenant}/manifests/c/current.json`,
      "obs-miss-test",
    );

    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const makeExec = (): ExecutionContext => mockExecutionContext();

    // Seed one doc before collecting the read's storage work.
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

    // Read the row through the Worker.
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
    expect(props).not.toHaveProperty("cache_status");
    // class-B ops fire on the read path (GETs against current.json).
    expect(props["db.storage.class_b_ops_total"]).toBeGreaterThanOrEqual(1);
  });

  test("repeated point reads still emit storage work on their canonical line", async () => {
    const bucket = getBinding();
    const tenant = `obs-hit-${Date.now().toString(36)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const storage = r2BindingStorage(bucket);
    await provisionCollection(
      storage,
      `app/t/tenant/${tenant}/manifests/c/current.json`,
      "obs-hit-test",
    );

    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const makeExec = (): ExecutionContext => mockExecutionContext();

    // Seed one doc, then read once via a sink-less handler so
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

    // Collect the repeated read's canonical line.
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
    expect(props).not.toHaveProperty("cache_status");
    expect(props["db.storage.class_b_ops_total"]).toBeGreaterThanOrEqual(1);
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

    const lines = records.filter(
      (r) => r.message.join("") === "canonical" && r.category.join(".") === "baerly.http",
    );
    expect(lines).toHaveLength(1);
    const props = lines[0]!.properties as Record<string, unknown>;
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

  test.each([
    {
      name: "a thrown BaerlyError NetworkError maps to its own 502 envelope",
      thrown: new BaerlyError("NetworkError", "jwks fetch failed"),
      status: 502,
      code: "NetworkError",
    },
    {
      name: "an untyped verifier throw maps to an Internal 500 envelope",
      thrown: new Error("boom"),
      status: 500,
      code: "Internal",
    },
  ])("$name and emits exactly one canonical line", async ({ thrown, status, code }) => {
    const { records, sink } = collectingSink();
    const throwingVerifier: Verifier = async () => {
      throw thrown;
    };
    const handler = baerlyWorker(() => ({
      config: testConfig,
      verifier: throwingVerifier,
      observability: { level: "debug", sink },
    }));
    const env: BaerlyEnv = { BUCKET: getBinding(), APP: "t" };

    const res = await handler.fetch!(
      new Request("https://x/v1/c/c", { method: "GET" }) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      env,
      makeNoopCtx(),
    );
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe(code);

    const lines = records.filter(
      (r) => r.message.join("") === "canonical" && r.category.join(".") === "baerly.http",
    );
    expect(lines).toHaveLength(1);
    const props = lines[0]!.properties as Record<string, unknown>;
    expect(props["status"]).toBe(status);
    expect(props["outcome"]).toBe("error");
    expect(props["method"]).toBe("GET");
    expect(props["error"]).toBeDefined();
    expect(props["path"]).toBe("/v1/c/c");
  });

  // Matches Node (`server.ts`): `Db.create` refusing the verifier's
  // tenant (here a non-NFC claim) is a mapped 400 envelope with its own
  // canonical line, not an unhandled 500.
  test("a non-NFC tenant from the verifier maps to a 400 InvalidConfig envelope", async () => {
    const { records, sink } = collectingSink();
    const handler = baerlyWorker(() => ({
      config: testConfig,
      verifier: async () => ({ tenantPrefix: "cafe\u0301", identity: {} }),
      observability: { level: "debug", sink },
    }));
    const env: BaerlyEnv = { BUCKET: getBinding(), APP: "t" };

    const res = await handler.fetch!(
      new Request("https://x/v1/c/c", { method: "GET" }) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      env,
      makeNoopCtx(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("InvalidConfig");

    const lines = records.filter(
      (r) => r.message.join("") === "canonical" && r.category.join(".") === "baerly.http",
    );
    expect(lines).toHaveLength(1);
    const props = lines[0]!.properties as Record<string, unknown>;
    expect(props["status"]).toBe(400);
    expect(props["path"]).toBe("/v1/c/c");
  });

  // Cache API availability cannot affect storage-backed point reads.
  test("a broken Cache API does not affect the router or its canonical line", async () => {
    const { records, sink } = collectingSink();
    const handler = baerlyWorker(() => ({
      config: testConfig,
      verifier: scheduledOnlyVerifier,
      observability: { level: "debug", sink },
    }));
    const env: BaerlyEnv = { BUCKET: getBinding(), APP: "t" };
    const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
    const originalMatch = cache.match;
    cache.match = async () => {
      throw new BaerlyError("NetworkError", "cache api down");
    };
    let res: Response;
    try {
      res = (await handler.fetch!(
        new Request("https://x/v1/c/c/doc1", { method: "GET" }) as Request<
          unknown,
          IncomingRequestCfProperties
        >,
        env,
        makeNoopCtx(),
      )) as unknown as Response;
    } finally {
      cache.match = originalMatch;
    }
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("NotFound");

    const lines = records.filter(
      (r) => r.message.join("") === "canonical" && r.category.join(".") === "baerly.http",
    );
    expect(lines).toHaveLength(1);
    const props = lines[0]!.properties as Record<string, unknown>;
    expect(props["status"]).toBe(404);
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
    await provisionCollection(
      storage,
      `app/t/tenant/${tenant}/manifests/c/current.json`,
      "auth-synth-test",
    );
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

  test('auth: "shared-secret" with missing env answers a scrubbed 500 envelope, logs the full error, and caches the failure', async () => {
    const bucket = getBinding();
    const tenant = `auth-ss-miss-${Date.now().toString(36)}`;
    const config: BaerlyAppConfig = {
      app: "t",
      tenant,
      target: "cloudflare",
      auth: "shared-secret",
      collections: {},
    };
    // No SHARED_SECRET on the env: `resolveVerifier` throws. A config
    // resolution failure is a server fault: a scrubbed 500 envelope, with
    // the full error on the console for the operator.
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    let factoryCalls = 0;
    const handler = baerlyWorker(() => {
      factoryCalls += 1;
      return { config };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      for (let i = 0; i < 2; i++) {
        const res = (await handler.fetch!(
          new Request("https://x/v1/c/c") as Request<unknown, IncomingRequestCfProperties>,
          env,
          makeNoopCtx(),
        )) as unknown as Response;
        expect(res.status).toBe(500);
        expect(res.headers.get("content-type")).toBe("application/json");
        const text = await res.text();
        expect((JSON.parse(text) as { error?: { code?: string } }).error?.code).toBe("Internal");
        // The scrub: neither the setting name nor the locked message leaks.
        expect(text).not.toContain("SHARED_SECRET");
        expect(text).not.toContain(SHARED_SECRET_MISSING_MESSAGE);
      }
      // The operator still sees the full locked message.
      const logged = errorSpy.mock.calls.map((args) => args.map(String).join(" "));
      expect(logged.some((line) => line.includes(SHARED_SECRET_MISSING_MESSAGE))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
    // The failure is cached: the factory is not re-run.
    expect(factoryCalls).toBe(1);
  });
});
