import { describe, expect, test } from "vitest";
import { type BaerlyConfig, collectionsToMaps } from "./config.ts";
import type { IndexDefinition } from "./indexes.ts";
import type { SchemaValidator } from "./schema.ts";

const noopSchema: SchemaValidator = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value }),
  },
};

const idx = (name: string, on: string): IndexDefinition => ({ name, on });

describe("collectionsToMaps", () => {
  test("undefined collections → empty maps (no allocation)", () => {
    const a = collectionsToMaps(undefined);
    const b = collectionsToMaps(undefined);
    expect(a.schemas.size).toBe(0);
    expect(a.indexes.size).toBe(0);
    // Sentinel maps are shared — confirms the unconditional-pass call
    // path doesn't churn per-request allocations.
    expect(a.schemas).toBe(b.schemas);
    expect(a.indexes).toBe(b.indexes);
  });

  test("picks up schema and indexes per collection", () => {
    const config: BaerlyConfig = {
      collections: {
        tickets: { schema: noopSchema, indexes: [idx("by_status", "status")] },
        audits: { indexes: [idx("by_actor", "actor")] },
      },
    };
    const { schemas, indexes } = collectionsToMaps(config.collections);
    expect(schemas.get("tickets")).toBe(noopSchema);
    expect(schemas.has("audits")).toBe(false);
    expect(indexes.get("tickets")?.map((i) => i.name)).toEqual(["by_status"]);
    expect(indexes.get("audits")?.map((i) => i.name)).toEqual(["by_actor"]);
  });

  test("empty index array is dropped (matches Db.create's EMPTY_INDEX_ARRAY contract)", () => {
    const { indexes } = collectionsToMaps({
      tickets: { indexes: [] },
    });
    expect(indexes.has("tickets")).toBe(false);
  });

  test("collection with no schema or indexes is skipped entirely", () => {
    const { schemas, indexes } = collectionsToMaps({
      tickets: {},
    });
    expect(schemas.has("tickets")).toBe(false);
    expect(indexes.has("tickets")).toBe(false);
  });
});
