import { expect, test, describe } from "vitest";

import { type b64, b642uint, uint2b64, toB64, or, inside } from "../hashing";
import { uuid } from "../types";

describe("b64/uint", () => {
  test("round trip", () => {
    const start = <b64>"cool";
    expect(uint2b64(b642uint(start))).toBe(start);
  });
});

describe("or and inside", () => {
  test("forall a, b: a inside (a or b) ", () => {
    for (let tries = 0; tries < 10; tries++) {
      const a = toB64(uuid());
      const b = toB64(uuid());

      const a_or_b = or(a, b);

      expect(inside(a, b)).toBe(false);
      expect(inside(b, a)).toBe(false);
      expect(inside(a_or_b, a)).toBe(false);
      expect(inside(a_or_b, b)).toBe(false);
      expect(inside(a, a_or_b)).toBe(true);
      expect(inside(b, a_or_b)).toBe(true);
      expect(inside(a, a)).toBe(true);
      expect(inside(b, b)).toBe(true);
      expect(inside(a_or_b, a_or_b)).toBe(true);
    }
  });
});
