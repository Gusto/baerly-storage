/* eslint-disable no-underscore-dangle -- `_id` and `_meta` are the
   locked wire-shape field names mirrored from the server contract. */

import { type Collection, type DocumentData, isUuidV7 } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { type ClientCollection, createBaerlyClient } from "./client.ts";
import type { HttpOkEnvelope } from "./contract.ts";
import { MockFetch } from "./testing/index.ts";

const okEnvelope = <T>(data: T): HttpOkEnvelope<T> => ({
  data,
  _meta: { manifest_pointer: "mock-cursor", fresh: true },
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("createBaerlyClient", () => {
  test("table().where().all() issues GET /v1/c/<name>?where=<wire-json>", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/tickets", (req) => {
      const url = new URL(req.url);
      // Object-form predicate normalises to a wire-form predicate
      // on the way out — the client serialises the wire directly.
      expect(url.searchParams.get("where")).toBe(
        JSON.stringify({ clauses: [{ op: "eq", field: "status", value: "open" }] }),
      );
      return jsonResponse(okEnvelope([{ _id: "a", status: "open" }]));
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const rows = await client.collection("tickets").where({ status: "open" }).all();
    expect(rows).toEqual([{ _id: "a", status: "open" }]);
  });

  test("table().insert() issues POST /v1/c/<name> with { doc, mintedId } and unwraps { _id }", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", async (req) => {
      const body = (await req.json()) as { doc: { _id: string } };
      expect(body).toEqual({
        doc: { title: "hello", _id: expect.any(String) },
        mintedId: body.doc._id,
      });
      return jsonResponse({ _id: "doc-1" }, 201);
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const { _id } = await client.collection("tickets").insert({ title: "hello" });
    expect(_id).toBe("doc-1");
  });

  describe("insert() auto-ID minting", () => {
    const capture = () => {
      const mock = new MockFetch();
      const bodies: Array<Record<string, unknown>> = [];
      mock.on("POST", "/v1/c/tickets", async (req) => {
        const body = (await req.json()) as Record<string, unknown>;
        bodies.push(body);
        return jsonResponse({ _id: (body["doc"] as { _id: string })._id }, 201);
      });
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
      return { bodies, tickets: client.collection("tickets") };
    };

    test.each<[string, DocumentData]>([
      ["omitted", { title: "a" }],
      ["undefined", { _id: undefined as unknown as string, title: "a" }],
      ["empty string", { _id: "", title: "a" }],
    ])("mints a UUIDv7 _id and flags it with mintedId when _id is %s", async (_label, doc) => {
      const { bodies, tickets } = capture();
      const { _id } = await tickets.insert(doc);
      const body = bodies[0] as { doc: { _id: string; title: string }; mintedId: string };
      expect(isUuidV7(body.doc._id)).toBe(true);
      expect(body).toEqual({ doc: { title: "a", _id: body.doc._id }, mintedId: body.doc._id });
      expect(_id).toBe(body.doc._id);
    });

    test("sends a caller-supplied _id unchanged, with no mintedId key", async () => {
      const { bodies, tickets } = capture();
      await tickets.insert({ _id: "t-1", title: "a" });
      expect(bodies[0]).toEqual({ doc: { _id: "t-1", title: "a" } });
      expect("mintedId" in (bodies[0] as object)).toBe(false);
    });

    test("treats a non-string _id like an omitted one, as the server does", async () => {
      const { bodies, tickets } = capture();
      await tickets.insert({ _id: 7 as unknown as string, title: "a" });
      const body = bodies[0] as { doc: { _id: string }; mintedId: string };
      expect(isUuidV7(body.doc._id)).toBe(true);
      expect(body).toEqual({ doc: { title: "a", _id: body.doc._id }, mintedId: body.doc._id });
    });

    test("does not mutate the caller's document", async () => {
      const { tickets } = capture();
      const doc: { _id?: string; title: string } = { title: "a" };
      await tickets.insert(doc);
      expect(doc).toEqual({ title: "a" });
      expect("_id" in doc).toBe(false);
    });

    test("two inserts mint different ids", async () => {
      const { bodies, tickets } = capture();
      await tickets.insert({ title: "a" });
      await tickets.insert({ title: "a" });
      const ids = bodies.map((b) => (b["doc"] as { _id: string })._id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  test("get() issues GET /v1/c/<name>/<id> and returns undefined on 404", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/tickets/:id", () =>
      jsonResponse({ error: { code: "NotFound", message: "No such row: missing" } }, 404),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const row = await client.collection("tickets").get("missing");
    expect(row).toBeUndefined();
  });

  test("update() PATCHes /v1/c/<name>/<id> with { patch } and returns thin { modified }", async () => {
    const mock = new MockFetch();
    mock.on("PATCH", "/v1/c/tickets/:id", async (req) => {
      const body = (await req.json()) as { patch: unknown };
      expect(body).toEqual({ patch: { status: "closed" } });
      return jsonResponse({ modified: 1 });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const res = await client.collection("tickets").update("x", { status: "closed" });
    expect(res).toEqual({ modified: 1 });
  });

  test("replace() PUTs /v1/c/<name>/<id> with { doc } (full-document overwrite, not merge)", async () => {
    const mock = new MockFetch();
    let sawPatch = false;
    mock.on("PATCH", "/v1/c/tickets/:id", () => {
      sawPatch = true;
      return jsonResponse({ modified: 1 });
    });
    mock.on("PUT", "/v1/c/tickets/:id", async (req) => {
      const body = (await req.json()) as { doc: unknown };
      expect(body).toEqual({ doc: { _id: "x", status: "closed" } });
      return jsonResponse({ modified: 1 });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await client.collection("tickets").replace("x", { _id: "x", status: "closed" });
    expect(sawPatch).toBe(false);
  });

  test("delete() returns { deleted: 1 } on 204", async () => {
    const mock = new MockFetch();
    mock.on("DELETE", "/v1/c/tickets/:id", () => new Response(null, { status: 204 }));
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const res = await client.collection("tickets").delete("x");
    expect(res).toEqual({ deleted: 1 });
  });

  test("delete() returns { deleted: 0 } on 404 (not an error)", async () => {
    const mock = new MockFetch();
    mock.on("DELETE", "/v1/c/tickets/:id", () =>
      jsonResponse({ error: { code: "NotFound", message: "No such row: x" } }, 404),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const res = await client.collection("tickets").delete("x");
    expect(res).toEqual({ deleted: 0 });
  });

  test("4xx throws BaerlyError with decoded code + status", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", () =>
      jsonResponse({ error: { code: "Unauthorized", message: "Bad token" } }, 401),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").insert({ x: 1 })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "Unauthorized",
      status: 401,
    });
  });

  test("wire resolution is rebuilt onto BaerlyError.resolution", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", () =>
      jsonResponse({ error: { code: "InvalidConfig", message: "bad", resolution: "do X" } }, 400),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").insert({ x: 1 })).rejects.toMatchObject({
      code: "InvalidConfig",
      resolution: "do X",
    });
  });

  test("count() issues GET /v1/count and returns scalar (does not download rows)", async () => {
    const mock = new MockFetch();
    let sawListGet = false;
    mock.on("GET", "/v1/c/tickets", () => {
      sawListGet = true;
      return jsonResponse(okEnvelope([{ _id: "a" }, { _id: "b" }, { _id: "c" }]));
    });
    mock.on("GET", "/v1/count", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("collection")).toBe("tickets");
      expect(url.searchParams.get("where")).toBe(
        JSON.stringify({ clauses: [{ op: "eq", field: "status", value: "open" }] }),
      );
      return jsonResponse({
        data: { count: 42 },
        _meta: { manifest_pointer: "mock-cursor", fresh: true },
      });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const n = await client.collection("tickets").where({ status: "open" }).count();
    expect(n).toBe(42);
    expect(sawListGet).toBe(false);
  });

  test("table().count() (no predicate) issues GET /v1/count without ?where=", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/count", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("collection")).toBe("tickets");
      expect(url.searchParams.has("where")).toBe(false);
      return jsonResponse({
        data: { count: 7 },
        _meta: { manifest_pointer: "mock-cursor", fresh: true },
      });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const n = await client.collection("tickets").count();
    expect(n).toBe(7);
  });

  test("order() forwards as ?order=<json>", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/tickets", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("order")).toBe('{"created_at":"desc"}');
      return jsonResponse(okEnvelope([]));
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await client.collection("tickets").order({ created_at: "desc" }).all();
  });

  // Mirrors what a real `fetch` does with an aborted signal: reject
  // immediately if already aborted, otherwise reject when it fires.
  const hangUntilAbort = (req: Request): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      if (req.signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      req.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });

  test("per-call signal aborts an in-flight terminal request", async () => {
    const mock = new MockFetch();
    let sawSignal: AbortSignal | undefined;
    mock.on("GET", "/v1/c/tickets", (req) => {
      sawSignal = req.signal;
      return hangUntilAbort(req);
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const controller = new AbortController();
    const inflight = client.collection("tickets").where({}).all({ signal: controller.signal });
    controller.abort();
    await expect(inflight).rejects.toMatchObject({ name: "AbortError" });
    expect(sawSignal?.aborted).toBe(true);
  });

  test("missing data field on 200 throws InvalidResponse", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/tickets", () => jsonResponse({ rubbish: 1 }));
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").where({}).all()).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  // §3.9 — wire decoder preserves issues + surfaces retriable
  test("client rebuilds issues + retriable from the error envelope", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", () =>
      jsonResponse(
        {
          error: {
            code: "SchemaError",
            message: "bad",
            retriable: false,
            issues: [{ path: ["title"], message: "required" }],
          },
        },
        400,
      ),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").insert({ x: 1 })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "SchemaError",
      status: 400,
      retriable: false,
      issues: [{ path: ["title"], message: "required" }],
    });
  });

  test("client surfaces retriable:true on WriteConflict", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", () =>
      jsonResponse({ error: { code: "WriteConflict", message: "CAS lost", retriable: true } }, 409),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").insert({ x: 1 })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "WriteConflict",
      status: 409,
      retriable: true,
    });
  });

  test("client round-trips retryAfter on MaintenancePending", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", () =>
      jsonResponse(
        {
          error: {
            code: "MaintenancePending",
            message: "maintenance is catching up",
            retriable: true,
            retryAfter: 3,
          },
        },
        503,
      ),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").insert({ x: 1 })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "MaintenancePending",
      status: 503,
      retriable: true,
      retryAfter: 3,
    });
  });

  test("client surfaces retriable:false on AlreadyExists", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", () =>
      jsonResponse(
        { error: { code: "AlreadyExists", message: "duplicate _id", retriable: false } },
        409,
      ),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").insert({ _id: "x" })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "AlreadyExists",
      status: 409,
      retriable: false,
    });
  });

  test.each([
    ["WriteConflict", false, true],
    ["AlreadyExists", true, false],
  ] as const)(
    "client derives retriable from code, ignoring wire %s retriable:%s",
    async (code, wireRetriable, expected) => {
      // The wire field is advisory for non-SDK consumers. The SDK reads the
      // code, so a wire value that disagrees with the code cannot flip it.
      const mock = new MockFetch();
      mock.on("POST", "/v1/c/tickets", () =>
        jsonResponse({ error: { code, message: "x", retriable: wireRetriable } }, 409),
      );
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
      await expect(client.collection("tickets").insert({ x: 1 })).rejects.toMatchObject({
        code,
        status: 409,
        retriable: expected,
      });
    },
  );

  test.each([
    // An older server's removed `Conflict` code: a 4xx, so it fails closed.
    ["Conflict", 409, "Internal", false],
    // A newer server's code (e.g. backpressure): a 5xx, so it stays retriable.
    ["SomeFutureCode", 503, "NetworkError", true],
    // Throttling and request timeouts clear on their own, so they stay retriable.
    ["Throttled", 429, "NetworkError", true],
    ["SomeFutureCode", 408, "NetworkError", true],
  ] as const)(
    "an unknown wire code %s (%i) decodes by status as %s",
    async (wireCode, status, code, retriable) => {
      const wire = { code: wireCode, message: "from another version", retriable: true };
      const mock = new MockFetch();
      mock.on("POST", "/v1/c/tickets", () => jsonResponse({ error: wire }, status));
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
      await expect(client.collection("tickets").insert({ x: 1 })).rejects.toMatchObject({
        name: "BaerlyError",
        code,
        status,
        retriable,
        message: "from another version",
        cause: wire,
      });
    },
  );

  test("an unknown wire code drops resolution, issues and _id that belong to it", async () => {
    const wire = {
      code: "Conflict",
      message: "write conflict",
      retriable: true,
      resolution: "Re-read and retry.",
      issues: [{ path: ["a"], message: "x" }],
      _id: "row-1",
    };
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", () => jsonResponse({ error: wire }, 409));
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const err = await client
      .collection("tickets")
      .insert({ x: 1 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(err).toMatchObject({ code: "Internal", retriable: false, cause: wire });
    const decoded = err as { resolution?: unknown; issues?: unknown; _id?: unknown };
    expect(decoded.resolution).toBeUndefined();
    expect(decoded.issues).toBeUndefined();
    expect(decoded._id).toBeUndefined();
  });

  test.each([
    [429, "NetworkError", true],
    [408, "NetworkError", true],
    [502, "NetworkError", true],
    [404, "Internal", false],
  ] as const)("an envelope-less %i decodes as %s", async (status, code, retriable) => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/tickets", () => new Response("upstream says no", { status }));
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").all()).rejects.toMatchObject({
      code,
      status,
      retriable,
    });
  });
});

// Shape-parity compile-time check. The client-side `ClientCollection`
// keeps the same method names as `@baerly/protocol`'s `Collection<T>` for
// the read-side terminals (`name`, `count`, `get`, `first`, `all`).
// Mutation verbs (`insert`, `update`, `replace`, `delete`) on
// `ClientCollection<T>` are intentionally NOT structural subtypes of
// `Collection<T>` — `ClientCollection` adds a trailing `opts?: TerminalOptions`
// bag that `Collection<T>` does not carry — but the names match
// 1:1 so call-site refactors port across. `where` returns
// `ClientQuery<T>` (a structural subset of `Query<T>` — no mutation
// verbs on the wire) so it is not asserted here either. tsgo errors
// when one of the read-side names drifts. Pure type position; no
// runtime emit.
type _ShapeParityProbe =
  ClientCollection<{ _id: string; status: string }> extends Pick<
    Collection<{ _id: string; status: string }>,
    "name" | "count"
  >
    ? true
    : never;
const _shapeParity: _ShapeParityProbe = true;
void _shapeParity;
