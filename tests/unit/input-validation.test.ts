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
  test.each(NON_STRING_IDS)(
    "point operations reject a %s id without a request",
    async (_label, id) => {
      const { db, client, calls, requests } = setup();
      await expectInvalidConfig(db.collection("rows").get(id as string));
      const rows = client.collection("rows");
      await expectInvalidConfig(rows.get(id as string));
      await expectInvalidConfig(rows.update(id as string, { a: 1 }));
      await expectInvalidConfig(rows.replace(id as string, { a: 1 }));
      await expectInvalidConfig(rows.delete(id as string));
      expect(calls()).toBe(0);
      expect(requests()).toBe(0);
    },
  );

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

class Ticket {
  title = "a";
}

/** Values `JSON.stringify` would coerce, drop or reshape. */
const INVALID_VALUES: ReadonlyArray<readonly [string, () => unknown]> = [
  ["NaN", () => Number.NaN],
  ["Infinity", () => Number.POSITIVE_INFINITY],
  ["-Infinity", () => Number.NEGATIVE_INFINITY],
  ["undefined", () => undefined],
  ["Date", () => new Date(0)],
  ["Map", () => new Map([["k", 1]])],
  ["Uint8Array", () => new Uint8Array([1])],
  ["class instance", () => new Ticket()],
  ["boxed number", () => Object(1)],
  ["function", () => () => 1],
  ["symbol", () => Symbol("s")],
];

/** Each value class nested in an object member and as an array element. */
const INVALID_DOCS: ReadonlyArray<readonly [string, () => never]> = INVALID_VALUES.flatMap(
  ([label, make]) => [
    [`${label} member`, () => ({ nested: { field: make() } }) as never] as const,
    [`${label} element`, () => ({ list: [1, make()] }) as never] as const,
  ],
);

/**
 * An update patch member set to `undefined` is absent (JSON drops it over
 * HTTP), so patch cases skip that one class.
 */
const INVALID_PATCHES = (): typeof INVALID_DOCS =>
  INVALID_DOCS.filter(([label]) => label !== "undefined member");

describe("document values outside the JSON domain", () => {
  const seeded = async () => {
    const env = setup();
    await env.db.collection("rows").insert({ _id: "r1", a: 1 });
    env.counting.reset();
    return env;
  };

  test.each(INVALID_DOCS)("Db.insert rejects a %s before any I/O", async (_label, make) => {
    const { db, calls } = setup();
    await expectInvalidConfig(db.collection("rows").insert(make()));
    expect(calls()).toBe(0);
  });

  test.each(INVALID_DOCS)("Db.replace rejects a %s before any I/O", async (_label, make) => {
    const { db, calls } = await seeded();
    await expectInvalidConfig(db.collection("rows").replace("r1", make()));
    expect(calls()).toBe(0);
  });

  test.each(INVALID_PATCHES())("Db.update rejects a %s before any I/O", async (_label, make) => {
    const { db, calls } = await seeded();
    await expectInvalidConfig(db.collection("rows").update("r1", make()));
    expect(calls()).toBe(0);
  });

  test.each(INVALID_PATCHES())("Query.update rejects a %s before any I/O", async (_label, make) => {
    const { db, calls } = await seeded();
    await expectInvalidConfig(db.collection("rows").where({ a: 1 }).update(make()));
    expect(calls()).toBe(0);
  });

  test.each(["nested", "array", "inherited-array", "root", "accessor", "inherited-accessor"])(
    "Db and HTTP writes reject a %s toJSON hook before I/O",
    async (kind) => {
      const { db, client, calls, requests } = await seeded();
      let hookCalls = 0;
      const hook = () => {
        hookCalls++;
        return { a: Number.NaN };
      };
      const make = () => {
        if (kind === "root") {
          class Root {
            _id = "r1";
            a = 1;
            toJSON() {
              return hook();
            }
          }
          return new Root() as never;
        }
        class HookedArray extends Array<number> {
          toJSON() {
            return hook();
          }
        }
        if (kind === "inherited-array") {
          return { _id: "r1", nested: new HookedArray(1, 10) } as never;
        }
        const nested = kind === "array" || kind === "inherited-accessor" ? [10] : { amount: 10 };
        const hookOwner = kind === "inherited-accessor" ? Object.create(Array.prototype) : nested;
        if (kind === "inherited-accessor") {
          Object.setPrototypeOf(nested, hookOwner);
        }
        Object.defineProperty(
          hookOwner,
          "toJSON",
          kind === "accessor" || kind === "inherited-accessor"
            ? {
                get() {
                  hookCalls++;
                  return hook;
                },
              }
            : { value: hook },
        );
        return { _id: "r1", nested } as never;
      };
      for (const rows of [db.collection("rows"), client.collection("rows")]) {
        await expectInvalidConfig(rows.insert(make()));
        await expectInvalidConfig(rows.replace("r1", make()));
        await expectInvalidConfig(rows.update("r1", make()));
      }
      await expectInvalidConfig(db.collection("rows").where({ a: 1 }).update(make()));
      expect(calls()).toBe(0);
      expect(requests()).toBe(0);
      expect(hookCalls).toBe(0);
    },
  );

  test("an undefined patch member is absent, in-process and over HTTP", async () => {
    const { db, client } = await seeded();
    const patch = { a: undefined, fresh: undefined, nested: { b: undefined } } as never;
    await expect(db.collection("rows").update("r1", patch)).resolves.toEqual({ modified: 1 });
    await expect(client.collection("rows").update("r1", patch)).resolves.toEqual({ modified: 1 });
    await expect(db.collection("rows").get("r1")).resolves.toEqual({ _id: "r1", a: 1, nested: {} });
  });

  test("a nested Date patch over an object field is refused, not merged away", async () => {
    const { db, calls } = await seeded();
    await db.collection("rows").update("r1", { meta: { at: 1 } } as never);
    const before = calls();
    await expectInvalidConfig(db.collection("rows").update("r1", { meta: new Date(0) } as never));
    expect(calls()).toBe(before);
  });

  test("a class-instance document is stored by its own fields", async () => {
    const { db, client } = await seeded();
    const { _id } = await db.collection("rows").insert(new Ticket() as never);
    await expect(db.collection("rows").get(_id)).resolves.toEqual({ _id, title: "a" });
    const remote = await client.collection("rows").insert(new Ticket() as never);
    await expect(db.collection("rows").get(remote._id)).resolves.toEqual({
      _id: remote._id,
      title: "a",
    });
    await db.collection("rows").replace("r1", new Ticket() as never);
    await expect(db.collection("rows").get("r1")).resolves.toEqual({ _id: "r1", title: "a" });
  });

  test.each(INVALID_DOCS)(
    "the HTTP client rejects a %s on insert, replace and update without a request",
    async (_label, make) => {
      const { client, requests } = await seeded();
      const rows = client.collection("rows");
      await expectInvalidConfig(rows.insert(make()));
      await expectInvalidConfig(rows.replace("r1", make()));
      if (_label !== "undefined member") {
        await expectInvalidConfig(rows.update("r1", make()));
      }
      expect(requests()).toBe(0);
    },
  );

  test("null values and an undefined top-level _id are still accepted", async () => {
    const { db, client } = await seeded();
    const rows = db.collection("rows");
    await expect(rows.update("r1", { _id: undefined, b: null } as never)).resolves.toEqual({
      modified: 1,
    });
    await rows.replace("r1", { _id: undefined, list: [null], n: -0 } as never);
    await expect(rows.get("r1")).resolves.toEqual({ _id: "r1", list: [null], n: 0 });
    const { _id } = await client.collection("rows").insert({ list: [null], z: null } as never);
    await expect(rows.get(_id)).resolves.toEqual({ _id, list: [null], z: null });
  });
});
