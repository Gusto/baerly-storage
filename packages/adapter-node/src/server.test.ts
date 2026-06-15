/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the maintenance test seeds doc bodies with it. */

/**
 * Node adapter — `nodeMaintenanceDispatch` ops-plane wiring plus
 * `createApp` observability wiring tests. The cross-adapter
 * compactor + GC behaviour itself is covered by the `@baerly/server`
 * package's tests; this file confirms the Node-side helpers plumb
 * through the observability pipe (LogTape config + canonical-line bag)
 * and that the in-band maintenance config reaches the per-request
 * context with Node-tier (bounded, inline-latency-budgeted) caps.
 */

import { getRequestListener } from "@hono/node-server";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MemoryStorage,
  NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS,
  NODE_MAINTENANCE_GC_INTERVAL,
  NODE_MAINTENANCE_GC_MAX_MARKS,
  NODE_MAINTENANCE_GC_MAX_SWEEPS,
  type Verifier,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_GC_INTERVAL,
  WRITE_TICK_GC_MAX_MARKS,
  WRITE_TICK_GC_MAX_SWEEPS,
} from "@baerly/protocol";
import { configureObservability } from "@baerly/server/observability";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp, type CreateAppOptions } from "./app.ts";
import { createFetchHandler, nodeMaintenanceDispatch, resolveDefaultSink } from "./server.ts";

describe("nodeMaintenanceDispatch", () => {
  test("runs inline (no dispatch override) with Node-tier caps + phasesPerTick:both", () => {
    const m = nodeMaintenanceDispatch(() => undefined);

    // Inline on serverful Node: no `waitUntil`-style dispatch override,
    // so the writer falls back to `dispatchInlineAwaited`.
    expect(m.dispatch).toBeUndefined();
    // No env set → neither kill switch nor ceiling override.
    expect(m.disabled).toBeUndefined();
    expect(m.maxFoldBytes).toBeUndefined();

    expect(m.options?.phasesPerTick).toBe("both");

    // Node-tier caps are STRICTLY LARGER than the CF-free defaults — a
    // serverful host folds/sweeps more per pass than a CPU-killable
    // free-tier isolate.
    expect(m.options?.profile?.maxFoldEntriesPerPass).toBeGreaterThan(
      WRITE_TICK_FOLD_ENTRIES_PER_PASS,
    );
    expect(m.options?.profile?.gcMaxMarks).toBeGreaterThan(WRITE_TICK_GC_MAX_MARKS);
    expect(m.options?.profile?.gcMaxSweeps).toBeGreaterThan(WRITE_TICK_GC_MAX_SWEEPS);
    // Shorter GC cadence so the per-write sweep budget keeps up.
    expect(m.options?.profile?.gcInterval).toBeLessThan(WRITE_TICK_GC_INTERVAL);

    // …but BOUNDED, not unbounded: inline maintenance is sized by
    // worst-case single-write latency, not the deleted full-tail sweep.
    // Pin a finite ceiling so a future "just raise it" never reintroduces
    // an unbounded inline fold.
    expect(m.options?.profile?.maxFoldEntriesPerPass).toBe(NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS);
    expect(m.options?.profile?.gcMaxMarks).toBe(NODE_MAINTENANCE_GC_MAX_MARKS);
    expect(m.options?.profile?.gcMaxSweeps).toBe(NODE_MAINTENANCE_GC_MAX_SWEEPS);
    expect(m.options?.profile?.gcInterval).toBe(NODE_MAINTENANCE_GC_INTERVAL);
    expect(m.options?.profile?.maxFoldEntriesPerPass).toBeLessThanOrEqual(1000);
    expect(m.options?.profile?.gcMaxSweeps).toBeLessThanOrEqual(1000);
  });

  test("threads BAERLY_MAINTENANCE_MAX_FOLD_BYTES → maxFoldBytes via process.env (vi.stubEnv)", () => {
    vi.stubEnv("BAERLY_MAINTENANCE_MAX_FOLD_BYTES", "1048576");
    try {
      // Default reader is `process.env`, which vi.stubEnv patches.
      const m = nodeMaintenanceDispatch();
      expect(m.maxFoldBytes).toBe(1048576);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("ignores a non-numeric BAERLY_MAINTENANCE_MAX_FOLD_BYTES", () => {
    const m = nodeMaintenanceDispatch((k) =>
      k === "BAERLY_MAINTENANCE_MAX_FOLD_BYTES" ? "not-a-number" : undefined,
    );
    expect(m.maxFoldBytes).toBeUndefined();
  });

  test("threads BAERLY_MAINTENANCE_DISABLE → disabled via process.env (vi.stubEnv)", () => {
    vi.stubEnv("BAERLY_MAINTENANCE_DISABLE", "1");
    try {
      const m = nodeMaintenanceDispatch();
      expect(m.disabled).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("treats falsy BAERLY_MAINTENANCE_DISABLE values as not-disabled", () => {
    for (const raw of ["0", "false", ""]) {
      const m = nodeMaintenanceDispatch((k) =>
        k === "BAERLY_MAINTENANCE_DISABLE" ? raw : undefined,
      );
      expect(m.disabled).toBeUndefined();
    }
  });
});

/**
 * Per-request observability suite for `createApp`. Verifies
 * the canonical line carries the kernel-emitted metrics (storage
 * class A/B counts, request_id, outcome) and that the verifier /
 * router contract still holds end-to-end through `node:http`.
 *
 * We bind a real `http.Server` (via `getRequestListener`) to a high
 * port so the request round-trips through the OS socket layer,
 * matching the production path (instead of poking the listener with
 * a synthetic IncomingMessage).
 */
describe("createApp observability", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err !== undefined && err !== null) {
            reject(err);
          } else {
            resolve();
          }
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

  const startServer = async (opts: CreateAppOptions): Promise<{ url: string }> => {
    const app = createApp(opts);
    server = createServer(getRequestListener(app.fetch));
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
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "obs-test", claimed_at: "" },
      tail_bytes: 0,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
  };

  test("emits a canonical line for a write request with class_a_ops and outcome=committed", async () => {
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");

    const { records, sink } = collectingSink();
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const { url } = await startServer({
      app: "t",
      storage,
      verifier,
      observability: { level: "debug", sink },
    });

    const res = await fetch(`${url}/v1/c/c`, {
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

  test("emits a canonical line for a GET with outcome=read and non-zero class_b_ops", async () => {
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");

    const { records, sink } = collectingSink();
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const { url } = await startServer({
      app: "t",
      storage,
      verifier,
      observability: { level: "debug", sink },
    });

    const res = await fetch(`${url}/v1/c/c`);
    expect(res.status).toBe(200);

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["outcome"]).toBe("read");
    expect(props["db.storage.class_b_ops_total"]).toBeGreaterThanOrEqual(1);
  });

  test("honors a caller-supplied x-request-id on the canonical line", async () => {
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");

    const { records, sink } = collectingSink();
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const { url } = await startServer({
      app: "t",
      storage,
      verifier,
      observability: { level: "debug", sink },
    });

    const correlation = "test-correlation-7a3f";
    const res = await fetch(`${url}/v1/c/c`, {
      headers: { "x-request-id": correlation },
    });
    expect(res.status).toBe(200);

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    expect(props["request_id"]).toBe(correlation);
  });

  test("canonical line for a successful GET has no cache_status property", async () => {
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");

    const { records, sink } = collectingSink();
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const { url } = await startServer({
      app: "t",
      storage,
      verifier,
      observability: { level: "debug", sink },
    });

    const res = await fetch(`${url}/v1/c/c`);
    expect(res.status).toBe(200);

    const line = findCanonical(records, "http");
    expect(line).toBeDefined();
    const props = line!.properties as Record<string, unknown>;
    // Node has no cache layer — cache_status must never appear on the
    // canonical line. Confirm all expected fields are still present.
    expect(props).not.toHaveProperty("cache_status");
    expect(props).toHaveProperty("request_id");
    expect(props["method"]).toBe("GET");
    expect(props["path"]).toBe("/v1/c/c");
    expect(props["status"]).toBe(200);
    expect(props["outcome"]).toBe("read");
    // A GET issues class B ops (reads); class A (writes) may be zero.
    expect(props["db.storage.class_b_ops_total"]).toBeGreaterThanOrEqual(1);
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

  test("passes a caller-supplied sink through verbatim", () => {
    const customSink: Sink = () => {};
    const out = resolveDefaultSink({ sink: customSink });
    expect(out.sink).toBe(customSink);
  });

  test("constructs the pretty sink as a function when stdout is a TTY", () => {
    process.stdout.isTTY = true;
    // The kernel only accepts `"console-json"` or a `Sink` function;
    // the adapter constructs the pretty sink locally so picocolors
    // stays off the kernel closure.
    expect(typeof resolveDefaultSink({}).sink).toBe("function");
    expect(typeof resolveDefaultSink({ level: "debug" }).sink).toBe("function");
  });

  test("defaults to console-json when stdout is not a TTY", () => {
    process.stdout.isTTY = false;
    expect(resolveDefaultSink({}).sink).toBe("console-json");
    expect(resolveDefaultSink({ level: "debug" }).sink).toBe("console-json");
  });

  test("preserves level when defaulting the sink", () => {
    process.stdout.isTTY = false;
    const out = resolveDefaultSink({ level: "warn" });
    expect(out.level).toBe("warn");
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
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "fetch-handler-test", claimed_at: "" },
      tail_bytes: 0,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
  };

  const okVerifier: Verifier = async () => ({ tenantPrefix: "acme", identity: {} });
  const denyingVerifier: Verifier = async () => null;

  test("answers /v1/healthz with 200 {ok:true} anonymously (verifier bypassed)", async () => {
    const handler = createFetchHandler({
      app: "t",
      storage: new MemoryStorage(),
      verifier: denyingVerifier, // would 401 every other path — proves healthz bypasses
    });
    const res = await handler(new Request("http://x/v1/healthz", { method: "GET" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  test("returns 401 envelope when the verifier returns null on a /v1/t path", async () => {
    const storage = new MemoryStorage();
    await provisionTable(storage, "acme", "c");
    const handler = createFetchHandler({
      app: "t",
      storage,
      verifier: denyingVerifier,
    });
    const res = await handler(new Request("http://x/v1/c/c", { method: "GET" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("Unauthorized");
  });

  test("verifier-rejected 401 emits a canonical http line AND the verifier_rejected warn", async () => {
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
    await configureObservability({ level: "debug", sink });
    const storage = new MemoryStorage();
    const handler = createFetchHandler({
      app: "t",
      storage,
      verifier: denyingVerifier,
      observability: { level: "debug", sink },
    });
    const res = await handler(new Request("http://x/v1/c/c", { method: "GET" }));
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
    expect(props["path"]).toBe("/v1/c/c");

    const warn = records.find(
      (r) => r.message.join("") === "verifier_rejected" && r.category.join(".") === "baerly.http",
    );
    expect(warn).toBeDefined();
    expect(warn!.level).toBe("warning");
  });

  test("returns 200 for an authed GET when the verifier accepts", async () => {
    const storage = new MemoryStorage();
    await provisionTable(storage, "acme", "c");
    const handler = createFetchHandler({
      app: "t",
      storage,
      verifier: okVerifier,
    });
    const res = await handler(new Request("http://x/v1/c/c", { method: "GET" }));
    expect(res.status).toBe(200);
  });

  test("commits a router POST and returns 201", async () => {
    const storage = new MemoryStorage();
    await provisionTable(storage, "acme", "c");
    const handler = createFetchHandler({
      app: "t",
      storage,
      verifier: okVerifier,
    });
    const res = await handler(
      new Request("http://x/v1/c/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "fh-1", v: 1 } }),
      }),
    );
    expect(res.status).toBe(201);
  });

  test("non-/v1/* paths fall through to the kernel 404 envelope", async () => {
    const handler = createFetchHandler({
      app: "t",
      storage: new MemoryStorage(),
      verifier: okVerifier,
    });
    const res = await handler(new Request("http://x/static/foo.css", { method: "GET" }));
    expect(res.status).toBe(404);
  });
});

/**
 * Regression coverage for the `/v1/since` long-poll client-abort
 * crash (pre-cutover hand-rolled bridge: `pipeline(Readable.fromWeb(...),
 * res)` rejected with `ERR_STREAM_UNABLE_TO_PIPE` and the rejection
 * escaped as `unhandledRejection`, killing the Node process — see
 * commit `60bbc04`). After the cutover, `@hono/node-server` owns the
 * `outgoing.on('close', ...)` → `AbortController` wiring and uses a
 * manual write loop with `drain` coordination instead of `pipeline()`,
 * so the rejection-escape failure mode is structurally absent.
 *
 * Two tests:
 *  - the server stays up after a mid-flight client abort
 *    (no `unhandledRejection` fires AND `/v1/healthz` still answers).
 *  - the AbortSignal attached to the synthesized Request actually
 *    flips when the client socket closes.
 */
describe("createApp client-disconnect resilience", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err !== undefined && err !== null) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      server = undefined;
    }
    await reset();
  });

  const startServer = async (
    opts: CreateAppOptions,
  ): Promise<{ host: string; port: number; url: string }> => {
    const app = createApp(opts);
    server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;
    return {
      host: "127.0.0.1",
      port: addr.port,
      url: `http://127.0.0.1:${addr.port}`,
    };
  };

  const provisionSinceTable = async (
    storage: MemoryStorage,
    tenant: string,
    table: string,
  ): Promise<void> => {
    await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/${table}/current.json`, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "since-abort-test", claimed_at: "" },
      tail_bytes: 0,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  test("client-abort of a long-poll /v1/since does not crash the server", async () => {
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provisionSinceTable(storage, tenant, "c");

    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const { host, port, url } = await startServer({
      app: "t",
      storage,
      verifier,
      // Short long-poll budget so the broken (pre-fix) path still
      // completes within the test timeout — pipeline() rejects only
      // after the long-poll resolves and the handler tries to write.
      sinceTimeoutMs: 1500,
      sincePollIntervalMs: 50,
    });

    // Capture any unhandledRejection during the abort window. The
    // pre-fix bug surfaced as `ERR_STREAM_UNABLE_TO_PIPE` rejected
    // from `pipeline()` without a catch — this listener catches it
    // if the regression returns.
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on("unhandledRejection", onRejection);

    try {
      // Open a low-level long-poll request. We must use http.request
      // (not fetch) so we can destroy the underlying TCP socket
      // before the response has been fully delivered.
      const clientReq = httpRequest({
        host,
        port,
        method: "GET",
        path: "/v1/since?collection=c&cursor=",
        headers: { authorization: "Bearer dev" },
      });
      // Send the request without listening for a response — we never
      // intend to read one. Swallow the `error` event that Node emits
      // when we `.destroy()` mid-flight; otherwise it leaks as an
      // `uncaughtException`.
      clientReq.on("error", () => {});
      clientReq.end();

      // Give the server time to enter the long-poll loop, then yank
      // the socket.
      await sleep(100);
      clientReq.destroy();

      // Wait long enough for the broken pipeline()-rejection path to
      // surface (sinceTimeoutMs + slack) so we'd catch a regression
      // where the rejection only fires after the long-poll resolves.
      await sleep(1800);

      // Server must still be alive: a fresh GET /v1/healthz answers
      // 200. fetch() throws ECONNREFUSED if the listener crashed.
      const probe = await fetch(`${url}/v1/healthz`);
      expect(probe.status).toBe(200);
      await expect(probe.json()).resolves.toEqual({ ok: true });

      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }, 10_000);

  test("client disconnect aborts the synthesized Request.signal", async () => {
    // Capture the Request passed to the verifier so we can watch its
    // signal flip when the client socket closes. The verifier runs
    // inside `createFetchHandler` BEFORE the kernel touches the
    // request, so the signal we see here is the one wired by
    // `@hono/node-server`'s incoming-request bridge (which attaches
    // an `AbortController` driven by `outgoing.on('close', ...)`).
    let capturedRequest: Request | undefined;
    let resolveCaptured: (() => void) | undefined;
    const captured = new Promise<void>((resolve) => {
      resolveCaptured = resolve;
    });

    const storage = new MemoryStorage();
    const tenant = "acme";
    await provisionSinceTable(storage, tenant, "c");

    const verifier: Verifier = async (req) => {
      capturedRequest = req;
      resolveCaptured?.();
      return { tenantPrefix: tenant, identity: {} };
    };
    const { host, port } = await startServer({
      app: "t",
      storage,
      verifier,
      sinceTimeoutMs: 1500,
      sincePollIntervalMs: 50,
    });

    const clientReq = httpRequest({
      host,
      port,
      method: "GET",
      path: "/v1/since?collection=c&cursor=",
      headers: { authorization: "Bearer dev" },
    });
    clientReq.on("error", () => {});
    clientReq.end();

    // Wait for the verifier to capture the request.
    await captured;
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.signal.aborted).toBe(false);

    // Watch for the abort event. The signal flips synchronously on
    // the next event-loop turn after the socket closes; a 500ms
    // budget is plenty.
    const aborted = new Promise<void>((resolve) => {
      capturedRequest!.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    clientReq.destroy();
    await Promise.race([
      aborted,
      sleep(500).then(() => {
        throw new Error("Request.signal did not abort within 500ms of clientReq.destroy()");
      }),
    ]);

    expect(capturedRequest!.signal.aborted).toBe(true);
  }, 5000);
});
