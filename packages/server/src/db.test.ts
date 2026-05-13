/* eslint-disable no-underscore-dangle -- `_raw` is the locked public symbol
   name on `Db` (mirrors the Phase-4 declaration in `@baerly/protocol`). */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  InMemoryMetricsRecorder,
  MemoryStorage,
  BaerlyError,
  type Storage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { Db } from "./db.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromBytes = (b: Uint8Array): string => new TextDecoder().decode(b);

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
};

describe("Db.create", () => {
  test("returns a Db scoped to the given app and tenant", () => {
    const storage = new MemoryStorage();
    const db = Db.create({ storage, app: "tickets", tenant: "acme" });
    expect(db.app).toBe("tickets");
    expect(db.tenant).toBe("acme");
    expect(typeof db._raw.put).toBe("function");
    expect(typeof db._raw.get).toBe("function");
    expect(typeof db._raw.delete).toBe("function");
    expect(typeof db._raw.list).toBe("function");
  });

  test("rejects empty app with BaerlyError{InvalidConfig}", () => {
    const storage = new MemoryStorage();
    expect(() => Db.create({ storage, app: "", tenant: "acme" })).toThrow(BaerlyError);
    try {
      Db.create({ storage, app: "", tenant: "acme" });
    } catch (err) {
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("rejects empty tenant with BaerlyError{InvalidConfig}", () => {
    const storage = new MemoryStorage();
    expect(() => Db.create({ storage, app: "x", tenant: "" })).toThrow(BaerlyError);
    try {
      Db.create({ storage, app: "x", tenant: "" });
    } catch (err) {
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test('rejects "/" in app or tenant with BaerlyError{InvalidConfig}', () => {
    const storage = new MemoryStorage();
    expect(() => Db.create({ storage, app: "a/b", tenant: "t" })).toThrow(BaerlyError);
    expect(() => Db.create({ storage, app: "a", tenant: "t/u" })).toThrow(BaerlyError);
    try {
      Db.create({ storage, app: "a/b", tenant: "t" });
    } catch (err) {
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });
});

describe("Db._raw round-trip", () => {
  test("put then get returns the same bytes", async () => {
    const db = Db.create({ storage: new MemoryStorage(), app: "x", tenant: "y" });
    await db._raw.put("docs/1", utf8("hello"));
    const got = await db._raw.get("docs/1");
    expect(got).not.toBeNull();
    expect(fromBytes(got!.body)).toBe("hello");
  });

  test("delete clears the key; missing-key delete is a no-op", async () => {
    const db = Db.create({ storage: new MemoryStorage(), app: "x", tenant: "y" });
    await db._raw.put("k", utf8("v"));
    await db._raw.delete("k");
    expect(await db._raw.get("k")).toBeNull();
    // idempotent — deleting a missing key resolves without error
    await db._raw.delete("k");
  });

  test("list yields logical keys (no physical prefix leak)", async () => {
    const db = Db.create({ storage: new MemoryStorage(), app: "x", tenant: "y" });
    await db._raw.put("docs/1", utf8("a"));
    await db._raw.put("docs/2", utf8("b"));
    await db._raw.put("other/3", utf8("c"));
    const entries = await collect(db._raw.list(""));
    expect(entries.map((e) => e.key)).toEqual(["docs/1", "docs/2", "other/3"]);
    // Sanity-check: no entry leaks the physical prefix.
    for (const e of entries) {
      expect(e.key.startsWith("app/")).toBe(false);
    }
  });

  test("startAfter cursor is interpreted as a logical key", async () => {
    const db = Db.create({ storage: new MemoryStorage(), app: "x", tenant: "y" });
    for (const k of ["docs/1", "docs/2", "docs/3"]) {
      await db._raw.put(k, utf8(k));
    }
    const entries = await collect(db._raw.list("docs/", { startAfter: "docs/2" }));
    expect(entries.map((e) => e.key)).toEqual(["docs/3"]);
  });
});

describe("Db._raw tenant isolation", () => {
  test("two tenants over the same storage cannot see each other's keys", async () => {
    const storage = new MemoryStorage();
    const dbA = Db.create({ storage, app: "shared", tenant: "alice" });
    const dbB = Db.create({ storage, app: "shared", tenant: "bob" });

    await dbA._raw.put("docs/1", utf8("alice-secret"));
    await dbB._raw.put("docs/1", utf8("bob-secret"));

    const fromA = await dbA._raw.get("docs/1");
    const fromB = await dbB._raw.get("docs/1");
    expect(fromBytes(fromA!.body)).toBe("alice-secret");
    expect(fromBytes(fromB!.body)).toBe("bob-secret");

    expect(await collect(dbA._raw.list(""))).toHaveLength(1);
    expect(await collect(dbB._raw.list(""))).toHaveLength(1);

    await dbA._raw.delete("docs/1");
    // dbB still has its own copy
    expect(await dbB._raw.get("docs/1")).not.toBeNull();
  });

  test("two apps over the same storage cannot see each other's keys", async () => {
    const storage = new MemoryStorage();
    const dbX = Db.create({ storage, app: "tickets", tenant: "acme" });
    const dbY = Db.create({ storage, app: "billing", tenant: "acme" });

    await dbX._raw.put("k", utf8("tickets-value"));
    await dbY._raw.put("k", utf8("billing-value"));

    expect(fromBytes((await dbX._raw.get("k"))!.body)).toBe("tickets-value");
    expect(fromBytes((await dbY._raw.get("k"))!.body)).toBe("billing-value");
    expect(await collect(dbX._raw.list(""))).toHaveLength(1);
    expect(await collect(dbY._raw.list(""))).toHaveLength(1);
  });
});

describe("Db metrics threading", () => {
  const APP = "tickets";
  const TENANT = "acme";
  const TABLE = "tickets";
  const currentJsonKey = `app/${APP}/tenant/${TENANT}/manifests/${TABLE}/current.json`;

  const provision = async (storage: Storage): Promise<void> => {
    await createCurrentJson(storage, currentJsonKey, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
    });
  };

  test("single-mutation insert forwards metrics to the ServerWriter", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const metrics = new InMemoryMetricsRecorder();
    const db = Db.create({ storage, app: APP, tenant: TENANT, metrics });
    await db.table<{ _id: string; title: string }>(TABLE).insert({ title: "hi" });
    // server-writer.ts emits one histogram observation per successful
    // commit. Without metrics threading the recorder stays empty.
    const observed = metrics.histogramValues("db.write.class_a_ops_per_logical_write");
    expect(observed.length).toBeGreaterThan(0);
  });

  test("transaction commit forwards metrics to the ServerWriter", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const metrics = new InMemoryMetricsRecorder();
    const db = Db.create({ storage, app: APP, tenant: TENANT, metrics });
    await db.transaction<{ _id: string; title: string }>(TABLE, async (tx) => {
      await tx.insert({ title: "one" });
      await tx.insert({ title: "two" });
    });
    const observed = metrics.histogramValues("db.write.class_a_ops_per_logical_write");
    expect(observed.length).toBeGreaterThan(0);
  });

  test("omitting metrics is a no-op (no throw)", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    await expect(
      db.table<{ _id: string; title: string }>(TABLE).insert({ title: "hi" }),
    ).resolves.toBeDefined();
  });
});
