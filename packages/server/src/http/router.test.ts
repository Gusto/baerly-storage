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

  test("upstream storage errors map to 502 with scrubbed messages", () => {
    const err = new BaerlyError(
      "InvalidResponse",
      "GET app/router-test/tenant/t1/manifests/notes/current.json: missing ETag",
    );
    const { status, envelope } = mapError(err);
    expect(status).toBe(502);
    expect(envelope.error).toEqual({
      code: "InvalidResponse",
      message: "upstream response error",
      retriable: false,
    });
    expect(envelope.error.message).not.toContain("current.json");
    expect(records).toHaveLength(1);
    const serialized = records[0]!.properties["error"] as { code: string; message: string };
    expect(serialized.code).toBe("InvalidResponse");
    expect(serialized.message).toContain("current.json");

    const network = mapError(
      new BaerlyError(
        "NetworkError",
        "LIST app/router-test/tenant/t1/manifests/notes: 503 upstream body",
      ),
    );
    expect(network.status).toBe(502);
    expect(network.envelope.error).toEqual({
      code: "NetworkError",
      message: "upstream network error",
      retriable: true,
    });
  });

  test("AccessDenied is scrubbed on the wire but logged in full", () => {
    const err = new BaerlyError(
      "AccessDenied",
      "GET app/router-test/tenant/t1/manifests/notes/current.json: provider denied bucket policy",
    );
    const { status, envelope } = mapError(err);
    expect(status).toBe(403);
    expect(envelope.error).toEqual({
      code: "AccessDenied",
      message: "access denied",
      retriable: false,
      resolution: "These credentials are denied for this tenant prefix or bucket policy.",
    });
    expect(envelope.error.message).not.toContain("current.json");
    expect(records).toHaveLength(1);
    const serialized = records[0]!.properties["error"] as { code: string; message: string };
    expect(serialized.code).toBe("AccessDenied");
    expect(serialized.message).toContain("current.json");
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

  test("retriable Conflict is scrubbed but non-retriable caller Conflict stays actionable", () => {
    const storageConflict = new BaerlyError(
      "Conflict",
      "Writer: CAS conflict on app/router-test/tenant/t1/manifests/notes/current.json",
      undefined,
      undefined,
      undefined,
      "Re-read and re-apply your change.",
      true,
    );
    expect(mapError(storageConflict).envelope.error).toEqual({
      code: "Conflict",
      message: "write conflict",
      retriable: true,
      resolution: "Re-read and re-apply your change.",
    });

    const callerConflict = new BaerlyError(
      "Conflict",
      "duplicate _id",
      undefined,
      undefined,
      undefined,
      "Choose a different `_id`.",
      false,
    );
    expect(mapError(callerConflict).envelope.error).toEqual({
      code: "Conflict",
      message: "duplicate _id",
      retriable: false,
      resolution: "Choose a different `_id`.",
    });
  });

  test("InvalidConfig scrubs storage config detail by default", () => {
    const storageError = new BaerlyError(
      "InvalidConfig",
      "LocalFsStorage: resolved path escapes root: app/router-test/tenant/t1/manifests/notes/current.json",
    );
    expect(mapError(storageError).envelope.error).toEqual({
      code: "InvalidConfig",
      message: "invalid server configuration",
      retriable: false,
    });
    const serialized = records[0]!.properties["error"] as { code: string; message: string };
    expect(serialized.message).toContain("current.json");
  });

  test("Internal BaerlyError is scrubbed on the wire but logged in full", () => {
    // Server-thrown protocol-invariant violations embed bucket-key /
    // log-prefix layout in their message; that detail must never reach
    // the client, only the server-side log.
    const err = new BaerlyError(
      "Internal",
      "compact: snapshot pointer router-test/notes/t1/manifests/notes/snapshot/L0/0000-sha256.json resolves to no body; protocol violation",
    );
    const { status, envelope } = mapError(err);
    expect(status).toBe(500);
    // Wire envelope carries no internal layout detail.
    expect(envelope.error).toEqual({
      code: "Internal",
      message: "internal error",
      retriable: false,
    });
    // The full message reaches the structured server-side channel.
    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe("error");
    expect(records[0]!.category).toEqual(["baerly", "http"]);
    expect(records[0]!.message.join("")).toBe("scrubbed_error");
    const serialized = records[0]!.properties["error"] as { code: string; message: string };
    expect(serialized.code).toBe("Internal");
    expect(serialized.message).toContain("snapshot/L0/0000-sha256.json");
  });

  test("client-runtime-only BaerlyError codes collapse to Internal on HTTP", () => {
    const err = new BaerlyError(
      "UseQueryAwaitedRecorder",
      "useQuery recorder error should never reach the server",
    );
    const { status, envelope } = mapError(err);
    expect(status).toBe(500);
    expect(envelope.error).toEqual({
      code: "Internal",
      message: "internal error",
      retriable: false,
    });
    expect(records).toHaveLength(1);
    const serialized = records[0]!.properties["error"] as { code: string; message: string };
    expect(serialized.code).toBe("UseQueryAwaitedRecorder");
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

  test("failed request emits one canonical WARN line (Conflict → 409)", async () => {
    // Register a route AFTER `createRouter` that throws Conflict
    // synthetically. Hono's compose catches the throw and routes it
    // through `onError`; the helper reconstructs the BaerlyError from
    // the wire envelope onto the canonical line's `error` property.
    // A 409 is client-attributable and routine — so the line is `warn`,
    // not `error`: status is authoritative and an attached error does not
    // escalate a 4xx.
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
    expect(line.level).toBe("warning");
    const p = line.properties;
    expect(p["status"]).toBe(409);
    expect(p["outcome"]).toBe("conflict");
    const err = p["error"] as { code: string; message: string };
    expect(err.code).toBe("Conflict");
    expect(err.message).toBe("write conflict");
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
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({ code: "Internal", message: "internal error" });
    const lines = canonical();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("error");
  });

  test("router scrubs storage key detail from malformed current.json errors", async () => {
    const storage = new MemoryStorage();
    await storage.put(
      "app/router-test/tenant/t1/manifests/notes/current.json",
      new TextEncoder().encode("{not json"),
    );
    const db = Db.create({
      storage,
      app: "router-test",
      tenant: "t1",
    });
    const app = createRouter({ db });
    const req = new Request("http://localhost/v1/c/notes");
    const res = await withHttpObservability(req, (r) => app.fetch(r));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({
      code: "InvalidResponse",
      message: "upstream response error",
      retriable: false,
    });
    expect(JSON.stringify(body)).not.toContain("current.json");
    expect(JSON.stringify(body)).not.toContain("router-test");
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

  test("predicate InvalidConfig from ?where= keeps caller-facing guidance", async () => {
    const app = buildApp();
    const where = encodeURIComponent(
      JSON.stringify({ clauses: [{ op: "eq", field: "_id", value: "x" }] }),
    );
    const res = await app.request(`/v1/c/notes?where=${where}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(body.error.code).toBe("InvalidConfig");
    expect(body.error.message).toContain('Predicates may not key on "_id"');
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
