/**
 * Pure-unit tests for the query planner. No `Db`, no `Storage`, no
 * I/O — the planner is a pure function over `(wire, indexes)`.
 */

import type { PredicateWire } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import type { IndexDefinition } from "./indexes.ts";
import { IN_FANOUT_THRESHOLD, planQuery } from "./query-planner.ts";

const wire = (clauses: PredicateWire["clauses"]): PredicateWire => ({ clauses });

describe("planQuery", () => {
  test("no predicate → full-scan with reason 'no-predicate'", () => {
    expect(planQuery(undefined, [])).toEqual({
      kind: "full-scan",
      reason: "no-predicate",
    });
  });

  test("empty wire → full-scan with reason 'no-predicate'", () => {
    expect(planQuery(wire([]), [])).toEqual({
      kind: "full-scan",
      reason: "no-predicate",
    });
  });

  test("no declared indexes → full-scan with reason 'no-indexes-declared'", () => {
    expect(planQuery(wire([{ op: "eq", field: "a", value: 1 }]), [])).toEqual({
      kind: "full-scan",
      reason: "no-indexes-declared",
    });
  });

  test("single-field equality routes to single-field index", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const plan = planQuery(wire([{ op: "eq", field: "status", value: "open" }]), indexes);
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status",
      equalityKeys: ["open"],
    });
  });

  test("composite full hit — two-field predicate over two-field index", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status_priority", on: ["status", "priority"] }];
    const plan = planQuery(
      wire([
        { op: "eq", field: "status", value: "open" },
        { op: "eq", field: "priority", value: "p2" },
      ]),
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
    const plan = planQuery(wire([{ op: "eq", field: "status", value: "open" }]), indexes);
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status_priority",
      equalityKeys: ["open"],
    });
  });

  test("composite partial-prefix hit at length 2 of 3", () => {
    const indexes: IndexDefinition[] = [{ name: "by_a_b_c", on: ["a", "b", "c"] }];
    const plan = planQuery(
      wire([
        { op: "eq", field: "a", value: 1 },
        { op: "eq", field: "b", value: 2 },
      ]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_a_b_c",
      equalityKeys: [1, 2],
    });
  });

  test("left-anchor rejection — equality on a non-leading field doesn't match", () => {
    const indexes: IndexDefinition[] = [{ name: "by_a_b", on: ["a", "b"] }];
    const plan = planQuery(wire([{ op: "eq", field: "b", value: 2 }]), indexes);
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
    const plan = planQuery(wire([{ op: "eq", field: "status", value: "open" }]), indexes);
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
      wire([
        { op: "eq", field: "status", value: "open" },
        { op: "eq", field: "priority", value: "p2" },
      ]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status_priority",
      equalityKeys: ["open", "p2"],
    });
  });

  test("operator-only predicate with no matching index → 'no-matching-index'", () => {
    // Range op on a NON-indexed field — the planner has nothing to
    // route, even though `by_status` is declared.
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const plan = planQuery(wire([{ op: "gt", field: "priority", value: "p0" }]), indexes);
    expect(plan).toEqual({
      kind: "full-scan",
      reason: "no-matching-index",
    });
  });

  test("mixed predicate (equality + range on non-indexed field) routes the equality", () => {
    // Unconsumed clauses (the `gt` on a non-indexed field) are NOT
    // surfaced on the plan — the executor re-applies the full
    // original wire via `matchesWire(...)` post-fetch.
    const indexes: IndexDefinition[] = [{ name: "by_a", on: "a" }];
    const plan = planQuery(
      wire([
        { op: "eq", field: "a", value: "x" },
        { op: "gt", field: "b", value: 5 },
      ]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_a",
      equalityKeys: ["x"],
    });
  });

  test("equality on non-indexed field is left for the executor's post-fetch re-check", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const plan = planQuery(
      wire([
        { op: "eq", field: "status", value: "open" },
        { op: "eq", field: "assignee", value: "alice" },
      ]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status",
      equalityKeys: ["open"],
    });
  });
});

describe("planQuery — range walks", () => {
  test("single-field range, inclusive lower, no upper", () => {
    const indexes: IndexDefinition[] = [{ name: "by_priority", on: "priority" }];
    const plan = planQuery(wire([{ op: "gte", field: "priority", value: "p2" }]), indexes);
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_priority",
      equalityKeys: [],
      rangeOn: {
        field: "priority",
        lo: "p2",
        loInclusive: true,
        hiInclusive: false,
      },
    });
  });

  test("single-field range, exclusive both sides", () => {
    const indexes: IndexDefinition[] = [{ name: "by_priority", on: "priority" }];
    const plan = planQuery(
      wire([
        { op: "gt", field: "priority", value: "p1" },
        { op: "lt", field: "priority", value: "p9" },
      ]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_priority",
      equalityKeys: [],
      rangeOn: {
        field: "priority",
        lo: "p1",
        hi: "p9",
        loInclusive: false,
        hiInclusive: false,
      },
    });
  });

  test("composite eq+range on tail field", () => {
    const indexes: IndexDefinition[] = [{ name: "by_tenant_priority", on: ["tenant", "priority"] }];
    const plan = planQuery(
      wire([
        { op: "eq", field: "tenant", value: "acme" },
        { op: "gte", field: "priority", value: "p2" },
        { op: "lt", field: "priority", value: "p9" },
      ]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_tenant_priority",
      equalityKeys: ["acme"],
      rangeOn: {
        field: "priority",
        lo: "p2",
        hi: "p9",
        loInclusive: true,
        hiInclusive: false,
      },
    });
  });

  test("range on non-last indexed field falls back to single-field range walk", () => {
    // Range op on the FIRST slot prevents left-anchored routing.
    const indexes: IndexDefinition[] = [{ name: "by_tenant_priority", on: ["tenant", "priority"] }];
    const plan = planQuery(
      wire([
        { op: "gt", field: "tenant", value: "a" },
        { op: "eq", field: "priority", value: "p1" },
      ]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_tenant_priority",
      equalityKeys: [],
      rangeOn: {
        field: "tenant",
        lo: "a",
        loInclusive: false,
        hiInclusive: false,
      },
    });
  });

  test("equality on first slot, range on non-indexed field still routes the equality", () => {
    const indexes: IndexDefinition[] = [{ name: "by_tenant", on: "tenant" }];
    const plan = planQuery(
      wire([
        { op: "eq", field: "tenant", value: "acme" },
        { op: "gt", field: "priority", value: "p1" },
      ]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_tenant",
      equalityKeys: ["acme"],
    });
  });

  test("range inclusivity round-trip — gte/gt/lte/lt set flags correctly", () => {
    const indexes: IndexDefinition[] = [{ name: "by_p", on: "p" }];
    expect(planQuery(wire([{ op: "gte", field: "p", value: "a" }]), indexes)).toMatchObject({
      rangeOn: { lo: "a", loInclusive: true, hiInclusive: false },
    });
    expect(planQuery(wire([{ op: "gt", field: "p", value: "a" }]), indexes)).toMatchObject({
      rangeOn: { lo: "a", loInclusive: false, hiInclusive: false },
    });
    expect(planQuery(wire([{ op: "lte", field: "p", value: "z" }]), indexes)).toMatchObject({
      rangeOn: { hi: "z", hiInclusive: true, loInclusive: false },
    });
    expect(planQuery(wire([{ op: "lt", field: "p", value: "z" }]), indexes)).toMatchObject({
      rangeOn: { hi: "z", hiInclusive: false, loInclusive: false },
    });
  });
});

describe("planQuery — in multi-walk", () => {
  test("in under fan-out threshold emits inOn walk plan", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const plan = planQuery(
      wire([{ op: "in", field: "status", value: ["open", "pending"] }]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status",
      equalityKeys: [],
      inOn: { field: "status", values: ["open", "pending"] },
    });
  });

  test("in at the fan-out threshold (length === 50) emits inOn", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const values = Array.from({ length: IN_FANOUT_THRESHOLD }, (_, i) => `v${i}`);
    const plan = planQuery(wire([{ op: "in", field: "status", value: values }]), indexes);
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.inOn).toBeDefined();
      expect(plan.inOn?.values).toHaveLength(IN_FANOUT_THRESHOLD);
    }
  });

  test("in over the fan-out threshold (length === 51) falls back to full-scan", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const values = Array.from({ length: IN_FANOUT_THRESHOLD + 1 }, (_, i) => `v${i}`);
    const plan = planQuery(wire([{ op: "in", field: "status", value: values }]), indexes);
    expect(plan).toEqual({
      kind: "full-scan",
      reason: "no-matching-index",
    });
  });

  test("composite eq + in on tail field emits inOn walk plan", () => {
    const indexes: IndexDefinition[] = [{ name: "by_tenant_priority", on: ["tenant", "priority"] }];
    const plan = planQuery(
      wire([
        { op: "eq", field: "tenant", value: "acme" },
        { op: "in", field: "priority", value: ["p1", "p2"] },
      ]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_tenant_priority",
      equalityKeys: ["acme"],
      inOn: { field: "priority", values: ["p1", "p2"] },
    });
  });
});

describe("planQuery — numeric range / in routing", () => {
  // The encoder at `./indexes.ts:encodeIndexValue` is value-order-
  // preserving for numbers; numeric ranges/ins route normally.
  test("routes numeric gte/lt range on indexed field", () => {
    const indexes: IndexDefinition[] = [{ name: "by_age", on: "age" }];
    const plan = planQuery(
      wire([
        { op: "gte", field: "age", value: 18 },
        { op: "lt", field: "age", value: 65 },
      ]),
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_age",
      equalityKeys: [],
      rangeOn: {
        field: "age",
        lo: 18,
        hi: 65,
        loInclusive: true,
        hiInclusive: false,
      },
    });
  });

  test("routes numeric upper-bound-only range on indexed field", () => {
    const indexes: IndexDefinition[] = [{ name: "by_age", on: "age" }];
    const plan = planQuery(wire([{ op: "lt", field: "age", value: 100 }]), indexes);
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_age",
      equalityKeys: [],
      rangeOn: {
        field: "age",
        hi: 100,
        loInclusive: false,
        hiInclusive: false,
      },
    });
  });

  test("routes numeric in on indexed field under threshold", () => {
    const indexes: IndexDefinition[] = [{ name: "by_priority", on: "priority" }];
    const plan = planQuery(wire([{ op: "in", field: "priority", value: [1, 2, 3] }]), indexes);
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_priority",
      equalityKeys: [],
      inOn: { field: "priority", values: [1, 2, 3] },
    });
  });

  test("routes mixed numeric + string in on indexed field", () => {
    const indexes: IndexDefinition[] = [{ name: "by_x", on: "x" }];
    const plan = planQuery(wire([{ op: "in", field: "x", value: ["a", 1] }]), indexes);
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_x",
      equalityKeys: [],
      inOn: { field: "x", values: ["a", 1] },
    });
  });
});

describe("planQuery — filtered index cost bias", () => {
  test("filtered index whose filter is implied wins over unfiltered alternative", () => {
    const unfiltered: IndexDefinition = { name: "by_assignee", on: "assignee" };
    const filtered: IndexDefinition = {
      name: "open_by_assignee",
      on: "assignee",
      predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
    };
    // Order the unfiltered FIRST so the cost bias is the only path to
    // picking `filtered` — proves the bias overrides definition order.
    const plan = planQuery(
      wire([
        { op: "eq", field: "status", value: "open" },
        { op: "eq", field: "assignee", value: "alice" },
      ]),
      [unfiltered, filtered],
    );
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.indexName).toBe("open_by_assignee");
      expect(plan.equalityKeys).toEqual(["alice"]);
    }
  });

  test("filtered index whose filter is NOT implied is skipped in favour of unfiltered", () => {
    const unfiltered: IndexDefinition = { name: "by_assignee", on: "assignee" };
    const filtered: IndexDefinition = {
      name: "open_by_assignee",
      on: "assignee",
      predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
    };
    // Query has no `status` clause → filter is NOT implied. The
    // unfiltered index must win even though `filtered` walks at the
    // same equality prefix length.
    const plan = planQuery(wire([{ op: "eq", field: "assignee", value: "alice" }]), [
      filtered,
      unfiltered,
    ]);
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.indexName).toBe("by_assignee");
      expect(plan.equalityKeys).toEqual(["alice"]);
    }
  });

  test("longest equality prefix breaks ties among implied filters", () => {
    const filteredShort: IndexDefinition = {
      name: "open_by_assignee",
      on: "assignee",
      predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
    };
    const filteredLong: IndexDefinition = {
      name: "open_by_assignee_priority",
      on: ["assignee", "priority"],
      predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
    };
    const plan = planQuery(
      wire([
        { op: "eq", field: "status", value: "open" },
        { op: "eq", field: "assignee", value: "alice" },
        { op: "eq", field: "priority", value: "p1" },
      ]),
      [filteredShort, filteredLong],
    );
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.indexName).toBe("open_by_assignee_priority");
      expect(plan.equalityKeys).toEqual(["alice", "p1"]);
    }
  });

  test("filtered composite index beats unfiltered single-field for the same query", () => {
    const unfilteredSingle: IndexDefinition = { name: "by_assignee", on: "assignee" };
    const filteredComposite: IndexDefinition = {
      name: "open_by_assignee_priority",
      on: ["assignee", "priority"],
      predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
    };
    const plan = planQuery(
      wire([
        { op: "eq", field: "status", value: "open" },
        { op: "eq", field: "assignee", value: "alice" },
        { op: "eq", field: "priority", value: "p1" },
      ]),
      [unfilteredSingle, filteredComposite],
    );
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.indexName).toBe("open_by_assignee_priority");
    }
  });

  test("range-filtered index preferred when query range is contained", () => {
    const indexes: IndexDefinition[] = [
      { name: "any_age", on: "age" },
      {
        name: "adults_by_age",
        on: "age",
        predicate: { clauses: [{ op: "gte", field: "age", value: 18 }] },
      },
    ];
    const plan = planQuery(
      wire([
        { op: "gte", field: "age", value: 21 },
        { op: "lte", field: "age", value: 30 },
      ]),
      indexes,
    );
    expect(plan).toMatchObject({ kind: "index-walk", indexName: "adults_by_age" });
  });

  test("in-filtered index preferred when query value is in the filter set", () => {
    const indexes: IndexDefinition[] = [
      { name: "any_priority", on: "priority" },
      {
        name: "p0_p1",
        on: "priority",
        predicate: { clauses: [{ op: "in", field: "priority", value: ["p0", "p1"] }] },
      },
    ];
    const plan = planQuery(wire([{ op: "eq", field: "priority", value: "p1" }]), indexes);
    expect(plan).toMatchObject({ kind: "index-walk", indexName: "p0_p1" });
  });

  test("range-filtered index NOT preferred when query exits the filter", () => {
    const indexes: IndexDefinition[] = [
      { name: "any_age", on: "age" },
      {
        name: "adults_by_age",
        on: "age",
        predicate: { clauses: [{ op: "gte", field: "age", value: 18 }] },
      },
    ];
    const plan = planQuery(
      wire([
        { op: "gte", field: "age", value: 17 },
        { op: "lte", field: "age", value: 30 },
      ]),
      indexes,
    );
    // Falls back to the unfiltered index — walking adults_by_age would
    // miss age=17.
    expect(plan).toMatchObject({ kind: "index-walk", indexName: "any_age" });
  });
});
