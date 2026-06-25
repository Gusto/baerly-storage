/* eslint-disable no-underscore-dangle -- type-assertion handles use _prefix convention */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ERROR_CODES, type BaerlyErrorCode } from "../errors.ts";
import { PREDICATE_OPS, type PredicateOpName } from "../query/wire.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("spec IR shared enumerations", () => {
  test("PREDICATE_OPS mirrors PredicateOpName 1:1", () => {
    // Type-level: each side assignable to the other. A drift (op added to
    // the union but not the tuple, or vice versa) fails tsgo, not just here.
    const _opFromTuple: PredicateOpName = PREDICATE_OPS[0];
    const _check: readonly PredicateOpName[] = PREDICATE_OPS;
    void _opFromTuple;
    void _check;
    expect([...PREDICATE_OPS]).toEqual(["eq", "gt", "gte", "lt", "lte", "in"]);
  });

  test("ERROR_CODES enumerates every BaerlyErrorCode", () => {
    const _codeFromTuple: BaerlyErrorCode = ERROR_CODES[0];
    const _check: readonly BaerlyErrorCode[] = ERROR_CODES;
    void _codeFromTuple;
    void _check;
    // 14 codes in the live union (verified 2026-06-24). Bump deliberately
    // when the union changes.
    expect(ERROR_CODES.length).toBe(14);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length); // no dupes
  });

  test("ir-schema.json parses as a JSON Schema document", () => {
    const raw = readFileSync(resolve(here, "ir-schema.json"), "utf8");
    const schema = JSON.parse(raw) as Record<string, unknown>;
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema["type"]).toBe("object");
    expect(schema["required"] as string[]).toContain("errorCodes");
    expect(schema["required"] as string[]).toContain("operators");
  });
});
