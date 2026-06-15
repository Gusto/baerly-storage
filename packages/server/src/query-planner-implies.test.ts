import { describe, expect, test } from "vitest";

import {
  type DocumentValue,
  matchesWire,
  type PredicateClause,
  type PredicateWire,
} from "@baerly/protocol";

import { predicateImplies } from "./query-planner-implies.ts";

const wire = (clauses: PredicateClause[]): PredicateWire => ({ clauses });
const eq = (field: string, value: DocumentValue): PredicateClause => ({
  op: "eq",
  field,
  value,
});

describe("predicateImplies", () => {
  test("identical equality predicates → true", () => {
    expect(predicateImplies(wire([eq("status", "open")]), wire([eq("status", "open")]))).toBe(true);
  });

  test("query is a strict superset of filter → true", () => {
    expect(
      predicateImplies(
        wire([eq("status", "open")]),
        wire([eq("status", "open"), eq("assignee", "alice")]),
      ),
    ).toBe(true);
  });

  test("mismatched primitive value → false", () => {
    expect(predicateImplies(wire([eq("status", "open")]), wire([eq("status", "closed")]))).toBe(
      false,
    );
  });

  test("missing key in queryWire → false", () => {
    expect(predicateImplies(wire([eq("status", "open")]), wire([eq("assignee", "a")]))).toBe(false);
  });

  test("nested equality via dotted-path eq → true", () => {
    expect(
      predicateImplies(
        wire([eq("assignee.team", "platform")]),
        wire([eq("assignee.team", "platform")]),
      ),
    ).toBe(true);
  });

  test("nested equality — mismatched leaf → false", () => {
    expect(
      predicateImplies(wire([eq("assignee.team", "p")]), wire([eq("assignee.team", "infra")])),
    ).toBe(false);
  });

  test("range filter (gte) implied by equality at or above the bound", () => {
    expect(
      predicateImplies(wire([{ op: "gte", field: "age", value: 18 }]), wire([eq("age", 21)])),
    ).toBe(true);
  });

  test("empty indexFilterWire → true (vacuously implied)", () => {
    expect(predicateImplies(wire([]), wire([eq("status", "open")]))).toBe(true);
    expect(predicateImplies(wire([]), wire([]))).toBe(true);
  });

  test("soundness — when implied, matchesWire(query, doc) ⇒ matchesWire(filter, doc)", () => {
    const filter = wire([eq("status", "open")]);
    const query = wire([eq("status", "open"), eq("priority", "p1")]);
    expect(predicateImplies(filter, query)).toBe(true);
    const matchingDoc = { status: "open", priority: "p1", assignee: "alice" };
    expect(matchesWire(query, matchingDoc)).toBe(true);
    expect(matchesWire(filter, matchingDoc)).toBe(true);
  });
});

describe("predicateImplies — range and in", () => {
  test("gte filter implied by larger gte query", () => {
    expect(
      predicateImplies(
        wire([{ op: "gte", field: "age", value: 18 }]),
        wire([{ op: "gte", field: "age", value: 21 }]),
      ),
    ).toBe(true);
  });

  test("gte filter implied by larger gt query", () => {
    expect(
      predicateImplies(
        wire([{ op: "gte", field: "age", value: 18 }]),
        wire([{ op: "gt", field: "age", value: 20 }]),
      ),
    ).toBe(true);
  });

  test("gte filter implied by equality at or above the bound", () => {
    expect(
      predicateImplies(wire([{ op: "gte", field: "age", value: 18 }]), wire([eq("age", 21)])),
    ).toBe(true);
    expect(
      predicateImplies(wire([{ op: "gte", field: "age", value: 18 }]), wire([eq("age", 18)])),
    ).toBe(true);
  });

  test("gte filter NOT implied by equality below the bound", () => {
    expect(
      predicateImplies(wire([{ op: "gte", field: "age", value: 18 }]), wire([eq("age", 17)])),
    ).toBe(false);
  });

  test("gt vs gte at the same value", () => {
    // strict filter, inclusive query → not implied
    expect(
      predicateImplies(
        wire([{ op: "gt", field: "age", value: 18 }]),
        wire([{ op: "gte", field: "age", value: 18 }]),
      ),
    ).toBe(false);
    // inclusive filter, strict query → implied
    expect(
      predicateImplies(
        wire([{ op: "gte", field: "age", value: 18 }]),
        wire([{ op: "gt", field: "age", value: 18 }]),
      ),
    ).toBe(true);
  });

  test("combined gte/lte filter implied by combined query bounds", () => {
    expect(
      predicateImplies(
        wire([
          { op: "gte", field: "age", value: 18 },
          { op: "lte", field: "age", value: 65 },
        ]),
        wire([
          { op: "gte", field: "age", value: 21 },
          { op: "lte", field: "age", value: 60 },
        ]),
      ),
    ).toBe(true);
  });

  test("combined filter NOT implied when one side of the query is missing", () => {
    expect(
      predicateImplies(
        wire([
          { op: "gte", field: "age", value: 18 },
          { op: "lte", field: "age", value: 65 },
        ]),
        wire([{ op: "gte", field: "age", value: 21 }]),
      ),
    ).toBe(false);
  });

  test("in filter implied by in query that is a subset", () => {
    expect(
      predicateImplies(
        wire([{ op: "in", field: "priority", value: ["p0", "p1", "p2"] }]),
        wire([{ op: "in", field: "priority", value: ["p0", "p1"] }]),
      ),
    ).toBe(true);
  });

  test("in filter implied by equality on a member", () => {
    expect(
      predicateImplies(
        wire([{ op: "in", field: "priority", value: ["p0", "p1", "p2"] }]),
        wire([eq("priority", "p1")]),
      ),
    ).toBe(true);
  });

  test("in filter NOT implied by equality outside the set", () => {
    expect(
      predicateImplies(
        wire([{ op: "in", field: "priority", value: ["p0", "p1"] }]),
        wire([eq("priority", "p2")]),
      ),
    ).toBe(false);
  });

  test("in filter NOT implied by a range query", () => {
    expect(
      predicateImplies(
        wire([{ op: "in", field: "priority", value: ["p0", "p1"] }]),
        wire([{ op: "gte", field: "priority", value: "p0" }]),
      ),
    ).toBe(false);
  });

  test("mixed types in range comparison: refuse implication", () => {
    expect(
      predicateImplies(
        wire([{ op: "gte", field: "x", value: 18 }]),
        wire([{ op: "gte", field: "x", value: "18" }]),
      ),
    ).toBe(false);
  });

  test("gte filter implied by in query whose min is ≥ the bound", () => {
    expect(
      predicateImplies(
        wire([{ op: "gte", field: "age", value: 18 }]),
        wire([{ op: "in", field: "age", value: [21, 30, 22] }]),
      ),
    ).toBe(true);
  });

  test("gte filter NOT implied by in query with a member below the bound", () => {
    expect(
      predicateImplies(
        wire([{ op: "gte", field: "age", value: 18 }]),
        wire([{ op: "in", field: "age", value: [17, 30] }]),
      ),
    ).toBe(false);
  });

  test("lt filter implied by in query whose max is < the bound", () => {
    expect(
      predicateImplies(
        wire([{ op: "lt", field: "age", value: 65 }]),
        wire([{ op: "in", field: "age", value: [21, 30, 50] }]),
      ),
    ).toBe(true);
  });

  test("lt filter NOT implied by in query with a member at or above the bound", () => {
    expect(
      predicateImplies(
        wire([{ op: "lt", field: "age", value: 65 }]),
        wire([{ op: "in", field: "age", value: [21, 65] }]),
      ),
    ).toBe(false);
  });
});
