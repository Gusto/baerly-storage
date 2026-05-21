import type { BaerlyConfig, IndexDefinition, SchemaValidator } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { collectionsToMaps } from "./config.ts";

const noopSchema: SchemaValidator = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value }),
  },
};

const idx = (name: string, on: string): IndexDefinition => ({ name, on });

describe("collectionsToMaps", () => {
  test("undefined collections → empty maps", () => {
    const { schemas, indexes } = collectionsToMaps(undefined);
    expect(schemas.size).toBe(0);
    expect(indexes.size).toBe(0);
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

  test("empty index array is dropped (matches Db.create's empty-fallback contract)", () => {
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
