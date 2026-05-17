import { BaerlyError, MemoryStorage } from "@baerly/protocol";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Db } from "../db.ts";
import {
  configureObservability,
  createObservabilityContext,
  runWithContext,
} from "../observability/index.ts";
import { createRouter, mapError } from "./router.ts";

const collectingSink = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  const sink: Sink = (record) => records.push(record);
  return { records, sink };
};

const buildApp = (): ReturnType<typeof createRouter> => {
  const db = Db.create({
    storage: new MemoryStorage(),
    app: "router-test",
    tenant: "t1",
  });
  return createRouter({ db });
};

describe("mapError", () => {
  let records: LogRecord[];
  let sink: Sink;

  beforeEach(async () => {
    ({ records, sink } = collectingSink());
    await configureObservability({ level: "debug", sink, sampleRate: 1 });
  });

  afterEach(async () => {
    await reset();
  });

  test("BaerlyError surfaces with its own code, status, and message", () => {
    const err = new BaerlyError("NotFound", "No such row: doc-42");
    const { status, envelope } = mapError(err);
    expect(status).toBe(404);
    expect(envelope.error).toEqual({ code: "NotFound", message: "No such row: doc-42" });
  });

  test("unmapped BaerlyError code falls through to 500 with its own message", () => {
    const err = new BaerlyError("InvalidResponse", "GET k: missing ETag");
    const { status, envelope } = mapError(err);
    expect(status).toBe(500);
    expect(envelope.error).toEqual({ code: "InvalidResponse", message: "GET k: missing ETag" });
  });

  test("unknown thrown value is sanitized and emitted via the observability channel", () => {
    const err = new TypeError("bucket=secret-prod path=/internal/keys.json");
    const { status, envelope } = mapError(err);
    expect(status).toBe(500);
    // No internal detail in the wire envelope.
    expect(envelope.error).toEqual({ code: "Internal", message: "internal error" });
    // The original error reaches the structured server-side channel
    // at error level on the http category.
    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe("error");
    expect(records[0]!.category).toEqual(["baerly", "http"]);
    expect(records[0]!.message.join("")).toBe("unhandled_error");
    const serialized = records[0]!.properties["error"] as { code: string; message: string };
    expect(serialized.code).toBe("Internal");
    expect(serialized.message).toBe("bucket=secret-prod path=/internal/keys.json");
  });

  test("non-Error thrown value is sanitized identically", () => {
    const { status, envelope } = mapError("naked string with /etc/secret");
    expect(status).toBe(500);
    expect(envelope.error).toEqual({ code: "Internal", message: "internal error" });
    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe("error");
    const serialized = records[0]!.properties["error"] as { code: string; message: string };
    expect(serialized.message).toContain("/etc/secret");
  });
});

describe("observability middleware", () => {
  let records: LogRecord[];
  let sink: Sink;

  beforeEach(async () => {
    ({ records, sink } = collectingSink());
    await configureObservability({ level: "debug", sink, sampleRate: 1 });
  });

  afterEach(async () => {
    await reset();
  });

  // Filter to the canonical-line records (drops any incidental
  // emissions like the `unhandled_error` event in mapError).
  const canonical = (): LogRecord[] => records.filter((r) => r.message.join("") === "canonical");

  test("successful request emits one canonical INFO line", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost/v1/t/things?where=%7B%7D");
    expect(res.status).toBe(200);
    const lines = canonical();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.level).toBe("info");
    expect(line.category).toEqual(["baerly", "http"]);
    const p = line.properties;
    expect(typeof p["request_id"]).toBe("string");
    expect(p["method"]).toBe("GET");
    expect(p["path"]).toBe("/v1/t/things");
    expect(p["status"]).toBe(200);
    expect(p["outcome"]).toBe("read");
    expect(typeof p["duration_ms"]).toBe("number");
    expect(p["duration_ms"] as number).toBeGreaterThanOrEqual(0);
  });

  test("failed request emits one canonical ERROR line (Conflict → 409)", async () => {
    // Register a route AFTER `createRouter` that throws Conflict
    // synthetically. Hono's compose catches the throw and routes it
    // through `onError`; the middleware sees the error via `c.error`
    // and emits a canonical line whose `error` property forces level
    // = "error" via the canonical-line level picker.
    const db = Db.create({
      storage: new MemoryStorage(),
      app: "router-test",
      tenant: "t1",
    });
    const conflictApp = createRouter({ db });
    conflictApp.get("/v1/throw-conflict", () => {
      throw new BaerlyError("Conflict", "CAS lost");
    });
    conflictApp.onError((err) => {
      const { status, envelope } = mapError(err);
      return Response.json(envelope, { status });
    });

    const res = await conflictApp.request("http://localhost/v1/throw-conflict");
    expect(res.status).toBe(409);
    const lines = canonical();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.level).toBe("error");
    const p = line.properties;
    expect(p["status"]).toBe(409);
    expect(p["outcome"]).toBe("conflict");
    const err = p["error"] as { code: string; message: string };
    expect(err.code).toBe("Conflict");
    expect(err.message).toBe("CAS lost");
  });

  test("/v1/healthz emits ZERO canonical lines (LB-probe bypass)", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost/v1/healthz");
    expect(res.status).toBe(200);
    expect(canonical()).toHaveLength(0);
  });

  test("x-request-id header is honoured", async () => {
    const app = buildApp();
    await app.request("http://localhost/v1/t/things?where=%7B%7D", {
      headers: { "x-request-id": "known-id" },
    });
    const lines = canonical();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.properties["request_id"]).toBe("known-id");
  });

  test("sample-rate=0 suppresses the success-path canonical line", async () => {
    await reset();
    await configureObservability({ level: "debug", sink, sampleRate: 0 });
    const app = buildApp();
    const res = await app.request("http://localhost/v1/t/things?where=%7B%7D");
    expect(res.status).toBe(200);
    expect(canonical()).toHaveLength(0);
  });

  test("sample-rate=0 still emits on the error path (force-keep)", async () => {
    await reset();
    await configureObservability({ level: "debug", sink, sampleRate: 0 });
    const db = Db.create({
      storage: new MemoryStorage(),
      app: "router-test",
      tenant: "t1",
    });
    const app = createRouter({ db });
    app.get("/v1/throw-internal", () => {
      throw new BaerlyError("Internal", "boom");
    });
    app.onError((err) => {
      const { status, envelope } = mapError(err);
      return Response.json(envelope, { status });
    });
    const res = await app.request("http://localhost/v1/throw-internal");
    expect(res.status).toBe(500);
    const lines = canonical();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("error");
  });
});

describe("ambient-context pass-through", () => {
  let records: LogRecord[];
  let sink: Sink;

  beforeEach(async () => {
    ({ records, sink } = collectingSink());
    await configureObservability({ level: "debug", sink, sampleRate: 1 });
  });

  afterEach(async () => {
    await reset();
  });

  const canonical = (): LogRecord[] => records.filter((r) => r.message.join("") === "canonical");

  const makeApp = (): ReturnType<typeof createRouter> => {
    const db = Db.create({
      storage: new MemoryStorage(),
      app: "router-test",
      tenant: "t1",
    });
    return createRouter({ db });
  };

  // Case A: an outer scope (simulating an adapter) has already called
  // createObservabilityContext + runWithContext before the router sees
  // the request. The router must NOT emit a second canonical line —
  // the adapter owns the flush.
  test("Case A: router emits NO canonical line when an ambient context is present", async () => {
    const app = makeApp();
    const outerCtx = createObservabilityContext({
      request_id: "outer-id",
      sampled_by_head: true,
    });

    let resStatus: number | undefined;
    await runWithContext(outerCtx, async () => {
      const res = await app.request("http://localhost/v1/t/things?where=%7B%7D");
      resStatus = res.status;
    });

    expect(resStatus).toBe(200);
    // The router must not have flushed a canonical line — the adapter owns it.
    expect(canonical()).toHaveLength(0);
  });

  // Case A also verifies healthz is unaffected (it always bypasses).
  test("Case A: /v1/healthz still emits zero canonical lines with ambient context", async () => {
    const app = makeApp();
    const outerCtx = createObservabilityContext({
      request_id: "outer-id",
      sampled_by_head: true,
    });

    await runWithContext(outerCtx, async () => {
      await app.request("http://localhost/v1/healthz");
    });

    expect(canonical()).toHaveLength(0);
  });

  // Case B: no ambient context (standalone use — createRouter mounted
  // directly). The existing create-and-flush flow runs unmodified.
  test("Case B: router emits exactly one canonical line when there is no ambient context", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/v1/t/things?where=%7B%7D", {
      headers: { "x-request-id": "standalone-id" },
    });
    expect(res.status).toBe(200);
    const lines = canonical();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.properties["request_id"]).toBe("standalone-id");
    expect(lines[0]!.properties["outcome"]).toBe("read");
  });
});

describe("in-router verifier mount", () => {
  afterEach(async () => {
    await reset();
  });

  test("verifier → null produces 401 with the diagnostic message", async () => {
    await configureObservability({ level: "debug", sink: () => {}, sampleRate: 1 });
    const db = Db.create({
      storage: new MemoryStorage(),
      app: "router-test",
      tenant: "t1",
    });
    const app = createRouter({ db, verifier: async () => null });
    const res = await app.request("http://localhost/v1/t/things?where=%7B%7D");
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    expect(body.error?.code).toBe("Unauthorized");
    expect(body.error?.message).toBe("Missing or invalid Authorization header");
  });
});
