/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the maintenance test seeds doc bodies with it. */

/**
 * Node adapter — `runMaintenanceTick` smoke test plus
 * `createListener` observability wiring tests. The cross-adapter
 * compactor + GC behaviour itself is covered by the `@baerly/server`
 * package's tests; this file confirms the Node-side helpers plumb
 * through the observability pipe (LogTape config + canonical-line bag).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MemoryStorage,
  type Verifier,
} from "@baerly/protocol";
import { ServerWriter } from "@baerly/server";
import { configureObservability } from "@baerly/server/observability";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFetchHandler,
  createListener,
  resolveDefaultSink,
  runMaintenanceTick,
} from "./server.ts";

describe("runMaintenanceTick", () => {
  it("runs both compact and gc against the supplied storage", async () => {
    const s = new MemoryStorage();
    const key = "app/t/tenant/x/manifests/c/current.json";
    await createCurrentJson(s, key, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "node-maintenance-test", claimed_at: "" },
    });
    const writer = new ServerWriter({ storage: s, currentJsonKey: key });
    for (let i = 0; i < 200; i++) {
      await writer.commit({
        op: "I",
        collection: "c",
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }

    await runMaintenanceTick({ storage: s, currentJsonKey: key });

    // Compact landed → current.json carries a snapshot pointer and
    // `log_seq_start` advanced past 0.
    const cur = await s.get(key);
    expect(cur).not.toBeNull();
    const json = JSON.parse(new TextDecoder().decode(cur!.body)) as {
      snapshot: string | null;
      log_seq_start?: number;
    };
    expect(json.snapshot).not.toBeNull();
    expect(json.log_seq_start ?? 0).toBeGreaterThan(0);

    // GC bootstrapped its pending ledger (the file exists; the
    // candidates were marked, not swept — 7-day grace gates the
    // sweep, and this test doesn't override `now`).
    const pending = await s.get("app/t/tenant/x/manifests/c/gc/pending.json");
    expect(pending).not.toBeNull();
  });
});

/**
 * Per-request observability suite for `createListener`. Verifies
 * the canonical line carries the kernel-emitted metrics (storage
 * class A/B counts, request_id, outcome) and that the verifier /
 * router contract still holds end-to-end through `node:http`.
 *
 * We bind a real `http.Server` to a high port so the request
 * round-trips through the OS socket layer, matching the production
 * path (instead of poking the listener with a synthetic
 * IncomingMessage).
 */
describe("createListener observability", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err !== undefined && err !== null) reject(err);
          else resolve();
        });
      });
      server = undefined;
    }
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

  const startServer = async (
    listener: ReturnType<typeof createListener>,
  ): Promise<{ url: string }> => {
    server = createServer(listener);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${addr.port}` };
  };

  const provision = async (
    storage: MemoryStorage,
    tenant: string,
    table: string,
  ): Promise<void> => {
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/${table}/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "obs-test", claimed_at: "" },
    });
  };

  it("emits a canonical line for a write request with class_a_ops and outcome=committed", async () => {
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");

    const { records, sink } = collectingSink();
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const listener = createListener({
      app: "t",
      storage,
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const { url } = await startServer(listener);

    const res = await fetch(`${url}/v1/t/c`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: { _id: "w-1", v: 1 } }),
    });
    expect(res.status).toBe(201);

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["outcome"]).toBe("committed");
    expect(props["status"]).toBe(201);
    expect(props["method"]).toBe("POST");
    const classA = props["db.storage.class_a_ops_total"];
    expect(typeof classA).toBe("number");
    expect(classA).toBeGreaterThanOrEqual(3);
  });

  it("emits a canonical line for a GET with outcome=read and non-zero class_b_ops", async () => {
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");

    const { records, sink } = collectingSink();
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const listener = createListener({
      app: "t",
      storage,
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const { url } = await startServer(listener);

    const res = await fetch(`${url}/v1/t/c`);
    expect(res.status).toBe(200);

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["outcome"]).toBe("read");
    expect(props["db.storage.class_b_ops_total"]).toBeGreaterThanOrEqual(1);
  });

  it("honors a caller-supplied x-request-id on the canonical line", async () => {
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");

    const { records, sink } = collectingSink();
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const listener = createListener({
      app: "t",
      storage,
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const { url } = await startServer(listener);

    const correlation = "test-correlation-7a3f";
    const res = await fetch(`${url}/v1/t/c`, {
      headers: { "x-request-id": correlation },
    });
    expect(res.status).toBe(200);

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["request_id"]).toBe(correlation);
  });

  it("canonical line for a successful GET has no cache_status property", async () => {
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");

    const { records, sink } = collectingSink();
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const listener = createListener({
      app: "t",
      storage,
      verifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const { url } = await startServer(listener);

    const res = await fetch(`${url}/v1/t/c`);
    expect(res.status).toBe(200);

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    // Node has no cache layer — cache_status must never appear on the
    // canonical line. Confirm all expected fields are still present.
    expect(props).not.toHaveProperty("cache_status");
    expect(props).toHaveProperty("request_id");
    expect(props["method"]).toBe("GET");
    expect(props["path"]).toBe("/v1/t/c");
    expect(props["status"]).toBe(200);
    expect(props["outcome"]).toBe("read");
    // A GET issues class B ops (reads); class A (writes) may be zero.
    expect(props["db.storage.class_b_ops_total"]).toBeGreaterThanOrEqual(1);
  });

  it("the operator's MetricsRecorder receives kernel emissions verbatim", async () => {
    // Asserts the tee semantic: same metrics that reach the
    // canonical-line bag also reach the operator's long-term sink.
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");

    const operatorCounters: Array<{ name: string; value: number }> = [];
    const operator = {
      counter: (name: string, value: number): void => {
        operatorCounters.push({ name, value });
      },
      gauge: (): void => {},
      histogram: (): void => {},
    };
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const listener = createListener({
      app: "t",
      storage,
      verifier,
      metrics: operator,
    });
    const { url } = await startServer(listener);

    const res = await fetch(`${url}/v1/t/c`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: { _id: "op-1", v: 1 } }),
    });
    expect(res.status).toBe(201);

    const totalClassA = operatorCounters
      .filter((c) => c.name === "db.storage.class_a_ops_total")
      .reduce((acc, c) => acc + c.value, 0);
    expect(totalClassA).toBeGreaterThanOrEqual(3);
  });
});

describe("resolveDefaultSink", () => {
  // We mutate `process.stdout.isTTY` directly. The flag is normally
  // set by Node when stdout is bound to a real TTY; tests run under
  // a piped stdout (isTTY is `undefined`). Reassigning it across
  // the test is safe because there is exactly one `process` per
  // Node test process and no concurrent test reads it.
  const original = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = original;
  });

  it("passes a caller-supplied sink through verbatim", () => {
    const customSink: Sink = () => {};
    const out = resolveDefaultSink({ sink: customSink });
    expect(out.sink).toBe(customSink);
  });

  it("constructs the pretty sink as a function when stdout is a TTY", () => {
    process.stdout.isTTY = true;
    // The kernel only accepts `"console-json"` or a `Sink` function;
    // the adapter constructs the pretty sink locally so picocolors
    // stays off the kernel closure.
    expect(typeof resolveDefaultSink({}).sink).toBe("function");
    expect(typeof resolveDefaultSink({ level: "debug" }).sink).toBe("function");
  });

  it("defaults to console-json when stdout is not a TTY", () => {
    process.stdout.isTTY = false;
    expect(resolveDefaultSink({}).sink).toBe("console-json");
    expect(resolveDefaultSink({ level: "debug" }).sink).toBe("console-json");
  });

  it("preserves level and sampleRate when defaulting the sink", () => {
    process.stdout.isTTY = false;
    const out = resolveDefaultSink({ level: "warn", sampleRate: 0.1 });
    expect(out.level).toBe("warn");
    expect(out.sampleRate).toBe(0.1);
    expect(out.sink).toBe("console-json");
  });
});

/**
 * Direct unit coverage for `createFetchHandler` — the host-agnostic
 * Fetch factory. These tests exercise the cascade without a real HTTP
 * server, calling the handler directly with `new Request(...)`.
 */
describe("createFetchHandler", () => {
  afterEach(async () => {
    await reset();
  });

  const provisionTable = async (
    storage: MemoryStorage,
    tenant: string,
    table: string,
  ): Promise<void> => {
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/${table}/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "fetch-handler-test", claimed_at: "" },
    });
  };

  const okVerifier: Verifier = async () => ({ tenantPrefix: "acme", identity: {} });
  const denyingVerifier: Verifier = async () => null;

  it("answers /v1/healthz with 200 {ok:true} anonymously (verifier bypassed)", async () => {
    const handler = createFetchHandler({
      app: "t",
      storage: new MemoryStorage(),
      verifier: denyingVerifier, // would 401 every other path — proves healthz bypasses
    });
    const res = await handler(new Request("http://x/v1/healthz", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 401 envelope when the verifier returns null on a /v1/t path", async () => {
    const storage = new MemoryStorage();
    await provisionTable(storage, "acme", "c");
    const handler = createFetchHandler({
      app: "t",
      storage,
      verifier: denyingVerifier,
    });
    const res = await handler(new Request("http://x/v1/t/c", { method: "GET" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("Unauthorized");
  });

  it("verifier-rejected 401 emits a canonical http line AND the verifier_rejected warn", async () => {
    // Cross-adapter regression-lock: Node and CF must emit the same
    // wire shape AND the same observability record when the verifier
    // returns null. See `packages/adapter-cloudflare/src/worker.test.ts`
    // for the CF twin of this assertion.
    const records: LogRecord[] = [];
    const sink: Sink = (r) => records.push(r);
    // `createFetchHandler` fires `configureObservability` un-awaited
    // (factory-time, the production path doesn't need a barrier).
    // Await it explicitly here so the sink is wired before the first
    // request reaches `flushUnauthorizedAndRespond`.
    await configureObservability({ level: "debug", sink, sampleRate: 1 });
    const storage = new MemoryStorage();
    const handler = createFetchHandler({
      app: "t",
      storage,
      verifier: denyingVerifier,
      observability: { level: "debug", sink, sampleRate: 1 },
    });
    const res = await handler(new Request("http://x/v1/t/c", { method: "GET" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("Unauthorized");
    expect(body.error?.message).toBe("Missing or invalid Authorization header");

    const line = records.find(
      (r) => r.message.join("") === "canonical" && r.category.join(".") === "baerly.http",
    );
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

  it("returns 200 for an authed GET when the verifier accepts", async () => {
    const storage = new MemoryStorage();
    await provisionTable(storage, "acme", "c");
    const handler = createFetchHandler({
      app: "t",
      storage,
      verifier: okVerifier,
    });
    const res = await handler(new Request("http://x/v1/t/c", { method: "GET" }));
    expect(res.status).toBe(200);
  });

  it("commits a router POST and returns 201", async () => {
    const storage = new MemoryStorage();
    await provisionTable(storage, "acme", "c");
    const handler = createFetchHandler({
      app: "t",
      storage,
      verifier: okVerifier,
    });
    const res = await handler(
      new Request("http://x/v1/t/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "fh-1", v: 1 } }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("non-/v1/* paths fall through to the kernel 404 envelope", async () => {
    const handler = createFetchHandler({
      app: "t",
      storage: new MemoryStorage(),
      verifier: okVerifier,
    });
    const res = await handler(new Request("http://x/static/foo.css", { method: "GET" }));
    expect(res.status).toBe(404);
  });
});
