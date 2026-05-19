import { describe, expect, test } from "vitest";
import { decideSample } from "./sampling.ts";

describe("decideSample", () => {
  test("rate >= 1.0 always samples", () => {
    expect(decideSample("anything", 1)).toBe(true);
    expect(decideSample("anything", 2)).toBe(true);
    expect(decideSample("", 1)).toBe(true);
  });

  test("rate <= 0.0 never samples", () => {
    expect(decideSample("anything", 0)).toBe(false);
    expect(decideSample("anything", -0.5)).toBe(false);
  });

  test("is deterministic for the same input", () => {
    const id = "deterministic-test-id";
    const first = decideSample(id, 0.5);
    const second = decideSample(id, 0.5);
    expect(first).toBe(second);
  });

  test("produces a roughly-correct distribution over 1000 distinct UUIDs", () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(crypto.randomUUID());
    }

    const sampledAt = (rate: number): number =>
      ids.reduce((acc, id) => acc + (decideSample(id, rate) ? 1 : 0), 0);

    // Tolerances picked per the brief (±0.05).
    expect(sampledAt(0)).toBe(0);
    expect(sampledAt(1)).toBe(1000);

    const at10 = sampledAt(0.1) / 1000;
    expect(at10).toBeGreaterThanOrEqual(0.05);
    expect(at10).toBeLessThanOrEqual(0.15);

    const at50 = sampledAt(0.5) / 1000;
    expect(at50).toBeGreaterThanOrEqual(0.45);
    expect(at50).toBeLessThanOrEqual(0.55);
  });
});
