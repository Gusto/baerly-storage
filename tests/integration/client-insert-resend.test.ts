import { createBaerlyClient } from "@baerly/client";
import { MemoryStorage, uuidv7 } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import { expect, test } from "vitest";

test("a resent auto-ID insert replays as the original success and leaves one row", async () => {
  const db = Db.create({ storage: new MemoryStorage(), app: "client-resend", tenant: "test" });
  const router = createRouter({ db });
  const results: Array<{ status: number; body: unknown }> = [];
  const client = createBaerlyClient({
    baseUrl: "http://localhost",
    // Simulates a lost response: the same request reaches the server
    // twice, and the caller sees only the second answer.
    fetch: async (request) => {
      const resend = request.clone();
      const first = await router.fetch(request);
      results.push({ status: first.status, body: await first.json() });
      const second = await router.fetch(resend);
      results.push({ status: second.status, body: await second.clone().json() });
      return second;
    },
  });

  const { _id } = await client.collection("tickets").insert({ title: "once" });

  expect(results.map((r) => r.status)).toEqual([201, 201]);
  expect(results[0]?.body).toEqual(results[1]?.body);
  expect(results[1]?.body).toEqual({ _id });
  await expect(db.collection("tickets").where({}).all()).resolves.toHaveLength(1);
});

test("an accepted deeply nested insert supports an identical HTTP resend", async () => {
  const db = Db.create({ storage: new MemoryStorage(), app: "client-resend", tenant: "deep" });
  const router = createRouter({ db });
  // Deep enough to exercise a nested replay end to end, and well under the
  // depth at which V8's recursive JSON.stringify overflows a test worker's
  // stack. The comparator's own stack safety is pinned in `json.test.ts`.
  let nested: Record<string, unknown> = {};
  for (let i = 0; i < 1000; i++) {
    nested = { nested };
  }
  const _id = uuidv7();
  const body = JSON.stringify({ doc: { _id, nested }, mintedId: _id });
  const send = () =>
    router.request("/v1/c/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  const first = await send();
  expect(first.status).toBe(201);
  await expect(first.json()).resolves.toEqual({ _id });
  const replay = await send();
  expect(replay.status).toBe(201);
  await expect(replay.json()).resolves.toEqual({ _id });
  await expect(db.collection("notes").where({}).all()).resolves.toHaveLength(1);
});

test("a minted resend after deletion reinserts the row", async () => {
  const db = Db.create({ storage: new MemoryStorage(), app: "client-resend", tenant: "deleted" });
  const router = createRouter({ db });
  const _id = uuidv7();
  const doc = { _id, title: "original" };
  const send = () =>
    router.request("/v1/c/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc, mintedId: _id }),
    });
  const first = await send();
  expect(first.status).toBe(201);
  await db.collection("notes").delete(_id);
  await expect(db.collection("notes").get(_id)).resolves.toBeUndefined();
  const resend = await send();
  expect(resend.status).toBe(201);
  await expect(resend.json()).resolves.toEqual({ _id });
  await expect(db.collection("notes").get(_id)).resolves.toEqual(doc);
});

test("a minted resend compares the current body after updates", async () => {
  const db = Db.create({ storage: new MemoryStorage(), app: "client-resend", tenant: "updated" });
  const router = createRouter({ db });
  const _id = uuidv7();
  const doc = { _id, title: "original" };
  const send = () =>
    router.request("/v1/c/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc, mintedId: _id }),
    });
  const first = await send();
  expect(first.status).toBe(201);
  await db.collection("notes").update(_id, { title: "changed" });
  const collision = await send();
  expect(collision.status).toBe(409);
  await expect(collision.json()).resolves.toMatchObject({ error: { code: "AlreadyExists" } });
  await expect(db.collection("notes").get(_id)).resolves.toEqual({ _id, title: "changed" });
  await db.collection("notes").update(_id, { title: "original" });
  const replay = await send();
  expect(replay.status).toBe(201);
  await expect(replay.json()).resolves.toEqual({ _id });
  await expect(db.collection("notes").get(_id)).resolves.toEqual(doc);
});

test("calling insert again mints a new auto-ID", async () => {
  const db = Db.create({ storage: new MemoryStorage(), app: "client-resend", tenant: "new-call" });
  const router = createRouter({ db });
  const client = createBaerlyClient({
    baseUrl: "http://localhost",
    fetch: async (request) => router.fetch(request),
  });
  const notes = client.collection("notes");
  const doc = { title: "same" };
  const first = await notes.insert(doc);
  const second = await notes.insert(doc);
  expect(second._id).not.toBe(first._id);
  expect(doc).toEqual({ title: "same" });
  await expect(db.collection("notes").where({}).all()).resolves.toHaveLength(2);
});

test("a proxy 5xx after a landed commit is retried by the client and replays to 201, one row", async () => {
  const db = Db.create({ storage: new MemoryStorage(), app: "client-resend", tenant: "proxy-5xx" });
  const router = createRouter({ db });
  const statuses: Array<number> = [];
  let proxyFailures = 1;
  const client = createBaerlyClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      const res = await router.fetch(request);
      statuses.push(res.status);
      if (proxyFailures > 0) {
        // The commit landed; the proxy drops the answer and returns its own 502.
        proxyFailures -= 1;
        return new Response("bad gateway", { status: 502 });
      }
      return res;
    },
  });

  const { _id } = await client.collection("tickets").insert({ title: "once" });

  expect(statuses).toEqual([201, 201]);
  await expect(db.collection("tickets").where({}).all()).resolves.toEqual([{ _id, title: "once" }]);
});

test("a proxy 5xx after a landed caller-_id insert is not retried and adds no row", async () => {
  const db = Db.create({ storage: new MemoryStorage(), app: "client-resend", tenant: "caller-id" });
  const router = createRouter({ db });
  const statuses: Array<number> = [];
  const client = createBaerlyClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      const res = await router.fetch(request);
      statuses.push(res.status);
      return new Response("bad gateway", { status: 502 });
    },
  });

  await expect(
    client.collection("tickets").insert({ _id: "human-id", title: "once" }),
  ).rejects.toMatchObject({ code: "NetworkError", status: 502 });

  expect(statuses).toEqual([201]);
  await expect(db.collection("tickets").where({}).all()).resolves.toHaveLength(1);
});
