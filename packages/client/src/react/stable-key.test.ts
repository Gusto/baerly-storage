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

  test("wire predicate: equivalent clause lists hash identically", () => {
    // The React hook now feeds `PredicateWire` into stableKey. Two
    // wires with the same clause list serialise identically — the
    // outer `{clauses: …}` key is the only top-level field.
    expect(stableKey({ clauses: [{ op: "in", field: "status", value: ["open", "p1"] }] })).toBe(
      stableKey({ clauses: [{ op: "in", field: "status", value: ["open", "p1"] }] }),
    );
  });

  test("wire predicate: in-clause value-array order is preserved", () => {
    expect(stableKey({ clauses: [{ op: "in", field: "status", value: ["a", "b"] }] })).not.toBe(
      stableKey({ clauses: [{ op: "in", field: "status", value: ["b", "a"] }] }),
    );
  });

  test("wire predicate: gt vs lt produce distinct keys", () => {
    expect(stableKey({ clauses: [{ op: "gt", field: "priority", value: 1 }] })).not.toBe(
      stableKey({ clauses: [{ op: "lt", field: "priority", value: 1 }] }),
    );
  });

  test("wire predicate: clause object key order does not matter", () => {
    // The wire's per-clause object keys (`op` / `field` / `value`)
    // can land in any order on the JSON parse — stableKey normalises
    // by sorting keys recursively.
    expect(stableKey({ op: "eq", field: "x", value: 1 })).toBe(
      stableKey({ value: 1, field: "x", op: "eq" }),
    );
  });
});
