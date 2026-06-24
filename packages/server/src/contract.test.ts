import { describe, expect, test } from "vitest";
import { errorEnvelope } from "./contract.ts";

describe("errorEnvelope", () => {
  test("carries retriable derived from code", () => {
    expect(errorEnvelope("Conflict", "x").error.retriable).toBe(true);
    expect(errorEnvelope("NetworkError", "x").error.retriable).toBe(true);
    expect(errorEnvelope("SchemaError", "x").error.retriable).toBe(false);
  });

  test("non-retriable codes carry retriable: false", () => {
    expect(errorEnvelope("NotFound", "not found").error.retriable).toBe(false);
    expect(errorEnvelope("Internal", "boom").error.retriable).toBe(false);
    expect(errorEnvelope("Unauthorized", "no auth").error.retriable).toBe(false);
  });

  test("retriable is always present (never undefined)", () => {
    const env = errorEnvelope("Conflict", "x");
    expect(typeof env.error.retriable).toBe("boolean");
  });

  test("retriable can be overridden per error instance", () => {
    expect(
      errorEnvelope("Conflict", "duplicate _id", undefined, undefined, false).error.retriable,
    ).toBe(false);
    expect(
      errorEnvelope("SchemaError", "temporary", undefined, undefined, true).error.retriable,
    ).toBe(true);
  });

  test("resolution is included when provided", () => {
    const env = errorEnvelope("InvalidConfig", "x", undefined, "do X");
    expect(env.error.resolution).toBe("do X");
  });

  test("resolution is absent when not provided", () => {
    const env = errorEnvelope("InvalidConfig", "x");
    expect(env.error.resolution).toBeUndefined();
  });

  test("falls back to the per-code default resolution", () => {
    expect(errorEnvelope("NotFound", "No such row: x").error.resolution).toBe(
      "No row matches this id; create it first or treat this as a miss.",
    );
  });

  test("a site-provided resolution wins over the per-code default", () => {
    expect(errorEnvelope("Conflict", "x", undefined, "custom fix").error.resolution).toBe(
      "custom fix",
    );
  });

  test("codes without a default and without a site value omit resolution", () => {
    expect(errorEnvelope("Conflict", "CAS lost").error.resolution).toBeUndefined();
    expect(errorEnvelope("NetworkError", "x").error.resolution).toBeUndefined();
    expect(errorEnvelope("Internal", "boom").error.resolution).toBeUndefined();
  });

  test("CAS conflict resolution is supplied by the throw site", () => {
    const resolution = "Re-read and re-apply your change.";
    expect(errorEnvelope("Conflict", "CAS lost", undefined, resolution).error.resolution).toBe(
      resolution,
    );
  });
});
