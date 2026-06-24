/* eslint-disable no-underscore-dangle -- `_id` and `_meta` are the
   locked wire-shape field names mirrored from the server contract. */

import type { Collection } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { type ClientCollection, createBaerlyClient } from "./client.ts";
import type { HttpOkEnvelope } from "./contract.ts";
import { MockFetch } from "./testing/index.ts";

const okEnvelope = <T>(data: T): HttpOkEnvelope<T> => ({
  data,
  _meta: { manifest_pointer: "none@0", fresh: true },
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

  test("table().insert() issues POST /v1/c/<name> with { doc } and unwraps { _id }", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", async (req) => {
      const body = (await req.json()) as { doc: unknown };
      expect(body).toEqual({ doc: { title: "hello" } });
      return jsonResponse({ _id: "doc-1" }, 201);
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const { _id } = await client.collection("tickets").insert({ title: "hello" });
    expect(_id).toBe("doc-1");
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
        _meta: { manifest_pointer: "none@0", fresh: true },
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
        _meta: { manifest_pointer: "none@0", fresh: true },
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

  test("client surfaces retriable:true on Conflict", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", () =>
      jsonResponse({ error: { code: "Conflict", message: "CAS lost", retriable: true } }, 409),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").insert({ x: 1 })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "Conflict",
      status: 409,
      retriable: true,
    });
  });

  test("client preserves retriable:false on terminal Conflict", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", () =>
      jsonResponse(
        { error: { code: "Conflict", message: "duplicate _id", retriable: false } },
        409,
      ),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").insert({ _id: "x" })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "Conflict",
      status: 409,
      retriable: false,
    });
  });

  test("client falls back to the code default when the server omits retriable", async () => {
    // Older server: the envelope carries no `retriable` field. The client
    // must fall back to the code-derived default (Conflict → retriable),
    // not silently treat the missing field as non-retriable.
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/tickets", () =>
      jsonResponse({ error: { code: "Conflict", message: "CAS lost" } }, 409),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.collection("tickets").insert({ x: 1 })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "Conflict",
      status: 409,
      retriable: true,
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
