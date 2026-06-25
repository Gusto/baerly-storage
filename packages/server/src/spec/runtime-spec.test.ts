import { describe, expect, test } from "vitest";
import type { BaerlyConfig } from "@baerly/protocol";
import { expectValidAgainstIrSchema } from "../../../../tests/fixtures/ir-schema.ts";
import { buildSpecResponse } from "./runtime-spec.ts";

describe("buildSpecResponse", () => {
  test("anonymous: static IR only, no collections field", () => {
    const res = buildSpecResponse();
    expect(res.specVersion).toBe("1");
    expect(res.errorCodes.length).toBe(14);
    expect("collections" in res).toBe(false);
    expectValidAgainstIrSchema(res);
  });

  test("authed: appends declared collection names + index names", () => {
    const config: BaerlyConfig = {
      collections: {
        notes: { indexes: [{ name: "by_author", on: ["author"] }] },
        tasks: {},
      },
    };
    const res = buildSpecResponse(config);
    expect(res.collections).toBeDefined();
    const notes = res.collections?.find((c) => c.name === "notes");
    expect(notes?.indexes).toEqual(["by_author"]);
    expect(res.collections?.map((c) => c.name).toSorted()).toEqual(["notes", "tasks"]);
    expectValidAgainstIrSchema(res);
  });

  test("authed: reports schema vendor when a schema is declared", () => {
    const config: BaerlyConfig = {
      collections: {
        notes: {
          schema: {
            "~standard": { version: 1, vendor: "zod", validate: () => ({ value: {} }) },
          } as never,
        },
      },
    };
    const res = buildSpecResponse(config);
    expect(res.collections?.find((c) => c.name === "notes")?.schemaVendor).toBe("zod");
  });
});
