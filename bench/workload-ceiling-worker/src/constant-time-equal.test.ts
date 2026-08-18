import { describe, expect, test } from "vitest";
import { constantTimeEqual } from "./constant-time-equal.ts";

describe("constantTimeEqual", () => {
  test("equal strings compare true", () => {
    expect(constantTimeEqual("secret-value", "secret-value")).toBe(true);
  });
  test("a one-byte difference compares false", () => {
    expect(constantTimeEqual("secret-value", "secret-valuf")).toBe(false);
  });
  test("a length difference compares false", () => {
    expect(constantTimeEqual("secret", "secret-value")).toBe(false);
  });
  test("a length difference compares false (a strict prefix is the short case)", () => {
    expect(constantTimeEqual("secret-value", "secret")).toBe(false);
  });
  test("empty versus nonempty compares false, empty versus empty true", () => {
    expect(constantTimeEqual("", "x")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
  test("non-ASCII secrets compare on UTF-8 bytes, not code units", () => {
    // Precomposed U+00E9 vs 'e' + combining U+0301: same visual, different bytes.
    // Write both as escapes so the source can't silently normalize them.
    expect(constantTimeEqual("s\u00e9cret", "s\u00e9cret")).toBe(true);
    expect(constantTimeEqual("s\u00e9cret", "se\u0301cret")).toBe(false);
  });
});
