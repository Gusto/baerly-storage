import { describe, expect, test } from "vitest";
import { deriveOutcome } from "./derive-outcome.ts";

describe("deriveOutcome", () => {
  test("GET 2xx → read", () => {
    expect(deriveOutcome("GET", 200)).toBe("read");
    expect(deriveOutcome("GET", 204)).toBe("read");
  });

  test("POST/PATCH/DELETE 2xx → committed", () => {
    expect(deriveOutcome("POST", 201)).toBe("committed");
    expect(deriveOutcome("PATCH", 200)).toBe("committed");
    expect(deriveOutcome("DELETE", 204)).toBe("committed");
  });

  test("409 → conflict", () => {
    expect(deriveOutcome("PATCH", 409)).toBe("conflict");
    expect(deriveOutcome("POST", 409)).toBe("conflict");
  });

  test("other 4xx → error", () => {
    expect(deriveOutcome("GET", 400)).toBe("error");
    expect(deriveOutcome("GET", 401)).toBe("error");
    expect(deriveOutcome("GET", 404)).toBe("error");
    expect(deriveOutcome("POST", 413)).toBe("error");
  });

  test("5xx without error → error", () => {
    expect(deriveOutcome("GET", 500)).toBe("error");
    expect(deriveOutcome("POST", 503)).toBe("error");
  });

  test("5xx with error short-circuits to error", () => {
    expect(deriveOutcome("GET", 500, new Error("boom"))).toBe("error");
    expect(deriveOutcome("POST", 503, "string-thrown")).toBe("error");
  });

  test("undefined error parameter falls through to status classification", () => {
    expect(deriveOutcome("GET", 200, undefined)).toBe("read");
    expect(deriveOutcome("POST", 409, undefined)).toBe("conflict");
  });

  test("error attached on 2xx doesn't override the success classification", () => {
    // The short-circuit is intentionally guarded by `status >= 500`;
    // an error attached to a 2xx (rare but possible via
    // `c.error`-with-recovery) doesn't reclassify.
    expect(deriveOutcome("GET", 200, new Error("recovered"))).toBe("read");
  });
});
