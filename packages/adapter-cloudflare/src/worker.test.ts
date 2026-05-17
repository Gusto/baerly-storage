/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   ticket-06 contract: miniflare's vitest pool sets the global, this file
   reads it. `_id` is the locked primary-key field on document shapes. */

/**
 * `baerlyWorker()` Cron Trigger handler test. Runs under the
 * `cloudflare-pool` vitest project (workerd + miniflare) so the
 * `ExecutionContext` / `ScheduledController` types resolve and the
 * R2 binding is real.
 *
 * Two cases:
 *   - even-minute branch invokes `runScheduledMaintenance` with
 *     `skipGc: true` ⇒ compact lands (snapshot pointer set).
 *   - empty `CURRENT_JSON_KEY` is a no-op (nothing touched on the
 *     bucket).
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type Storage,
  type Verifier,
} from "@baerly/protocol";
import { ServerWriter } from "@baerly/server";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, describe, expect, it } from "vitest";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { baerlyWorker, type Env } from "./worker.ts";

/**
 * Stand-in `Verifier` for the scheduled-only tests in this file. The
 * Cron Trigger handler doesn't invoke the verifier, but `baerlyWorker`
 * still requires one at construction time (Task A). Any non-null
 * resolver works.
 */
const scheduledOnlyVerifier: Verifier = async () => ({
  tenantPrefix: "x",
  identity: { kind: "scheduled-test" },
});

const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error("worker.test: globalThis.__BAERLY_R2_BINDING__ missing — wired by vitest pool");
  }
  return bucket;
};

/**
 * Awaiting-`waitUntil` mock. The production CF runtime fires the
 * `ctx.waitUntil(p)` promise in the background; for the test we
 * collect the promises so the assertions can await them.
 */
const makeCtx = (): { ctx: ExecutionContext; settled: () => Promise<unknown[]> } => {
  const pending: Array<Promise<unknown>> = [];
  const ctx: ExecutionContext = {
    waitUntil(p: Promise<unknown>): void {
      pending.push(p);
    },
    passThroughOnException(): void {},
    props: {},
  };
  return { ctx, settled: () => Promise.all(pending) };
};

const seed = async (
  storage: Storage,
  key: string,
  collection: string,
  entries: number,
): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    writer_fence: { epoch: 0, owner: "worker-test", claimed_at: "" },
  });
  const writer = new ServerWriter({ storage, currentJsonKey: key });
  for (let i = 0; i < entries; i++) {
    await writer.commit({
      op: "I",
      collection,
      docId: `d${i}`,
      body: { _id: `d${i}`, n: i },
    });
  }
};

describe("baerlyWorker scheduled", () => {
  it("compacts on an even-minute tick when CURRENT_JSON_KEY is set", async () => {
    const bucket = getBinding();
    const storage = r2BindingStorage(bucket);
    const key = "app/t/tenant/x/manifests/c/current.json";
    await seed(storage, key, "c", 60);

    const env: Env = {
      BUCKET: bucket,
      APP: "t",
      TENANT: "x",
      CURRENT_JSON_KEY: key,
      CF_TIER: "free",
    };
    const handler = baerlyWorker({ verifier: scheduledOnlyVerifier });
    expect(handler.scheduled).toBeDefined();
    const { ctx, settled } = makeCtx();

    // Even minute (0) → compact branch on free tier.
    const event: ScheduledController = {
      scheduledTime: Date.UTC(2026, 0, 1, 0, 0, 0),
      cron: "* * * * *",
      noRetry(): void {},
    };
    await handler.scheduled!(event, env, ctx);
    await settled();

    // current.json now carries a snapshot pointer.
    const cur = await storage.get(key);
    expect(cur).not.toBeNull();
    const json = JSON.parse(new TextDecoder().decode(cur!.body)) as {
      snapshot: string | null;
      log_seq_start?: number;
    };
    expect(json.snapshot).not.toBeNull();
    expect(json.log_seq_start ?? 0).toBeGreaterThan(0);
    // GC didn't run on the even-minute tick → no pending.json.
    const pending = await storage.get("app/t/tenant/x/manifests/c/gc/pending.json");
    expect(pending).toBeNull();
  });

  it("runs GC on an odd-minute tick when CURRENT_JSON_KEY is set", async () => {
    const bucket = getBinding();
    const storage = r2BindingStorage(bucket);
    const key = "app/t/tenant/x/manifests/c/current.json";
    await seed(storage, key, "c", 60);

    const env: Env = {
      BUCKET: bucket,
      APP: "t",
      TENANT: "x",
      CURRENT_JSON_KEY: key,
      CF_TIER: "free",
    };
    const handler = baerlyWorker({ verifier: scheduledOnlyVerifier });
    const { ctx, settled } = makeCtx();
    // Odd minute (1) → GC branch on free tier.
    const event: ScheduledController = {
      scheduledTime: Date.UTC(2026, 0, 1, 0, 1, 0),
      cron: "* * * * *",
      noRetry(): void {},
    };
    await handler.scheduled!(event, env, ctx);
    await settled();

    // GC ran → pending.json was bootstrapped.
    const pending = await storage.get("app/t/tenant/x/manifests/c/gc/pending.json");
    expect(pending).not.toBeNull();
    // Compact didn't run on the odd-minute tick → no snapshot.
    const cur = await storage.get(key);
    const json = JSON.parse(new TextDecoder().decode(cur!.body)) as {
      snapshot: string | null;
    };
    expect(json.snapshot).toBeNull();
  });

  it("no-ops when CURRENT_JSON_KEY is unset", async () => {
    const bucket = getBinding();
    const env: Env = {
      BUCKET: bucket,
      APP: "t",
      TENANT: "x",
      // CURRENT_JSON_KEY intentionally omitted.
    };
    const handler = baerlyWorker({ verifier: scheduledOnlyVerifier });
    const { ctx, settled } = makeCtx();
    const event: ScheduledController = {
      scheduledTime: Date.UTC(2026, 0, 1, 0, 0, 0),
      cron: "* * * * *",
      noRetry(): void {},
    };
    await handler.scheduled!(event, env, ctx);
    await settled();

    // Nothing was written under the table prefix.
    const listed = await bucket.list({ prefix: "app/t/tenant/x/" });
    expect(listed.objects).toHaveLength(0);
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

  const obsVerifier: Verifier = async () => ({
    tenantPrefix: `obs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    identity: { kind: "obs-test" },
  });

  const findCanonical = (records: readonly LogRecord[], unit: string): LogRecord | undefined =>
    records.find(
      (r) => r.message.join("") === "canonical" && r.category.join(".") === `baerly.${unit}`,
    );

  it("emits a canonical line for a write request with class_a_ops and outcome=committed", async () => {
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
      writer_fence: { epoch: 0, owner: "obs-write-test", claimed_at: "" },
    });

    const handler = baerlyWorker({
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const env: Env = { BUCKET: bucket, APP: "t", TENANT: tenant };
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
    // tee wiring is in place. ServerWriter PUTs content + log +
    // current.json on every commit ⇒ at least 3 Class A ops.
    const classA = props["db.storage.class_a_ops_total"];
    expect(typeof classA).toBe("number");
    expect(classA).toBeGreaterThanOrEqual(3);
  });

  it("cache-miss read emits a canonical line with class_b_ops>0, outcome=read, cache_status=miss", async () => {
    const bucket = getBinding();
    const { records, sink } = collectingSink();
    const tenant = `obs-miss-${Date.now().toString(36)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      writer_fence: { epoch: 0, owner: "obs-miss-test", claimed_at: "" },
    });

    const handler = baerlyWorker({
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const env: Env = { BUCKET: bucket, APP: "t", TENANT: tenant };
    const ctx: ExecutionContext = {
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    };

    // Cold-cache GET (the cache is per-isolate and the tenant key is
    // unique to this test, so this is guaranteed to be a miss).
    const path = `/v1/t/c?where=${encodeURIComponent("{}")}`;
    const res = await handler.fetch!(
      new Request(`https://x${path}`, { method: "GET" }) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      env,
      ctx,
    );
    expect(res.status).toBe(200);

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["outcome"]).toBe("read");
    // The adapter stamps `cache_status` on every HTTP canonical
    // line — see `cache-status.test.ts` for the full hit/miss/bypass
    // matrix.
    expect(props["cache_status"]).toBe("miss");
    // class-B ops fire on the read path (GETs against current.json).
    expect(props["db.storage.class_b_ops_total"]).toBeGreaterThanOrEqual(1);
  });

  it("cache-hit read still emits a canonical line with cache_status=hit", async () => {
    // The adapter constructs the canonical-line context up front so
    // hits flow through the same `flushCanonicalLine` path as
    // misses, only stamped with `cache_status: "hit"`. Operators
    // distinguish hit vs miss directly from the log stream — no CDN
    // dashboard required. The full coverage matrix (miss-then-hit,
    // bypass, write-invalidates-list) lives in `cache-status.test.ts`.
    const bucket = getBinding();
    const tenant = `obs-hit-${Date.now().toString(36)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      writer_fence: { epoch: 0, owner: "obs-hit-test", claimed_at: "" },
    });
    // First request (miss) configured WITHOUT a collecting sink so
    // its canonical line doesn't pollute the assertion below.
    const miss = baerlyWorker({ verifier });
    const env: Env = { BUCKET: bucket, APP: "t", TENANT: tenant };
    const makeExec = (): ExecutionContext => ({
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    });
    const path = `/v1/t/c?where=${encodeURIComponent("{}")}`;
    const url = `https://x${path}`;
    await miss.fetch!(
      new Request(url, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );

    // Second request: now wire the sink and the hit handler. Cache
    // is per-isolate so the second GET should land a hit.
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

  it("scheduled() emits a maintenance canonical line on baerly.maintenance", async () => {
    const bucket = getBinding();
    const storage = r2BindingStorage(bucket);
    const tenant = `obs-sched-${Date.now().toString(36)}`;
    const key = `app/t/tenant/${tenant}/manifests/c/current.json`;
    await seed(storage, key, "c", 30);

    const { records, sink } = collectingSink();
    const handler = baerlyWorker({
      verifier: obsVerifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const env: Env = {
      BUCKET: bucket,
      APP: "t",
      TENANT: tenant,
      CURRENT_JSON_KEY: key,
      CF_TIER: "paid",
    };
    const { ctx, settled } = makeCtx();
    const event: ScheduledController = {
      scheduledTime: Date.UTC(2026, 0, 1, 0, 0, 0),
      cron: "* * * * *",
      noRetry(): void {},
    };
    await handler.scheduled!(event, env, ctx);
    await settled();

    const line = findCanonical(records, "maintenance");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["outcome"]).toBe("ok");
    // compact() and runGc() each wrap their body in a nested
    // withObservability call, so per-phase metrics (and the storage
    // decorator's class A/B emissions) land on the compactor/gc
    // canonical lines, not the outer maintenance line. The
    // maintenance line still receives compactor/gc gauge emissions
    // that the maintenance-level teeMetricsRecorders splits onto its
    // own bag (e.g. db.orphan.candidate_count from runGc, set on
    // `teed = (operatorTee, maintenanceRecorder)`).
    expect(props).toHaveProperty("db.orphan.candidate_count");

    // The compactor's nested canonical line carries the storage
    // decorator's class A/B counts — verify the storage decorator
    // wrapping reaches this nested context.
    const compactorLine = findCanonical(records, "compactor");
    expect(compactorLine).toBeDefined();
    const compactorProps = compactorLine!.properties as Record<string, unknown>;
    expect(compactorProps["db.storage.class_b_ops_total"]).toBeGreaterThanOrEqual(1);
  });
});
