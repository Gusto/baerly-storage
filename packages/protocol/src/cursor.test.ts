import { describe, expect, test } from "vitest";

import { BaerlyError } from "./errors.ts";
import { formatCursor, NO_GENERATION, parseCursor } from "./cursor.ts";

const LSN = "01j8x_a3f9c2_zzzy";
const GEN = "7f3a9c21b4d0";

describe("formatCursor", () => {
  test("pairs a generation with an lsn", () => {
    expect(formatCursor(GEN, LSN)).toBe(`${GEN}.${LSN}`);
  });

  test("emits the sentinel when the manifest has no generation", () => {
    expect(formatCursor(undefined, LSN)).toBe(`${NO_GENERATION}.${LSN}`);
  });
});

describe("parseCursor", () => {
  test("round-trips a formatted cursor", () => {
    expect(parseCursor(formatCursor(GEN, LSN))).toEqual({ generation: GEN, lsn: LSN });
  });

  test("decodes a bare lsn to the sentinel rather than throwing", () => {
    // A cursor minted before the composite shape existed. Rejecting it
    // would force every in-flight long-poll client to re-bootstrap on
    // deploy, for a collection where nothing happened.
    expect(parseCursor(LSN)).toEqual({ generation: NO_GENERATION, lsn: LSN });
  });

  test("a sentinel cursor and a sentinel manifest compare equal", () => {
    // The property that lets `/v1/since` use one string comparison with
    // no fail-open branch for pre-generation manifests.
    expect(parseCursor(formatCursor(undefined, LSN)).generation).toBe(NO_GENERATION);
  });

  test("rejects more than one separator", () => {
    expect(() => parseCursor(`${GEN}.${LSN}.extra`)).toThrow(BaerlyError);
    try {
      parseCursor(`${GEN}.${LSN}.extra`);
      expect.unreachable("should have thrown");
    } catch (error) {
      // SchemaError maps to HTTP 400 — caller fault, not a storage fault.
      expect((error as BaerlyError).code).toBe("SchemaError");
    }
  });

  test("an empty cursor decodes to the sentinel", () => {
    // `/v1/since` short-circuits `cursor === ""` before parsing, but the
    // codec must not throw on it either.
    expect(parseCursor("")).toEqual({ generation: NO_GENERATION, lsn: "" });
  });
});
