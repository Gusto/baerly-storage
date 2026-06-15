import { test, expect } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { assertKeyWithinLimit } from "./key-limit.ts";

test("accepts a key at the limit, rejects one over", () => {
  expect(() => assertKeyWithinLimit("a".repeat(1024))).not.toThrow();
  try {
    assertKeyWithinLimit("a".repeat(1025));
    throw new Error("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(BaerlyError);
    expect((error as BaerlyError).code).toBe("InvalidConfig");
  }
});
