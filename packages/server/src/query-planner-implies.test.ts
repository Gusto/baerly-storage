import { describe, expect, test } from "vitest";

import { type DocumentValue, matches, type Predicate } from "@baerly/protocol";

import { predicateImplies } from "./query-planner-implies.ts";

describe("predicateImplies", () => {
  // Helper to construct predicates without TypeScript's literal-type
  // narrowing. The runtime predicate type is far more permissive
  // than the declared `Predicate<T>` (which keys off the doc shape);
  // tests over arbitrary fixtures use the open-world DocumentValue
  // shape directly.
  const P = (p: Record<string, DocumentValue>): Predicate => p as unknown as Predicate;

  test("identical equality predicates → true", () => {
    expect(predicateImplies(P({ status: "open" }), P({ status: "open" }))).toBe(true);
  });

  test("query is a strict superset of filter → true", () => {
    expect(predicateImplies(P({ status: "open" }), P({ status: "open", assignee: "alice" }))).toBe(
      true,
    );
  });

  test("mismatched primitive value → false", () => {
    expect(predicateImplies(P({ status: "open" }), P({ status: "closed" }))).toBe(false);
  });

  test("missing key in queryPredicate → false", () => {
    expect(predicateImplies(P({ status: "open" }), P({ assignee: "a" }))).toBe(false);
  });

  test("nested object equality → true", () => {
    expect(
      predicateImplies(
        P({ assignee: { team: "platform" } }),
        P({ assignee: { team: "platform" } }),
      ),
    ).toBe(true);
  });

  test("nested object — primitive on query side → false", () => {
    expect(predicateImplies(P({ assignee: { team: "p" } }), P({ assignee: "literal" }))).toBe(
      false,
    );
  });

  test("nested object — mismatched leaf → false", () => {
    expect(
      predicateImplies(P({ assignee: { team: "p" } }), P({ assignee: { team: "infra" } })),
    ).toBe(false);
  });

  test("operator-shaped indexFilter implied by equality at or above the bound", () => {
    expect(predicateImplies(P({ age: { $gte: 18 } }), P({ age: 21 }))).toBe(true);
  });

  test("empty indexFilter → true (vacuously implied)", () => {
    expect(predicateImplies({}, P({ status: "open" }))).toBe(true);
    expect(predicateImplies({}, {})).toBe(true);
  });

  test("soundness — when implied, matches(query, doc) ⇒ matches(filter, doc)", () => {
    // Pin the load-bearing soundness property: when
    // predicateImplies(filter, query) is `true`,
    // matches(query, doc) ⇒ matches(filter, doc) for any doc.
    const filter = P({ status: "open" });
    const query = P({ status: "open", priority: "p1" });
    expect(predicateImplies(filter, query)).toBe(true);
    const matchingDoc = { status: "open", priority: "p1", assignee: "alice" };
    expect(matches(query, matchingDoc)).toBe(true);
    expect(matches(filter, matchingDoc)).toBe(true);
  });
});

describe("predicateImplies — range and $in", () => {
  // Test predicates use `$in: [...]` clauses whose array members don't
  // fit `Record<string, DocumentValue>`; the open-world Predicate type
  // accepts them at runtime, so we cast each fixture via `unknown`.
  const P = (p: Record<string, unknown>): Predicate => p as unknown as Predicate;

  test("$gte filter implied by larger $gte query", () => {
    expect(predicateImplies(P({ age: { $gte: 18 } }), P({ age: { $gte: 21 } }))).toBe(true);
  });
  test("$gte filter implied by larger $gt query", () => {
    expect(predicateImplies(P({ age: { $gte: 18 } }), P({ age: { $gt: 20 } }))).toBe(true);
  });
  test("$gte filter implied by equality at or above the bound", () => {
    expect(predicateImplies(P({ age: { $gte: 18 } }), P({ age: 21 }))).toBe(true);
    expect(predicateImplies(P({ age: { $gte: 18 } }), P({ age: 18 }))).toBe(true);
  });
  test("$gte filter NOT implied by equality below the bound", () => {
    expect(predicateImplies(P({ age: { $gte: 18 } }), P({ age: 17 }))).toBe(false);
  });
  test("$gt vs $gte at the same value", () => {
    // strict filter, inclusive query → not implied
    expect(predicateImplies(P({ age: { $gt: 18 } }), P({ age: { $gte: 18 } }))).toBe(false);
    // inclusive filter, strict query → implied
    expect(predicateImplies(P({ age: { $gte: 18 } }), P({ age: { $gt: 18 } }))).toBe(true);
  });
  test("combined $gte/$lte filter implied by combined query bounds", () => {
    expect(
      predicateImplies(P({ age: { $gte: 18, $lte: 65 } }), P({ age: { $gte: 21, $lte: 60 } })),
    ).toBe(true);
  });
  test("combined filter NOT implied when one side of the query is missing", () => {
    expect(predicateImplies(P({ age: { $gte: 18, $lte: 65 } }), P({ age: { $gte: 21 } }))).toBe(
      false,
    );
  });
  test("$in filter implied by $in query that is a subset", () => {
    expect(
      predicateImplies(
        P({ priority: { $in: ["p0", "p1", "p2"] } }),
        P({ priority: { $in: ["p0", "p1"] } }),
      ),
    ).toBe(true);
  });
  test("$in filter implied by equality on a member", () => {
    expect(
      predicateImplies(P({ priority: { $in: ["p0", "p1", "p2"] } }), P({ priority: "p1" })),
    ).toBe(true);
  });
  test("$in filter NOT implied by equality outside the set", () => {
    expect(predicateImplies(P({ priority: { $in: ["p0", "p1"] } }), P({ priority: "p2" }))).toBe(
      false,
    );
  });
  test("$in filter NOT implied by a range query", () => {
    expect(
      predicateImplies(P({ priority: { $in: ["p0", "p1"] } }), P({ priority: { $gte: "p0" } })),
    ).toBe(false);
  });
  test("mixed types in range comparison: refuse implication", () => {
    expect(predicateImplies(P({ x: { $gte: 18 } }), P({ x: { $gte: "18" } }))).toBe(false);
  });

  test("$gte filter implied by $in query whose min is ≥ the bound", () => {
    expect(predicateImplies(P({ age: { $gte: 18 } }), P({ age: { $in: [21, 30, 22] } }))).toBe(
      true,
    );
  });

  test("$gte filter NOT implied by $in query with a member below the bound", () => {
    expect(predicateImplies(P({ age: { $gte: 18 } }), P({ age: { $in: [17, 30] } }))).toBe(false);
  });

  test("$lt filter implied by $in query whose max is < the bound", () => {
    expect(predicateImplies(P({ age: { $lt: 65 } }), P({ age: { $in: [21, 30, 50] } }))).toBe(true);
  });

  test("$lt filter NOT implied by $in query with a member at or above the bound", () => {
    expect(predicateImplies(P({ age: { $lt: 65 } }), P({ age: { $in: [21, 65] } }))).toBe(false);
  });
});
