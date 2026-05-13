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
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, describe, expect, it } from "vitest";
import { createListener, resolveDefaultSink, runMaintenanceTick } from "./server.ts";

describe("runMaintenanceTick", () => {
  it("runs both compact and gc against the supplied storage", async () => {
    const s = new MemoryStorage();
    const key = "app/t/tenant/x/manifests/c/current.json";
    await createCurrentJson(s, key, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
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
    const classA = props["db.storage.class_a_ops_total_total"];
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
    expect(props["db.storage.class_b_ops_total_total"]).toBeGreaterThanOrEqual(1);
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

  it("defaults to console-pretty when stdout is a TTY", () => {
    process.stdout.isTTY = true;
    expect(resolveDefaultSink({}).sink).toBe("console-pretty");
    expect(resolveDefaultSink({ level: "debug" }).sink).toBe("console-pretty");
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
