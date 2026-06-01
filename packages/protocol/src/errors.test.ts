import { describe, expect, test } from "vitest";

import { BaerlyError } from "./errors.ts";

describe("BaerlyError", () => {
  test("is an Error carrying name, code, and message", () => {
    const e = new BaerlyError("Conflict", "CAS lost");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BaerlyError");
    expect(e.code).toBe("Conflict");
    expect(e.message).toBe("CAS lost");
  });

  test("threads cause through", () => {
    const cause = new Error("io");
    expect(new BaerlyError("NetworkError", "boom", cause).cause).toBe(cause);
  });

  test("sets issues when provided", () => {
    const issues = [{ path: ["a"] as const, message: "required" }];
    const e = new BaerlyError("SchemaError", "bad", undefined, issues);
    expect(e.issues).toEqual(issues);
  });

  test("leaves issues undefined when not provided", () => {
    const e = new BaerlyError("SchemaError", "bad");
    expect(e.issues).toBeUndefined();
  });

  test("sets status when provided", () => {
    const e = new BaerlyError("NotFound", "x", undefined, undefined, 404);
    expect(e.status).toBe(404);
  });

  test("leaves status undefined when not provided", () => {
    const e = new BaerlyError("NotFound", "x");
    expect(e.status).toBeUndefined();
  });
});
