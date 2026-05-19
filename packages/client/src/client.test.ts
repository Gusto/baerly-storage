/* eslint-disable no-underscore-dangle -- `_id` and `_meta` are the
   locked wire-shape field names mirrored from the server contract. */

import type { Table } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { type ClientTable, createBaerlyClient } from "./client.ts";
import type { HttpOkEnvelope, SinceResponse } from "./contract.ts";
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
  test("table().where().all() issues GET /v1/t/<name>?where=<json>", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/t/tickets", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("where")).toBe('{"status":"open"}');
      return jsonResponse(okEnvelope([{ _id: "a", status: "open" }]));
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const rows = await client.table("tickets").where({ status: "open" }).all();
    expect(rows).toEqual([{ _id: "a", status: "open" }]);
  });

  test("table().insert() issues POST /v1/t/<name> with { doc } and unwraps { _id }", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/t/tickets", async (req) => {
      const body = (await req.json()) as { doc: unknown };
      expect(body).toEqual({ doc: { title: "hello" } });
      return jsonResponse({ _id: "doc-1" }, 201);
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const { _id } = await client
      .table<{ _id: string; title: string }>("tickets")
      .insert({ title: "hello" });
    expect(_id).toBe("doc-1");
  });

  test("first() sets limit=1 and returns undefined on empty", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/t/tickets", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("limit")).toBe("1");
      return jsonResponse(okEnvelope([]));
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const row = await client.table("tickets").where({ _id: "missing" }).first();
    expect(row).toBeUndefined();
  });

  test("update() PATCHes /v1/t/<name>/<id> with { patch } and returns thin { modified }", async () => {
    const mock = new MockFetch();
    mock.on("PATCH", "/v1/t/tickets/:id", async (req) => {
      const body = (await req.json()) as { patch: unknown };
      expect(body).toEqual({ patch: { status: "closed" } });
      return jsonResponse({ modified: 1 });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const res = await client.table("tickets").where({ _id: "x" }).update({ status: "closed" });
    expect(res).toEqual({ modified: 1 });
  });

  test("delete() returns { deleted: 1 } on 204", async () => {
    const mock = new MockFetch();
    mock.on("DELETE", "/v1/t/tickets/:id", () => new Response(null, { status: 204 }));
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const res = await client.table("tickets").where({ _id: "x" }).delete();
    expect(res).toEqual({ deleted: 1 });
  });

  test("delete() returns { deleted: 0 } on 404 (not an error)", async () => {
    const mock = new MockFetch();
    mock.on("DELETE", "/v1/t/tickets/:id", () =>
      jsonResponse({ error: { code: "NotFound", message: "No such row: x" } }, 404),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const res = await client.table("tickets").where({ _id: "x" }).delete();
    expect(res).toEqual({ deleted: 0 });
  });

  test("4xx throws BaerlyClientError with decoded code + status", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/t/tickets", () =>
      jsonResponse({ error: { code: "Unauthorized", message: "Bad token" } }, 401),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.table("tickets").insert({ x: 1 })).rejects.toMatchObject({
      name: "BaerlyClientError",
      code: "Unauthorized",
      status: 401,
    });
  });

  test("update()/replace()/delete() throw SchemaError without .where({_id})", async () => {
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: new MockFetch().fetch });
    await expect(
      client.table("tickets").where({ status: "open" }).update({ x: 1 }),
    ).rejects.toMatchObject({ code: "SchemaError" });
    await expect(
      client.table("tickets").where({ status: "open" }).replace({ _id: "x", status: "closed" }),
    ).rejects.toMatchObject({ code: "SchemaError" });
    await expect(client.table("tickets").where({ status: "open" }).delete()).rejects.toMatchObject({
      code: "SchemaError",
    });
  });

  test("since() returns { events, next_cursor } from GET /v1/since", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("table")).toBe("tickets");
      expect(url.searchParams.get("cursor")).toBe("");
      const body: SinceResponse = { events: [], next_cursor: "" };
      return jsonResponse(body);
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const res = await client.since({ table: "tickets" });
    expect(res).toEqual({ events: [], next_cursor: "" });
  });

  test("healthz() returns true on 200, false otherwise", async () => {
    const mock = new MockFetch();
    let returnOk = true;
    mock.on("GET", "/v1/healthz", () =>
      returnOk
        ? jsonResponse({ data: { ok: true }, _meta: { manifest_pointer: "none@0", fresh: true } })
        : jsonResponse({ error: { code: "Internal", message: "boom" } }, 500),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.healthz()).resolves.toBe(true);
    returnOk = false;
    await expect(client.healthz()).resolves.toBe(false);
  });

  test("dynamic headers callback resolves per request", async () => {
    const mock = new MockFetch();
    let calls = 0;
    mock.on("GET", "/v1/t/tickets", (req) => {
      calls += 1;
      expect(req.headers.get("authorization")).toBe(`Bearer token-${calls}`);
      return jsonResponse(okEnvelope([{ _id: "x" }]));
    });
    let counter = 0;
    const client = createBaerlyClient({
      baseUrl: "http://x",
      fetch: mock.fetch,
      headers: async () => {
        counter += 1;
        return { Authorization: `Bearer token-${counter}` };
      },
    });
    await client.table("tickets").where({ _id: "x" }).first();
    await client.table("tickets").where({ _id: "y" }).first();
    expect(calls).toBe(2);
  });

  test("consistency() forwards as ?consistency=<level>", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/t/tickets", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("consistency")).toBe("eventual");
      return jsonResponse(okEnvelope([]));
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await client.table("tickets").consistency("eventual").where({}).all();
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
    mock.on("GET", "/v1/t/tickets", (req) => {
      sawSignal = req.signal;
      return hangUntilAbort(req);
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const controller = new AbortController();
    const inflight = client.table("tickets").where({}).all({ signal: controller.signal });
    controller.abort();
    await expect(inflight).rejects.toMatchObject({ name: "AbortError" });
    expect(sawSignal?.aborted).toBe(true);
  });

  test("constructor signal and per-call signal both abort (signals are merged)", async () => {
    const mock = new MockFetch();
    mock.on("PATCH", "/v1/t/tickets/:id", hangUntilAbort);
    const lifecycle = new AbortController();
    const client = createBaerlyClient({
      baseUrl: "http://x",
      fetch: mock.fetch,
      signal: lifecycle.signal,
    });
    // Lifecycle signal fires → in-flight PATCH aborts.
    const inflight = client.table("tickets").where({ _id: "x" }).update({ title: "y" });
    lifecycle.abort();
    await expect(inflight).rejects.toMatchObject({ name: "AbortError" });

    // Fresh client, per-call signal fires → in-flight PATCH aborts.
    const client2 = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const perCall = new AbortController();
    const inflight2 = client2
      .table("tickets")
      .where({ _id: "x" })
      .update({ title: "y" }, { signal: perCall.signal });
    perCall.abort();
    await expect(inflight2).rejects.toMatchObject({ name: "AbortError" });
  });

  test("missing data field on 200 throws InvalidResponse", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/t/tickets", () => jsonResponse({ rubbish: 1 }));
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    await expect(client.table("tickets").where({}).all()).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });
});

// Shape-parity compile-time check (§5.6 of the ticket). The
// client-side `ClientTable` must remain a structural superset of the
// methods we expose from `@baerly/protocol`'s `Table<T>` — `name`,
// `where`, `insert`, `count`. tsgo errors here when the surfaces
// drift. Pure type position; no runtime emit.
type _ShapeParityProbe =
  ClientTable<{ _id: string; status: string }> extends Pick<
    Table<{ _id: string; status: string }>,
    "name" | "where" | "insert" | "count"
  >
    ? true
    : never;
const _shapeParity: _ShapeParityProbe = true;
void _shapeParity;
