import { describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { quoteIdentifier, quoteValue } from "./sql-escape.ts";

describe("quoteIdentifier", () => {
  test("wraps plain identifier in double-quotes for postgres", () => {
    expect(quoteIdentifier("users", "postgres")).toBe('"users"');
  });

  test("wraps plain identifier in double-quotes for sqlite", () => {
    expect(quoteIdentifier("users", "sqlite")).toBe('"users"');
  });

  test("wraps plain identifier in double-quotes for d1", () => {
    expect(quoteIdentifier("users", "d1")).toBe('"users"');
  });

  test("doubles embedded double-quote in identifier", () => {
    expect(quoteIdentifier('weird"name', "postgres")).toBe('"weird""name"');
  });

  test("preserves case", () => {
    expect(quoteIdentifier("MixedCase", "postgres")).toBe('"MixedCase"');
  });

  test("rejects empty identifier", () => {
    expect(() => quoteIdentifier("", "postgres")).toThrow(BaerlyError);
    try {
      quoteIdentifier("", "postgres");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("SchemaError");
    }
  });

  test("rejects identifier containing NUL byte", () => {
    expect(() => quoteIdentifier("bad\0name", "postgres")).toThrow(BaerlyError);
    try {
      quoteIdentifier("bad\0name", "postgres");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("SchemaError");
    }
  });
});

describe("quoteValue", () => {
  test("null → NULL across targets", () => {
    expect(quoteValue(null, "postgres")).toBe("NULL");
    expect(quoteValue(null, "sqlite")).toBe("NULL");
    expect(quoteValue(null, "d1")).toBe("NULL");
  });

  test("plain string is wrapped in apostrophes", () => {
    expect(quoteValue("hello", "postgres")).toBe("'hello'");
  });

  test("apostrophe inside string is doubled", () => {
    expect(quoteValue("it's", "postgres")).toBe("'it''s'");
    expect(quoteValue("don't stop", "sqlite")).toBe("'don''t stop'");
  });

  test("integer renders without quotes", () => {
    expect(quoteValue(42, "postgres")).toBe("42");
    expect(quoteValue(-7, "sqlite")).toBe("-7");
  });

  test("float renders without quotes", () => {
    expect(quoteValue(3.14, "postgres")).toBe("3.14");
  });

  test("boolean → true/false on postgres", () => {
    expect(quoteValue(true, "postgres")).toBe("true");
    expect(quoteValue(false, "postgres")).toBe("false");
  });

  test("boolean → 1/0 on sqlite + d1", () => {
    expect(quoteValue(true, "sqlite")).toBe("1");
    expect(quoteValue(false, "sqlite")).toBe("0");
    expect(quoteValue(true, "d1")).toBe("1");
    expect(quoteValue(false, "d1")).toBe("0");
  });

  test("rejects non-finite numbers (NaN, Infinity)", () => {
    expect(() => quoteValue(NaN, "postgres")).toThrow(BaerlyError);
    expect(() => quoteValue(Infinity, "postgres")).toThrow(BaerlyError);
    expect(() => quoteValue(-Infinity, "postgres")).toThrow(BaerlyError);
    try {
      quoteValue(NaN, "postgres");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("SchemaError");
    }
  });

  test("rejects bare nested object — caller must JSON-encode first", () => {
    expect(() => quoteValue({ a: 1 }, "postgres")).toThrow(BaerlyError);
    try {
      quoteValue({ a: 1 }, "postgres");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("SchemaError");
    }
  });
});
