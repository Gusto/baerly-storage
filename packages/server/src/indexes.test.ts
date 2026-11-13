import type { BaerlyError } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { validateIndexDefinition } from "./indexes.ts";

describe("validateIndexDefinition", () => {
  test("accepts a well-formed single-field definition", () => {
    expect(() => validateIndexDefinition({ name: "by_status", on: "status" })).not.toThrow();
  });

  test("accepts a well-formed composite definition", () => {
    expect(() => validateIndexDefinition({ name: "by_x", on: ["a", "b"] })).not.toThrow();
  });

  test("rejects names with uppercase or dashes", () => {
    expect(() => validateIndexDefinition({ name: "Bad-Name", on: "x" })).toThrow(/match/);
  });

  test("rejects names starting with a digit", () => {
    expect(() => validateIndexDefinition({ name: "1starts", on: "x" })).toThrow(/match/);
  });

  test("index names cannot start with the reserved _ prefix (same error contract as collections)", () => {
    let err: unknown;
    try {
      validateIndexDefinition({ name: "_secret", on: ["x"] });
    } catch (error) {
      err = error;
    }
    expect((err as BaerlyError).code).toBe("InvalidConfig"); // not SchemaError — unified
    expect((err as BaerlyError).message).toMatch(/reserved for system use/);
    // other lexical failures still SchemaError (intentional asymmetry):
    let lexicalErr: unknown;
    try {
      validateIndexDefinition({ name: "1foo", on: ["x"] });
    } catch (error) {
      lexicalErr = error;
    }
    expect((lexicalErr as BaerlyError).code).toBe("SchemaError"); // not InvalidConfig
    expect(() => validateIndexDefinition({ name: "by_status", on: ["status"] })).not.toThrow();
  });

  test("rejects an empty 'on' string", () => {
    expect(() => validateIndexDefinition({ name: "ok_name", on: "" })).toThrow(/non-empty/);
  });

  test("rejects an empty 'on' array", () => {
    expect(() => validateIndexDefinition({ name: "ok_name", on: [] })).toThrow(/non-empty/);
  });
});

describe("validateIndexDefinition — predicate field", () => {
  test("accepts an equality-only predicate (wire form)", () => {
    expect(() =>
      validateIndexDefinition({
        name: "open_only",
        on: "assignee",
        predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
      }),
    ).not.toThrow();
  });

  test("accepts a flattened-multi-key equality predicate (wire form)", () => {
    expect(() =>
      validateIndexDefinition({
        name: "open_ui_only",
        on: "assignee",
        predicate: {
          clauses: [
            { op: "eq", field: "status", value: "open" },
            { op: "eq", field: "meta.source", value: "ui" },
          ],
        },
      }),
    ).not.toThrow();
  });

  test("accepts range and in operator clauses on the wire", () => {
    expect(() =>
      validateIndexDefinition({
        name: "adult_only",
        on: "name",
        predicate: { clauses: [{ op: "gte", field: "age", value: 18 }] },
      }),
    ).not.toThrow();
    expect(() =>
      validateIndexDefinition({
        name: "p0_p1",
        on: "assignee",
        predicate: { clauses: [{ op: "in", field: "priority", value: ["p0", "p1"] }] },
      }),
    ).not.toThrow();
  });

  test("rejects a predicate that fails wire validation (top-level _id)", () => {
    expect(() =>
      validateIndexDefinition({
        name: "bad_id",
        on: "assignee",
        predicate: { clauses: [{ op: "eq", field: "_id", value: "x" }] } as never,
      }),
    ).toThrow(/predicate is invalid/);
  });

  test("rejects a predicate containing null", () => {
    expect(() =>
      validateIndexDefinition({
        name: "null_val",
        on: "assignee",
        predicate: {
          clauses: [{ op: "eq", field: "status", value: null as unknown as string }],
        } as never,
      }),
    ).toThrow(/predicate is invalid/);
  });
});
