import {
  type BaerlyConfig,
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MemoryStorage,
  type SchemaValidator,
  type Storage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { Db } from "./db.ts";
import { createObservabilityContext, runWithContext } from "./observability/index.ts";

describe("Db.create", () => {
  test("returns a Db scoped to the given app and tenant", () => {
    const storage = new MemoryStorage();
    const db = Db.create({ storage, app: "tickets", tenant: "acme" });
    expect(db.app).toBe("tickets");
    expect(db.tenant).toBe("acme");
  });

  test("rejects empty app with BaerlyError{InvalidConfig}", () => {
    const storage = new MemoryStorage();
    expect(() => Db.create({ storage, app: "", tenant: "acme" })).toThrow(BaerlyError);
    try {
      Db.create({ storage, app: "", tenant: "acme" });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("rejects empty tenant with BaerlyError{InvalidConfig}", () => {
    const storage = new MemoryStorage();
    expect(() => Db.create({ storage, app: "x", tenant: "" })).toThrow(BaerlyError);
    try {
      Db.create({ storage, app: "x", tenant: "" });
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test('rejects "/" in app or tenant with BaerlyError{InvalidConfig}', () => {
    const storage = new MemoryStorage();
    expect(() => Db.create({ storage, app: "a/b", tenant: "t" })).toThrow(BaerlyError);
    expect(() => Db.create({ storage, app: "a", tenant: "t/u" })).toThrow(BaerlyError);
    try {
      Db.create({ storage, app: "a/b", tenant: "t" });
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("collection names cannot start with the reserved _ prefix", () => {
    const db = Db.create({ storage: new MemoryStorage(), app: "a", tenant: "t" });
    expect(() => db.collection("_v2")).toThrow(/reserved for system use/);
    try {
      db.collection("_v2");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
    expect(() => db.collection("notes")).not.toThrow();
  });

  test("app names cannot start with the reserved _ prefix", () => {
    try {
      Db.create({ storage: new MemoryStorage(), app: "_x", tenant: "t" });
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
    expect(() => Db.create({ storage: new MemoryStorage(), app: "_x", tenant: "t" })).toThrow(
      /reserved for system use/,
    );
  });
});

describe("Db.create config derivation", () => {
  // Regression: `config` used to be a type-only seam. App and test
  // code that wrote `Db.create({ storage, app, tenant, config })`
  // silently dropped schemas + indexes at runtime; callers had to
  // discover `collectionsToMaps(config.collections)` and thread the
  // flattened maps explicitly. The fix derives the maps inside
  // `Db.create` when explicit `schemas` / `indexes` aren't passed.
  const onlyStrings: SchemaValidator = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        if (typeof value === "object" && value !== null && "title" in value) {
          const t = (value as { title: unknown }).title;
          if (typeof t === "string") {
            return { value };
          }
        }
        return { issues: [{ path: ["title"], message: "title must be a string" }] };
      },
    },
  };

  test("derives schemas from config — invalid insert throws SchemaError", async () => {
    const config: BaerlyConfig = {
      collections: { tickets: { schema: onlyStrings } },
    };
    const db = Db.create({ storage: new MemoryStorage(), app: "x", tenant: "y", config });
    await expect(db.collection("tickets").insert({ title: 42 })).rejects.toMatchObject({
      code: "SchemaError",
    });
    // Valid insert still goes through — proves the schema was wired
    // (not just thrown blindly).
    await expect(db.collection("tickets").insert({ title: "ok" })).resolves.toBeDefined();
  });

  test("derives indexes from config — visible on the collectionReadContext", () => {
    const config: BaerlyConfig = {
      collections: { tickets: { indexes: [{ name: "by_status", on: "status" }] } },
    };
    const db = Db.create({ storage: new MemoryStorage(), app: "x", tenant: "y", config });
    expect(db.collectionReadContext("tickets").indexes.map((i) => i.name)).toEqual(["by_status"]);
  });
});

describe("Db → per-request metrics emission", () => {
  const APP = "tickets";
  const TENANT = "acme";
  const TABLE = "tickets";
  const currentJsonKey = `app/${APP}/tenant/${TENANT}/manifests/${TABLE}/current.json`;

  const provision = async (storage: Storage): Promise<void> => {
    await createCurrentJson(storage, currentJsonKey, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
      tail_bytes: 0,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
  };

  test("single-mutation insert emits to the active context's recorder", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const ctx = createObservabilityContext();
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    await runWithContext(ctx, async () => {
      await db.collection(TABLE).insert({ title: "hi" });
    });
    // writer.ts emits one histogram observation per successful
    // commit via getCurrentContext()?.recorder. Outside any context,
    // observations route through the noop default.
    const observed = ctx.recorder
      .snapshot()
      .histograms.filter((h) => h.name === "db.write.class_a_ops_per_logical_write");
    expect(observed.length).toBeGreaterThan(0);
  });

  test("transaction commit emits to the active context's recorder", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const ctx = createObservabilityContext();
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    await runWithContext(ctx, async () => {
      await db.transaction<{ _id: string; title: string }>(TABLE, async (tx) => {
        await tx.insert({ title: "one" });
        await tx.insert({ title: "two" });
      });
    });
    const observed = ctx.recorder
      .snapshot()
      .histograms.filter((h) => h.name === "db.write.class_a_ops_per_logical_write");
    expect(observed.length).toBeGreaterThan(0);
  });

  test("outside any context emissions are a no-op (no throw)", async () => {
    const storage = new MemoryStorage();
    await provision(storage);
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    await expect(db.collection(TABLE).insert({ title: "hi" })).resolves.toBeDefined();
  });
});
