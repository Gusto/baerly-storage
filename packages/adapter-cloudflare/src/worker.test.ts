/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   miniflare-pool ↔ test contract: `tests/setup/r2-binding.ts` sets the
   global, this file reads it. `_id` is the locked primary-key field on
   document shapes. */

/**
 * `baerlyWorker()` adapter tests. Runs under the `cloudflare-pool`
 * vitest project (workerd + miniflare) so the `ExecutionContext` /
 * `ScheduledController` types resolve and the R2 binding is real.
 */

import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Verifier } from "@baerly/protocol";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, describe, expect, test } from "vitest";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { baerlyWorker, type Env } from "./worker.ts";

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

const makeNoopCtx = (): ExecutionContext => ({
  waitUntil(): void {},
  passThroughOnException(): void {},
  props: {},
});

describe("baerlyWorker scheduled", () => {
  test("no-ops when `options.scheduled` is unset", async () => {
    const bucket = getBinding();
    const env: Env = { BUCKET: bucket, APP: "t" };
    const handler = baerlyWorker({ verifier: scheduledOnlyVerifier });
    await expect(
      handler.scheduled!(makeScheduledEvent(), env, makeNoopCtx()),
    ).resolves.toBeUndefined();

    // Nothing was written anywhere.
    const listed = await bucket.list({ prefix: "" });
    expect(listed.objects).toHaveLength(0);
  });

  test("invokes `options.scheduled` with the event/env/ctx triple", async () => {
    const bucket = getBinding();
    const env: Env = { BUCKET: bucket, APP: "t" };
    const calls: Array<[ScheduledController, Env, ExecutionContext]> = [];
    const handler = baerlyWorker({
      verifier: scheduledOnlyVerifier,
      scheduled: (event, e, c) => {
        calls.push([event, e, c]);
      },
    });
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
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "obs-write-test", claimed_at: "" },
    });

    const handler = baerlyWorker({
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const env: Env = { BUCKET: bucket, APP: "t" };
    const ctx: ExecutionContext = {
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    };

    const res = await handler.fetch!(
      new Request("https://x/v1/t/c", {
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
    // tee wiring is in place. Writer PUTs content + log +
    // current.json on every commit ⇒ at least 3 Class A ops.
    const classA = props["db.storage.class_a_ops_total"];
    expect(typeof classA).toBe("number");
    expect(classA).toBeGreaterThanOrEqual(3);
  });

  test("cache-miss read emits a canonical line with class_b_ops>0, outcome=read, cache_status=miss", async () => {
    const bucket = getBinding();
    const tenant = `obs-miss-${Date.now().toString(36)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "obs-miss-test", claimed_at: "" },
    });

    const env: Env = { BUCKET: bucket, APP: "t" };
    const makeExec = (): ExecutionContext => ({
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    });

    // Seed one doc via a sink-less handler so the GET below has a
    // body to fetch (per-doc URLs are the only cached shape).
    const seeder = baerlyWorker({ verifier });
    await seeder.fetch!(
      new Request("https://x/v1/t/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "obs-miss-1", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );

    const { records, sink } = collectingSink();
    const handler = baerlyWorker({
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });

    // Cold-cache GET (the cache is per-isolate and the tenant key is
    // unique to this test, so this is guaranteed to be a miss).
    const res = await handler.fetch!(
      new Request("https://x/v1/t/c/obs-miss-1", { method: "GET" }) as Request<
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
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "obs-hit-test", claimed_at: "" },
    });

    const env: Env = { BUCKET: bucket, APP: "t" };
    const makeExec = (): ExecutionContext => ({
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    });

    // Seed one doc, then warm the cache via a sink-less handler so
    // its canonical lines don't pollute the assertion below.
    const warm = baerlyWorker({ verifier });
    await warm.fetch!(
      new Request("https://x/v1/t/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "obs-hit-1", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    const url = "https://x/v1/t/c/obs-hit-1";
    await warm.fetch!(
      new Request(url, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );

    // Now wire the sink and fire the cache-hit GET.
    const { records, sink } = collectingSink();
    const hit = baerlyWorker({
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
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
    const handler = baerlyWorker({
      verifier: denyVerifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const env: Env = { BUCKET: bucket, APP: "t" };
    const ctx = makeNoopCtx();

    const res = await handler.fetch!(
      new Request("https://x/v1/t/c", { method: "GET" }) as Request<
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
    expect(props["path"]).toBe("/v1/t/c");

    const warn = records.find(
      (r) => r.message.join("") === "verifier_rejected" && r.category.join(".") === "baerly.http",
    );
    expect(warn).toBeDefined();
    expect(warn!.level).toBe("warning");
  });
});
