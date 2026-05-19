import { BaerlyError } from "@baerly/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { serializeError } from "./redact.ts";

describe("serializeError", () => {
  describe("BaerlyError", () => {
    test("preserves the code discriminant", () => {
      const err = new BaerlyError("Conflict", "CAS lost");
      expect(serializeError(err)).toEqual({ code: "Conflict", message: "CAS lost" });
    });

    test("does not include the stack by default", () => {
      const err = new BaerlyError("InvalidConfig", "bad bucket");
      expect(serializeError(err).stack).toBeUndefined();
    });
  });

  describe("plain Error", () => {
    test("collapses code to 'Internal' and keeps the message", () => {
      const err = new Error("boom");
      expect(serializeError(err)).toEqual({ code: "Internal", message: "boom" });
    });
  });

  describe("non-Error values", () => {
    test("stringifies strings via String()", () => {
      expect(serializeError("oops")).toEqual({ code: "Internal", message: "oops" });
    });

    test("stringifies numbers via String()", () => {
      expect(serializeError(42)).toEqual({ code: "Internal", message: "42" });
    });

    test("stringifies undefined and null", () => {
      expect(serializeError(undefined)).toEqual({ code: "Internal", message: "undefined" });
      expect(serializeError(null)).toEqual({ code: "Internal", message: "null" });
    });

    test("JSON-stringifies plain objects", () => {
      expect(serializeError({ a: 1, b: "x" })).toEqual({
        code: "Internal",
        message: JSON.stringify({ a: 1, b: "x" }),
      });
    });

    test("falls back to [unserializable object] on JSON-stringify failure", () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      expect(serializeError(circular)).toEqual({
        code: "Internal",
        message: "[unserializable object]",
      });
    });
  });

  describe("stack inclusion", () => {
    let prev: string | undefined;
    beforeEach(() => {
      prev = process.env["BAERLY_LOG_STACKS"];
    });
    afterEach(() => {
      if (prev === undefined) {
        delete process.env["BAERLY_LOG_STACKS"];
      } else {
        process.env["BAERLY_LOG_STACKS"] = prev;
      }
    });

    test("omits stack when includeStack=false (regardless of env)", () => {
      process.env["BAERLY_LOG_STACKS"] = "1";
      const err = new BaerlyError("Internal", "x");
      expect(serializeError(err, false).stack).toBeUndefined();
    });

    test("omits stack when env is absent (regardless of includeStack)", () => {
      delete process.env["BAERLY_LOG_STACKS"];
      const err = new BaerlyError("Internal", "x");
      expect(serializeError(err, true).stack).toBeUndefined();
    });

    test("includes stack when both gates permit (BaerlyError)", () => {
      process.env["BAERLY_LOG_STACKS"] = "1";
      const err = new BaerlyError("Internal", "stack-marker-message");
      const out = serializeError(err, true);
      expect(typeof out.stack).toBe("string");
      // V8 stacks start with `<ErrorName>: <message>` — assert via message.
      expect(out.stack).toContain("stack-marker-message");
    });

    test("includes stack when both gates permit (plain Error)", () => {
      process.env["BAERLY_LOG_STACKS"] = "1";
      const err = new Error("boom");
      const out = serializeError(err, true);
      expect(typeof out.stack).toBe("string");
    });
  });
});
