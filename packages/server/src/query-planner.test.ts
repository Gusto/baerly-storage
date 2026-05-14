/**
 * Pure-unit tests for the query planner. No `Db`, no `Storage`, no
 * I/O — the planner is a pure function over `(predicate, indexes)`.
 */

import type { Predicate, JSONArraylessObject } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import type { IndexDefinition } from "./indexes.ts";
import { planQuery } from "./query-planner.ts";

describe("planQuery", () => {
  test("no predicate → full-scan with reason 'no-predicate'", () => {
    expect(planQuery(undefined, [])).toEqual({
      kind: "full-scan",
      reason: "no-predicate",
    });
  });

  test("no declared indexes → full-scan with reason 'no-indexes-declared'", () => {
    expect(planQuery({ a: 1 } as unknown as Predicate<JSONArraylessObject>, [])).toEqual({
      kind: "full-scan",
      reason: "no-indexes-declared",
    });
  });

  test("single-field equality routes to single-field index", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const plan = planQuery(
      { status: "open" } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status",
      equalityKeys: ["open"],
    });
  });

  test("composite full hit — two-field predicate over two-field index", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status_priority", on: ["status", "priority"] }];
    const plan = planQuery(
      { status: "open", priority: "p2" } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status_priority",
      equalityKeys: ["open", "p2"],
    });
  });

  test("composite partial-prefix hit — one of two indexed fields", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status_priority", on: ["status", "priority"] }];
    const plan = planQuery(
      { status: "open" } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status_priority",
      equalityKeys: ["open"],
    });
  });

  test("composite partial-prefix hit at length 2 of 3", () => {
    const indexes: IndexDefinition[] = [{ name: "by_a_b_c", on: ["a", "b", "c"] }];
    const plan = planQuery({ a: 1, b: 2 } as unknown as Predicate<JSONArraylessObject>, indexes);
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_a_b_c",
      equalityKeys: [1, 2],
    });
  });

  test("left-anchor rejection — equality on a non-leading field doesn't match", () => {
    const indexes: IndexDefinition[] = [{ name: "by_a_b", on: ["a", "b"] }];
    const plan = planQuery({ b: 2 } as unknown as Predicate<JSONArraylessObject>, indexes);
    expect(plan).toEqual({
      kind: "full-scan",
      reason: "no-matching-index",
    });
  });

  test("tie-break by declaration order — first-declared wins at equal prefix len", () => {
    // Both indexes can walk at prefix-length 1 against `{status: "open"}`.
    // Iteration order is the array order; the composite is declared first.
    const indexes: IndexDefinition[] = [
      { name: "by_status_priority", on: ["status", "priority"] },
      { name: "by_status", on: "status" },
    ];
    const plan = planQuery(
      { status: "open" } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status_priority",
      equalityKeys: ["open"],
    });
  });

  test("longer prefix wins over shorter when not a tie", () => {
    const indexes: IndexDefinition[] = [
      { name: "by_status_priority", on: ["status", "priority"] },
      { name: "by_status", on: "status" },
    ];
    const plan = planQuery(
      { status: "open", priority: "p2" } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status_priority",
      equalityKeys: ["open", "p2"],
    });
  });

  test("operator-only predicate → full-scan 'predicate-uses-operators-only'", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const plan = planQuery(
      { status: { $gt: "p0" } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "full-scan",
      reason: "predicate-uses-operators-only",
    });
  });

  test("mixed predicate (equality + operator) routes equality, residue holds operator", () => {
    const indexes: IndexDefinition[] = [{ name: "by_a", on: "a" }];
    const plan = planQuery(
      { a: "x", b: { $gt: 5 } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_a",
      equalityKeys: ["x"],
      postFilter: { b: { $gt: 5 } },
    });
  });

  test("equality on non-indexed field lands on residue", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const plan = planQuery(
      { status: "open", assignee: "alice" } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status",
      equalityKeys: ["open"],
      postFilter: { assignee: "alice" },
    });
  });
});
