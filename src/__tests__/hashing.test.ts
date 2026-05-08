import { expect, test, describe } from "vitest";

import { fromB64, toB64, or, inside } from "../hashing";
import { uuid } from "../types";

describe("b64/uint", () => {
  test("round trip", () => {
    const start = toB64(new TextEncoder().encode("cool"));
    expect(toB64(fromB64(start))).toBe(start);
  });
});

describe("or and inside", () => {
  test("forall a, b: a inside (a or b) ", () => {
    const enc = new TextEncoder();
    for (let tries = 0; tries < 10; tries++) {
      const a = toB64(enc.encode(uuid()));
      const b = toB64(enc.encode(uuid()));

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
