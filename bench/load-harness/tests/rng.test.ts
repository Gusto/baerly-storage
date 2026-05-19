import { describe, test, expect } from "vitest";
import { makeRng, mulberry32 } from "../generators/rng.ts";

describe("rng determinism", () => {
  test("same seed → same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  test("different seeds diverge by the second draw", () => {
    const a = mulberry32(42);
    const b = mulberry32(43);
    a();
    b();
    expect(a()).not.toBe(b());
  });

  test("makeRng.int respects bounds", () => {
    const r = makeRng(1234);
    for (let i = 0; i < 1000; i++) {
      const x = r.int(5, 10);
      expect(x).toBeGreaterThanOrEqual(5);
      expect(x).toBeLessThan(10);
    }
  });

  test("weighted picks proportionally", () => {
    const r = makeRng(99);
    const items = ["A", "B", "C"];
    const counts = { A: 0, B: 0, C: 0 };
    for (let i = 0; i < 10_000; i++) {
      counts[r.weighted(items, [0.7, 0.2, 0.1]) as "A" | "B" | "C"]++;
    }
    expect(counts.A / 10_000).toBeCloseTo(0.7, 1);
    expect(counts.B / 10_000).toBeCloseTo(0.2, 1);
    expect(counts.C / 10_000).toBeCloseTo(0.1, 1);
  });
});
