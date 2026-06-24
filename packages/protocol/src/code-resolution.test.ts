import { describe, expect, test } from "vitest";
import {
  CODE_RESOLUTIONS,
  WHERE_ORDER_JSON_RESOLUTION,
  WRITE_BODY_SHAPE_RESOLUTION,
} from "./code-resolution.ts";

describe("CODE_RESOLUTIONS", () => {
  test("covers the actionable codes with a non-empty string", () => {
    for (const code of ["PayloadTooLarge", "Unauthorized", "AccessDenied", "NotFound"] as const) {
      expect(CODE_RESOLUTIONS[code]).toBeTypeOf("string");
      expect(CODE_RESOLUTIONS[code]!.length).toBeGreaterThan(0);
    }
  });

  test("omits transient/opaque and context-dependent codes", () => {
    for (const code of [
      "Conflict",
      "NetworkError",
      "InvalidResponse",
      "Internal",
      "InvalidConfig",
      "SchemaError",
    ] as const) {
      expect(CODE_RESOLUTIONS[code]).toBeUndefined();
    }
  });

  test("reusable request-path strings are non-empty", () => {
    expect(WHERE_ORDER_JSON_RESOLUTION.length).toBeGreaterThan(0);
    expect(WRITE_BODY_SHAPE_RESOLUTION.length).toBeGreaterThan(0);
  });
});
