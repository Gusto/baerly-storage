import {
  BaerlyError,
  MemoryStorage,
  WHERE_ORDER_JSON_RESOLUTION,
  WRITE_BODY_SHAPE_RESOLUTION,
} from "@baerly/protocol";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Db } from "../db.ts";
import {
  configureObservability,
  createObservabilityContext,
  runWithContext,
  withHttpObservability,
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
    await configureObservability({ level: "debug", sink });
  });

  afterEach(async () => {
    await reset();
  });

  test("BaerlyError surfaces with its own code, status, and message", () => {
    const err = new BaerlyError("NotFound", "No such row: doc-42");
    const { status, envelope } = mapError(err);
    expect(status).toBe(404);
    expect(envelope.error).toEqual({
      code: "NotFound",
      message: "No such row: doc-42",
      retriable: false,
      resolution: "No row matches this id; create it first or treat this as a miss.",
    });
  });

  test("upstream storage errors map to 502 with their own message", () => {
    const err = new BaerlyError("InvalidResponse", "GET k: missing ETag");
    const { status, envelope } = mapError(err);
    expect(status).toBe(502);
    expect(envelope.error).toEqual({
      code: "InvalidResponse",
      message: "GET k: missing ETag",
      retriable: false,
    });

    expect(mapError(new BaerlyError("NetworkError", "S3 timeout")).status).toBe(502);
  });

  test("unsatisfiable predicates are caller errors", () => {
    const { status, envelope } = mapError(
      new BaerlyError("UnsatisfiablePredicate", "empty interval"),
    );
    expect(status).toBe(400);
    expect(envelope.error.code).toBe("UnsatisfiablePredicate");
  });

  test("BaerlyError retriable override reaches the wire envelope", () => {
    const err = new BaerlyError(
      "Conflict",
      "duplicate _id",
      undefined,
      undefined,
      undefined,
      "Choose a different `_id`.",
      false,
    );
    const { status, envelope } = mapError(err);
    expect(status).toBe(409);
    expect(envelope.error).toEqual({
      code: "Conflict",
      message: "duplicate _id",
      retriable: false,
      resolution: "Choose a different `_id`.",
    });
  });

  test("unknown thrown value is sanitized and emitted via the observability channel", () => {
    const err = new TypeError("bucket=secret-prod path=/internal/keys.json");
    const { status, envelope } = mapError(err);
    expect(status).toBe(500);
    // No internal detail in the wire envelope.
    expect(envelope.error).toEqual({
      code: "Internal",
      message: "internal error",
      retriable: false,
    });
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
    expect(envelope.error).toEqual({
      code: "Internal",
      message: "internal error",
      retriable: false,
    });
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
    await configureObservability({ level: "debug", sink });
  });

  afterEach(async () => {
    await reset();
  });

  // Filter to the canonical-line records (drops any incidental
  // emissions like the `unhandled_error` event in mapError).
  const canonical = (): LogRecord[] => records.filter((r) => r.message.join("") === "canonical");

  test("successful request emits one canonical INFO line", async () => {
    const app = buildApp();
    const req = new Request("http://localhost/v1/c/things?where=%7B%22clauses%22%3A%5B%5D%7D");
    const res = await withHttpObservability(req, (r) => app.fetch(r));
    expect(res.status).toBe(200);
    const lines = canonical();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.level).toBe("info");
    expect(line.category).toEqual(["baerly", "http"]);
    const p = line.properties;
    expect(typeof p["request_id"]).toBe("string");
    expect(p["method"]).toBe("GET");
    expect(p["path"]).toBe("/v1/c/things");
    expect(p["status"]).toBe(200);
    expect(p["outcome"]).toBe("read");
    expect(typeof p["duration_ms"]).toBe("number");
    expect(p["duration_ms"] as number).toBeGreaterThanOrEqual(0);
  });

  test("failed request emits one canonical ERROR line (Conflict → 409)", async () => {
    // Register a route AFTER `createRouter` that throws Conflict
    // synthetically. Hono's compose catches the throw and routes it
    // through `onError`; the helper reconstructs the BaerlyError from
    // the wire envelope so the canonical line's `error` property
    // forces level = "error" via the canonical-line level picker.
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

    const req = new Request("http://localhost/v1/throw-conflict");
    const res = await withHttpObservability(req, (r) => conflictApp.fetch(r));
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

  test("x-request-id header is honoured", async () => {
    const app = buildApp();
    const req = new Request("http://localhost/v1/c/things?where=%7B%22clauses%22%3A%5B%5D%7D", {
      headers: { "x-request-id": "known-id" },
    });
    await withHttpObservability(req, (r) => app.fetch(r));
    const lines = canonical();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.properties["request_id"]).toBe("known-id");
  });

  test("error path emits one canonical error line", async () => {
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
    const req = new Request("http://localhost/v1/throw-internal");
    const res = await withHttpObservability(req, (r) => app.fetch(r));
    expect(res.status).toBe(500);
    const lines = canonical();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("error");
  });
});

describe("router is silent without a wrapping observability scope", () => {
  // The router no longer mounts its own observability middleware
  // (Mode A/B logic was extracted into `withHttpObservability`).
  // Production adapters open their own scope BEFORE calling
  // `app.fetch`; standalone callers use the helper. A bare
  // `app.fetch(req)` call must NOT emit a canonical line by itself —
  // otherwise adapters that already manage their scope would
  // double-emit.

  let records: LogRecord[];
  let sink: Sink;

  beforeEach(async () => {
    ({ records, sink } = collectingSink());
    await configureObservability({ level: "debug", sink });
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

  test("bare app.fetch under an outer scope emits no router-owned canonical line", async () => {
    const app = makeApp();
    const outerCtx = createObservabilityContext({
      request_id: "outer-id",
    });

    let resStatus: number | undefined;
    await runWithContext(outerCtx, async () => {
      const res = await app.request(
        "http://localhost/v1/c/things?where=%7B%22clauses%22%3A%5B%5D%7D",
      );
      resStatus = res.status;
    });

    expect(resStatus).toBe(200);
    expect(canonical()).toHaveLength(0);
  });

  test("bare app.fetch with no outer scope still emits no router-owned canonical line", async () => {
    const app = makeApp();
    const res = await app.request(
      "http://localhost/v1/c/things?where=%7B%22clauses%22%3A%5B%5D%7D",
    );
    expect(res.status).toBe(200);
    expect(canonical()).toHaveLength(0);
  });
});

describe("request-path 400s carry a resolution hint", () => {
  test("flat-body 400 teaches the wrap-it resolution", async () => {
    const app = buildApp();
    const res = await app.request("/v1/c/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "hi" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      readonly error: { readonly code: string; readonly resolution?: string };
    };
    expect(body.error.code).toBe("SchemaError");
    expect(body.error.resolution).toBe(WRITE_BODY_SHAPE_RESOLUTION);
  });

  test("invalid ?where= JSON teaches the URL-encoded-JSON resolution", async () => {
    const app = buildApp();
    const res = await app.request("/v1/c/notes?where=not-json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      readonly error: { readonly code: string; readonly resolution?: string };
    };
    expect(body.error.resolution).toBe(WHERE_ORDER_JSON_RESOLUTION);
  });
});

describe("collection-segment validation closes the traversal bypass", () => {
  type ErrorEnvelope = { error: { code: string; message: string } };

  // `GET /v1/since?collection=..` — the handler's inline reject only
  // catches empty / `/`; `..` slips past it into `longPollSince` →
  // `db.getCurrentJson` / `db.getLogEntry`. Without the db-layer guard
  // this reaches storage with an unvalidated traversal segment. The
  // synchronous `assertPathSegment` throw fires before any poll, so no
  // timeout wiring is needed.
  test("GET /v1/since?collection=.. is rejected InvalidConfig (no storage reach)", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost/v1/since?collection=..");
    expect(res.status).toBe(400);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("InvalidConfig");
  });

  // `GET /v1/since?collection=<control char>` — same path; the inline
  // reject doesn't screen control bytes either.
  test("GET /v1/since?collection=<NUL> is rejected InvalidConfig", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost/v1/since?collection=a%00b");
    expect(res.status).toBe(400);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("InvalidConfig");
  });

  // `GET /v1/c/:collection` param. A literal `..` segment is collapsed
  // by the URL layer before routing, so we send the percent-encoded
  // form. EMPIRICAL (pinned, not assumed): under Hono a *bare*
  // `%2e%2e` is normalized to `..` and the path-traversal collapse
  // makes the `:collection` route fail to match entirely → 404, the
  // handler never runs. So a bare `%2e%2e` can't reach storage.
  test("GET /v1/c/%2e%2e never matches the :collection route (Hono collapses it → 404)", async () => {
    const app = buildApp();
    const res = await app.request("http://localhost/v1/c/%2e%2e");
    expect(res.status).toBe(404);
  });

  // The variants that DO survive Hono's normalization and reach the
  // handler decode to a `..`-bearing / control-bearing segment. These
  // are the real regression pins: confirm the HTTP layer doesn't mangle
  // the segment into something that bypasses `assertKeySegment`. Each
  // is rejected InvalidConfig by Task 1's strengthened guard inside
  // `db.collectionReadContext`, and the route surfaces that rejection.
  // (Already GREEN after Task 1; kept here as a regression pin.)
  test.each([
    ["http://localhost/v1/c/%2e%2e%2fx?where=%7B%22clauses%22%3A%5B%5D%7D", ".. → ../x"],
    ["http://localhost/v1/c/a%00b?where=%7B%22clauses%22%3A%5B%5D%7D", "NUL byte"],
  ])("GET %s reaches the handler and is rejected InvalidConfig (%s)", async (url) => {
    const app = buildApp();
    const res = await app.request(url);
    expect(res.status).toBe(400);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("InvalidConfig");
  });
});
