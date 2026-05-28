/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   miniflare binding contract; `_id` is the locked primary-key field. */

/**
 * Worker `cache_status` discriminator integration test. Runs under
 * the `cloudflare-pool` vitest project (workerd + miniflare) so
 * `caches.default` and the R2 binding are real.
 *
 * Asserts that the canonical-line `cache_status` field reflects the
 * cache's actual decision for each routing class:
 *   1. Per-doc GET — miss-then-hit on `(table, id)`.
 *   2. `/v1/since` long-poll — always `bypass`.
 */

import {
  type BaerlyAppConfig,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type Verifier,
} from "@baerly/protocol";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, describe, expect, test } from "vitest";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { baerlyWorker, type BaerlyEnv } from "./worker.ts";

/** Minimal `BaerlyAppConfig` — `verifier:` override wins in every case. */
const testConfig: BaerlyAppConfig = {
  app: "t",
  tenant: "cs",
  target: "cloudflare",
  auth: "none",
  collections: {},
};

const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error(
      "worker-cache-discriminator.test: globalThis.__BAERLY_R2_BINDING__ missing — wired by vitest pool",
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

const findCanonicalRecords = (records: readonly LogRecord[], unit: string): readonly LogRecord[] =>
  records.filter(
    (r) => r.message.join("") === "canonical" && r.category.join(".") === `baerly.${unit}`,
  );

describe("baerlyWorker cache_status", () => {
  afterEach(async () => {
    await reset();
  });

  test("miss then hit on (table, id) stamps cache_status accordingly", async () => {
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
    const provisionHandler = baerlyWorker(() => ({ verifier, config: testConfig }));
    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };
    const insertRes = await provisionHandler.fetch!(
      new Request("https://x/v1/c/c", {
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
    const handler = baerlyWorker(() => ({
      config: testConfig,
      verifier,
      observability: { level: "debug", sink },
    }));
    const url = "https://x/v1/c/c/cs-1";

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

  test("/v1/since bypasses the cache → cache_status=bypass", async () => {
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

    const env: BaerlyEnv = { BUCKET: bucket, APP: "t" };

    // Seed one log entry so `/v1/since?cursor=` returns immediately
    // (fast-path: `longPollSince` finds events on the initial poll
    // and short-circuits — no wall-clock waiting on the default
    // 25s long-poll deadline).
    const seedHandler = baerlyWorker(() => ({ verifier, config: testConfig }));
    await seedHandler.fetch!(
      new Request("https://x/v1/c/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "cs-bypass-seed", v: 1 } }),
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

    const sinceUrl = `https://x/v1/since?collection=c&cursor=`;
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
});
