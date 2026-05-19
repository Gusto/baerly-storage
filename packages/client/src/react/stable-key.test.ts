import { describe, expect, test } from "vitest";
import { stableKey } from "./stable-key.ts";

describe("stableKey", () => {
  test("sorts top-level keys", () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
  });

  test("sorts nested keys", () => {
    expect(stableKey({ outer: { a: 1, b: 2 } })).toBe(stableKey({ outer: { b: 2, a: 1 } }));
  });

  test("preserves array order", () => {
    expect(stableKey([1, 2, 3])).not.toBe(stableKey([3, 2, 1]));
  });

  test("operator predicates: $in is stable across object key order", () => {
    expect(stableKey({ status: { $in: ["open", "p1"] } })).toBe(
      stableKey({ status: { $in: ["open", "p1"] } }),
    );
  });

  test("operator predicates: $in preserves array order", () => {
    expect(stableKey({ status: { $in: ["a", "b"] } })).not.toBe(
      stableKey({ status: { $in: ["b", "a"] } }),
    );
  });

  test("operator predicates: $gt and $lt produce distinct keys", () => {
    expect(stableKey({ priority: { $gt: 1 } })).not.toBe(stableKey({ priority: { $lt: 1 } }));
  });

  test("operator predicates: outer key order does not matter", () => {
    expect(stableKey({ a: { $gt: 1 }, b: { $lt: 2 } })).toBe(
      stableKey({ b: { $lt: 2 }, a: { $gt: 1 } }),
    );
  });
});
