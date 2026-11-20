import { describe, expect, test } from "vitest";
import { isNewerSchemaVersion, unsupportedSchemaVersionMessage } from "./schema-version.ts";

const WHERE = "thing at k";
const SUPPORTED = 3;
const MAX_MESSAGE_LENGTH = 1024;

const message = (found: unknown): string =>
  unsupportedSchemaVersionMessage(WHERE, found, SUPPORTED);

/** Nested empty arrays, built with a loop so the test itself cannot overflow. */
const deepArray = (depth: number): unknown => {
  let v: unknown = [];
  for (let i = 0; i < depth; i++) {
    v = [v];
  }
  return v;
};

const deepObject = (depth: number): unknown => {
  let v: unknown = {};
  for (let i = 0; i < depth; i++) {
    v = { a: v };
  }
  return v;
};

describe("isNewerSchemaVersion", () => {
  test.each([
    [4, true],
    [3, false],
    [2, false],
    [3.5, false],
    ["4", false],
    [null, false],
    [[4], false],
  ])("%j -> %j", (found, expected) => {
    expect(isNewerSchemaVersion(found, SUPPORTED)).toBe(expected);
  });
});

describe("unsupportedSchemaVersionMessage", () => {
  test("a newer integer says a newer release wrote it", () => {
    const msg = message(4);
    expect(msg).toContain("schema_version 4 was written by a newer baerly-storage release");
    expect(msg).toContain(`schema_version ${SUPPORTED}`);
  });

  test.each([
    ["older integer", 0, "0"],
    ["fractional", 3.5, "3.5"],
    ["short string", "one", "one"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
    ["boolean", true, "true"],
  ])("%s names the value, both versions and the restore remedy", (_n, found, shown) => {
    const msg = message(found);
    expect(msg).toContain(WHERE);
    expect(msg).toContain(shown);
    expect(msg).toContain(`supports schema_version ${SUPPORTED}`);
    expect(msg).toMatch(/restore it from a backup made by this release/);
    expect(msg).not.toMatch(/newer baerly-storage release/);
  });

  test("an array is described by type and its contents are not echoed", () => {
    const msg = message(["secret-element", 1, 2]);
    expect(msg).toMatch(/an array/);
    expect(msg).not.toContain("secret-element");
    expect(msg).toContain(`supports schema_version ${SUPPORTED}`);
  });

  test("an object is described by type and its contents are not echoed", () => {
    const msg = message({ secret: "secret-value" });
    expect(msg).toMatch(/an object/);
    expect(msg).not.toContain("secret");
    expect(msg).toContain(`supports schema_version ${SUPPORTED}`);
  });

  test("a very deeply nested array does not throw and stays bounded", () => {
    const msg = message(deepArray(200_000));
    expect(msg).toMatch(/an array/);
    expect(msg.length).toBeLessThan(MAX_MESSAGE_LENGTH);
    expect(msg).toContain(`supports schema_version ${SUPPORTED}`);
  });

  test("a very deeply nested object does not throw and stays bounded", () => {
    const msg = message(deepObject(200_000));
    expect(msg).toMatch(/an object/);
    expect(msg.length).toBeLessThan(MAX_MESSAGE_LENGTH);
  });

  test("a huge string is truncated and its length is reported", () => {
    const msg = message("x".repeat(1_000_000));
    expect(msg.length).toBeLessThan(MAX_MESSAGE_LENGTH);
    expect(msg).toMatch(/1000000 characters/);
    expect(msg).toContain(`supports schema_version ${SUPPORTED}`);
  });

  test("a huge array is not echoed", () => {
    const msg = message(Array.from({ length: 1_000_000 }, () => 7));
    expect(msg.length).toBeLessThan(MAX_MESSAGE_LENGTH);
  });

  test("a string with control characters is rendered escaped on one line", () => {
    const msg = message("a\nb\u0000c");
    expect(msg).not.toContain("\n");
    expect(msg).not.toContain("\u0000");
  });

  test("values with hostile coercion never throw", () => {
    const hostile = {
      toString: () => {
        throw new Error("boom");
      },
      get toJSON(): never {
        throw new Error("boom");
      },
    };
    expect(() => message(hostile)).not.toThrow();
    expect(() => message(Object.create(null))).not.toThrow();
    expect(() => message(10n)).not.toThrow();
    expect(() => message(Symbol("s"))).not.toThrow();
    expect(() => message(() => 1)).not.toThrow();
  });
});
