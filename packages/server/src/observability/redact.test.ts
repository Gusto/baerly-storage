import { BaerlyError } from "@baerly/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeError } from "./redact";

describe("serializeError", () => {
  describe("BaerlyError", () => {
    it("preserves the code discriminant", () => {
      const err = new BaerlyError("Conflict", "CAS lost");
      expect(serializeError(err)).toEqual({ code: "Conflict", message: "CAS lost" });
    });

    it("does not include the stack by default", () => {
      const err = new BaerlyError("InvalidConfig", "bad bucket");
      expect(serializeError(err).stack).toBeUndefined();
    });
  });

  describe("plain Error", () => {
    it("collapses code to 'Internal' and keeps the message", () => {
      const err = new Error("boom");
      expect(serializeError(err)).toEqual({ code: "Internal", message: "boom" });
    });
  });

  describe("non-Error values", () => {
    it("stringifies strings via String()", () => {
      expect(serializeError("oops")).toEqual({ code: "Internal", message: "oops" });
    });

    it("stringifies numbers via String()", () => {
      expect(serializeError(42)).toEqual({ code: "Internal", message: "42" });
    });

    it("stringifies undefined and null", () => {
      expect(serializeError(undefined)).toEqual({ code: "Internal", message: "undefined" });
      expect(serializeError(null)).toEqual({ code: "Internal", message: "null" });
    });

    it("JSON-stringifies plain objects", () => {
      expect(serializeError({ a: 1, b: "x" })).toEqual({
        code: "Internal",
        message: JSON.stringify({ a: 1, b: "x" }),
      });
    });

    it("falls back to [unserializable object] on JSON-stringify failure", () => {
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
      if (prev === undefined) delete process.env["BAERLY_LOG_STACKS"];
      else process.env["BAERLY_LOG_STACKS"] = prev;
    });

    it("omits stack when includeStack=false (regardless of env)", () => {
      process.env["BAERLY_LOG_STACKS"] = "1";
      const err = new BaerlyError("Internal", "x");
      expect(serializeError(err, false).stack).toBeUndefined();
    });

    it("omits stack when env is absent (regardless of includeStack)", () => {
      delete process.env["BAERLY_LOG_STACKS"];
      const err = new BaerlyError("Internal", "x");
      expect(serializeError(err, true).stack).toBeUndefined();
    });

    it("includes stack when both gates permit (BaerlyError)", () => {
      process.env["BAERLY_LOG_STACKS"] = "1";
      const err = new BaerlyError("Internal", "stack-marker-message");
      const out = serializeError(err, true);
      expect(typeof out.stack).toBe("string");
      // V8 stacks start with `<ErrorName>: <message>` — assert via message.
      expect(out.stack).toContain("stack-marker-message");
    });

    it("includes stack when both gates permit (plain Error)", () => {
      process.env["BAERLY_LOG_STACKS"] = "1";
      const err = new Error("boom");
      const out = serializeError(err, true);
      expect(typeof out.stack).toBe("string");
    });
  });
});
