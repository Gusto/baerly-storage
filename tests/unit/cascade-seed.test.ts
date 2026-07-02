import { describe, expect, test } from "vitest";
import { makeLcg } from "../fixtures/randomized-cascade.ts";

describe("makeLcg (seeded cascade RNG)", () => {
  test("same seed produces the same sequence", () => {
    const a = makeLcg(42);
    const b = makeLcg(42);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  test("different seeds diverge", () => {
    const a = makeLcg(1);
    const b = makeLcg(2);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  test("outputs are in [0, 1)", () => {
    const r = makeLcg(12345);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
