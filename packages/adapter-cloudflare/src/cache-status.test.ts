/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   miniflare binding contract; `_id` is the locked primary-key field. */

/**
 * Cache-status stamping integration test. Runs under the
 * `cloudflare-pool` vitest project (workerd + miniflare) so
 * `caches.default` is a real per-isolate cache and the R2 binding
 * is real.
 *
 * Three cases:
 *   1. Miss-then-hit on `(table, id)` — first GET emits
 *      `cache_status: "miss"`, second GET emits `cache_status: "hit"`.
 *   2. `/v1/since` bypasses the cache — `cache_status: "bypass"`.
 *   3. Write invalidates list cache — POST emits `cache_status:
 *      "bypass"` (writes always bypass), and the following GET on
 *      the parent list emits `cache_status: "miss"` because
 *      `invalidateOnWrite` evicted the warm entry.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type Verifier,
} from "@baerly/protocol";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, describe, expect, it } from "vitest";
import { __resetListUrlIndexForTests } from "./cache.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { baerlyWorker, type Env } from "./worker.ts";

const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error(
      "cache-status.test: globalThis.__BAERLY_R2_BINDING__ missing — wired by vitest pool",
    );
  }
  return bucket;
};

const makeExec = (): ExecutionContext => ({
  waitUntil(p: Promise<unknown>): void {
    // Eagerly await so the test sees `invalidateOnWrite` complete
    // before the next request fires. Tests don't need the
    // production runtime's background-task semantics.
    void p;
  },
  passThroughOnException(): void {},
  props: {},
});

/**
 * Captured-records sink. Mirrors `worker.test.ts:77-110`.
 */
const collectingSink = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  const sink: Sink = (record) => records.push(record);
  return { records, sink };
};

const findCanonicalRecords = (
  records: readonly LogRecord[],
  unit: string,
): readonly LogRecord[] =>
  records.filter(
    (r) => r.message.join("") === "canonical" && r.category.join(".") === `baerly.${unit}`,
  );

describe("baerlyWorker cache_status", () => {
  afterEach(async () => {
    __resetListUrlIndexForTests();
    await reset();
  });

  it("miss then hit on (table, id) stamps cache_status accordingly", async () => {
    const bucket = getBinding();
    const tenant = `cs-hit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });

    // Provision current.json so the GET can resolve the manifest.
    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "cs-hit-test", claimed_at: "" },
    });

    // Insert one doc up front via a POST so subsequent GETs have a
    // body to fetch.
    const provisionHandler = baerlyWorker({ verifier });
    const env: Env = { BUCKET: bucket, APP: "t", TENANT: tenant };
    const insertRes = await provisionHandler.fetch!(
      new Request("https://x/v1/t/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "cs-1", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    expect(insertRes.status).toBe(201);

    // Now wire the sink and fire two GETs against the same id.
    const { records, sink } = collectingSink();
    const handler = baerlyWorker({
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const url = "https://x/v1/t/c/cs-1";

    // First GET → miss.
    const res1 = await handler.fetch!(
      new Request(url, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    expect(res1.status).toBe(200);

    // Second GET → hit.
    const res2 = await handler.fetch!(
      new Request(url, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    expect(res2.status).toBe(200);

    const lines = findCanonicalRecords(records, "http");
    expect(lines).toHaveLength(2);
    const propsMiss = lines[0]!.properties as Record<string, unknown>;
    const propsHit = lines[1]!.properties as Record<string, unknown>;

    expect(propsMiss["cache_status"]).toBe("miss");
    expect(propsMiss["status"]).toBe(200);
    expect(propsMiss["outcome"]).toBe("read");
    expect(typeof propsMiss["request_id"]).toBe("string");

    expect(propsHit["cache_status"]).toBe("hit");
    expect(propsHit["status"]).toBe(200);
    expect(propsHit["outcome"]).toBe("read");
    expect(typeof propsHit["request_id"]).toBe("string");
  });

  it("/v1/since bypasses the cache → cache_status=bypass", async () => {
    const bucket = getBinding();
    const tenant = `cs-bypass-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });

    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "cs-bypass-test", claimed_at: "" },
    });

    const env: Env = { BUCKET: bucket, APP: "t", TENANT: tenant };

    // Seed one log entry so `/v1/since?cursor=` returns immediately
    // (fast-path: `longPollSince` finds events on the initial poll
    // and short-circuits — no wall-clock waiting on the default
    // 25s long-poll deadline).
    const seedHandler = baerlyWorker({ verifier });
    await seedHandler.fetch!(
      new Request("https://x/v1/t/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "cs-bypass-seed", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );

    const { records, sink } = collectingSink();
    const handler = baerlyWorker({
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });

    const sinceUrl = `https://x/v1/since?table=c&cursor=`;
    const res = await handler.fetch!(
      new Request(sinceUrl, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    expect(res.status).toBe(200);

    const lines = findCanonicalRecords(records, "http");
    expect(lines).toHaveLength(1);
    const props = lines[0]!.properties as Record<string, unknown>;
    expect(props["cache_status"]).toBe("bypass");
    expect(props["status"]).toBe(200);
    expect(props["outcome"]).toBe("read");
  });

  it("write invalidates the list cache — POST is bypass, follow-up GET is miss", async () => {
    const bucket = getBinding();
    const tenant = `cs-inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });

    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "cs-inv-test", claimed_at: "" },
    });

    const env: Env = { BUCKET: bucket, APP: "t", TENANT: tenant };

    // Warm a FILTERED list URL with a sink-less handler. The new
    // invalidate-on-write logic tracks every variant we PUT into the
    // cache and busts them all on a subsequent write; without that
    // tracking, this test would fail because `invalidateOnWrite`
    // would only bust the bare URL (the bug T07 fixes).
    const warmer = baerlyWorker({ verifier });
    const filteredListUrl = `https://x/v1/t/c?where=${encodeURIComponent('{"v":1}')}`;
    await warmer.fetch!(
      new Request(filteredListUrl, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );

    // Now wire the sink and fire POST then GET on the parent list.
    // The POST's `ctx.waitUntil(invalidateOnWrite(...))` must settle
    // before the subsequent GET — our test `makeExec` runs
    // `waitUntil` callbacks inline, which is sufficient because
    // `invalidateOnWrite` is synchronously awaited inside the
    // promise we hand to `waitUntil`. To be safe, eagerly await it
    // outside.
    const { records, sink } = collectingSink();
    const handler = baerlyWorker({
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });

    // Use an awaiting-waitUntil so invalidation completes before the
    // next request fires.
    const pendingTasks: Array<Promise<unknown>> = [];
    const awaitingCtx: ExecutionContext = {
      waitUntil(p: Promise<unknown>): void {
        pendingTasks.push(p);
      },
      passThroughOnException(): void {},
      props: {},
    };

    const postRes = await handler.fetch!(
      new Request("https://x/v1/t/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "cs-inv-1", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      awaitingCtx,
    );
    expect(postRes.status).toBe(201);

    // Drain `waitUntil` queue so `invalidateOnWrite` runs before the
    // follow-up GET.
    await Promise.all(pendingTasks);

    const getRes = await handler.fetch!(
      new Request(filteredListUrl, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    expect(getRes.status).toBe(200);

    const lines = findCanonicalRecords(records, "http");
    expect(lines).toHaveLength(2);
    const propsPost = lines[0]!.properties as Record<string, unknown>;
    const propsGet = lines[1]!.properties as Record<string, unknown>;

    expect(propsPost["cache_status"]).toBe("bypass");
    expect(propsPost["status"]).toBe(201);
    // POST classifies as "committed" because status<400 && method !== GET.
    expect(propsPost["outcome"]).toBe("committed");

    expect(propsGet["cache_status"]).toBe("miss");
    expect(propsGet["status"]).toBe(200);
    expect(propsGet["outcome"]).toBe("read");
  });

  it("a write busts BOTH bare and filtered list variants", async () => {
    const bucket = getBinding();
    const tenant = `cs-multi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });

    const storage = r2BindingStorage(bucket);
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/c/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "cs-multi-test", claimed_at: "" },
    });

    const env: Env = { BUCKET: bucket, APP: "t", TENANT: tenant };
    const warmer = baerlyWorker({ verifier });
    const bareUrl = `https://x/v1/t/c`;
    const filteredUrl = `https://x/v1/t/c?where=${encodeURIComponent('{"v":2}')}`;

    // Warm both variants with a sink-less handler so their canonical
    // lines don't pollute the assertions below.
    await warmer.fetch!(
      new Request(bareUrl, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    await warmer.fetch!(
      new Request(filteredUrl, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );

    // Now wire the sink and fire POST then GETs.
    const { records, sink } = collectingSink();
    const handler = baerlyWorker({
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });

    const pendingTasks: Array<Promise<unknown>> = [];
    const awaitingCtx: ExecutionContext = {
      waitUntil(p: Promise<unknown>): void {
        pendingTasks.push(p);
      },
      passThroughOnException(): void {},
      props: {},
    };

    await handler.fetch!(
      new Request("https://x/v1/t/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "cs-multi-1", v: 1 } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      awaitingCtx,
    );
    // Drain `waitUntil` so `invalidateOnWrite` runs before the follow-up GETs.
    await Promise.all(pendingTasks);

    // Both follow-up GETs should be misses (cache was busted on both
    // variants — bare via the per-URL delete, filtered via the index walk).
    const getBare = await handler.fetch!(
      new Request(bareUrl, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    const getFiltered = await handler.fetch!(
      new Request(filteredUrl, { method: "GET" }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      makeExec(),
    );
    expect(getBare.status).toBe(200);
    expect(getFiltered.status).toBe(200);

    const lines = findCanonicalRecords(records, "http");
    // Expect POST + GET (bare) + GET (filtered) = 3 lines.
    expect(lines).toHaveLength(3);
    const propsBare = lines[1]!.properties as Record<string, unknown>;
    const propsFiltered = lines[2]!.properties as Record<string, unknown>;
    expect(propsBare["cache_status"]).toBe("miss");
    expect(propsFiltered["cache_status"]).toBe("miss");
  });
});
