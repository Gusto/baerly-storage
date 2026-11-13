/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key field. */
/**
 * Caller-input validation on the write and point-read verbs: a present
 * non-string insert `_id`, and a point-read id no row can be stored under,
 * each throw `InvalidConfig` (HTTP 400) before any storage call, both
 * in-process (`Db`) and through the HTTP client.
 */
import { createBaerlyClient } from "@baerly/client";
import { BaerlyError, MemoryStorage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import { describe, expect, test } from "vitest";
import { wrapCountingStorage } from "../fixtures/counting-storage.ts";

const setup = () => {
  const counting = wrapCountingStorage(new MemoryStorage({ ephemeral: true }));
  const db = Db.create({ storage: counting.storage, app: "app", tenant: "tenant" });
  const router = createRouter({ db });
  let requests = 0;
  const client = createBaerlyClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      requests++;
      return await router.fetch(request);
    },
  });
  const calls = () => counting.gets + counting.classAOps;
  return { counting, db, router, client, calls, requests: () => requests };
};

const expectInvalidConfig = async (action: Promise<unknown>): Promise<BaerlyError> => {
  const error = await action.then(
    () => undefined,
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(BaerlyError);
  expect(error).toMatchObject({ code: "InvalidConfig" });
  expect((error as BaerlyError).resolution).toBeTypeOf("string");
  return error as BaerlyError;
};

const NON_STRING_IDS: ReadonlyArray<readonly [string, unknown]> = [
  ["number", 42],
  ["true", true],
  ["object", {}],
  ["array", ["a"]],
  ["-0", -0],
  ["NaN", Number.NaN],
  ["null", null],
];

describe("insert: a present non-string _id", () => {
  test.each(NON_STRING_IDS)("Db.insert rejects %s before any I/O", async (_label, id) => {
    const { db, calls } = setup();
    await expectInvalidConfig(db.collection("rows").insert({ _id: id as string, a: 1 }));
    expect(calls()).toBe(0);
  });

  test.each(NON_STRING_IDS)("the HTTP client rejects %s without a request", async (_label, id) => {
    const { client, calls, requests } = setup();
    await expectInvalidConfig(client.collection("rows").insert({ _id: id as string, a: 1 }));
    expect(requests()).toBe(0);
    expect(calls()).toBe(0);
  });

  test.each(NON_STRING_IDS.filter(([label]) => label !== "NaN" && label !== "-0"))(
    "POST /v1/c/:collection answers 400 for %s",
    async (_label, id) => {
      const { router, calls } = setup();
      const response = await router.request("/v1/c/rows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: id, a: 1 } }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("InvalidConfig");
      expect(body.error.message).toContain("_id must be a string");
      expect(calls()).toBe(0);
    },
  );

  test.each<readonly [string, { _id?: string }]>([
    ["absent", {}],
    ["undefined", { _id: undefined }],
    ["empty", { _id: "" }],
  ])("an %s _id still mints, in-process and over HTTP", async (_label, extra) => {
    const { db, client } = setup();
    const local = await db.collection("rows").insert({ ...extra, a: 1 });
    const remote = await client.collection("rows").insert({ ...extra, a: 2 });
    for (const { _id } of [local, remote]) {
      expect(_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    await expect(db.collection("rows").get(remote._id)).resolves.toEqual({
      _id: remote._id,
      a: 2,
    });
  });
});

const INVALID_READ_IDS: ReadonlyArray<readonly [string, string]> = [
  ["empty", ""],
  ["slash", "a/b"],
  ["dot", "."],
  ["dot-dot", ".."],
  ["control character", "a\u0001b"],
  ["leading underscore", "_x"],
  ["overlong", "x".repeat(257)],
];

describe("get: an id no row can be stored under", () => {
  test.each(INVALID_READ_IDS)("Db.get rejects %s before any I/O", async (_label, id) => {
    const { db, calls } = setup();
    await expectInvalidConfig(db.collection("rows").get(id));
    expect(calls()).toBe(0);
  });

  test.each(INVALID_READ_IDS)("the HTTP client rejects %s", async (_label, id) => {
    const { db, client, calls } = setup();
    // A stored row, so a request that fell through to the list route
    // would answer with it instead of failing.
    await db.collection("rows").insert({ a: 1 });
    const before = calls();
    await expectInvalidConfig(client.collection("rows").get(id));
    expect(calls()).toBe(before);
  });

  test.each(INVALID_READ_IDS.filter(([, id]) => id !== "" && id !== "." && id !== ".."))(
    "GET /v1/c/:collection/:id answers 400 with the message for %s",
    async (_label, id) => {
      const { router, calls } = setup();
      const response = await router.request(`/v1/c/rows/${encodeURIComponent(id)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("InvalidConfig");
      expect(body.error.message).toContain("_id");
      expect(calls()).toBe(0);
    },
  );

  test("a valid unknown id still reads as undefined", async () => {
    const { db, client } = setup();
    await expect(db.collection("rows").get("missing")).resolves.toBeUndefined();
    await expect(client.collection("rows").get("missing")).resolves.toBeUndefined();
  });
});
