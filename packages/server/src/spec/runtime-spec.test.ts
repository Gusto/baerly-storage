import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import type { BaerlyConfig } from "@baerly/protocol";
import { buildSpecResponse } from "./runtime-spec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolve(here, "../../../protocol/src/spec/ir-schema.json"), "utf8"),
) as object;

const expectValidSpecResponse = (body: unknown): void => {
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  const ok = validate(body);
  if (!ok) {
    throw new Error(`Spec response failed schema: ${JSON.stringify(validate.errors, null, 2)}`);
  }
  expect(ok).toBe(true);
};

describe("buildSpecResponse", () => {
  test("anonymous: static IR only, no collections field", () => {
    const res = buildSpecResponse();
    expect(res.specVersion).toBe("1");
    expect(res.errorCodes.length).toBe(14);
    expect("collections" in res).toBe(false);
    expectValidSpecResponse(res);
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
    expectValidSpecResponse(res);
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
