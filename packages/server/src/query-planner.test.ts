/**
 * Pure-unit tests for the query planner. No `Db`, no `Storage`, no
 * I/O — the planner is a pure function over `(predicate, indexes)`.
 */

import type { Predicate, JSONArraylessObject } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import type { IndexDefinition } from "./indexes.ts";
import { IN_FANOUT_THRESHOLD, planQuery } from "./query-planner.ts";

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

  test("operator-only predicate with no matching index → 'predicate-uses-operators-only'", () => {
    // T3: a range op on an INDEXED field is now routable via the
    // tail-slot rangeOn slot, so we re-target the test at an op on
    // a NON-INDEXED field — there the planner has nothing to route
    // and the reason discriminant still fires.
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const plan = planQuery(
      { priority: { $gt: "p0" } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "full-scan",
      reason: "no-matching-index",
    });
  });

  test("operator-only predicate with no indexed field at all → 'predicate-uses-operators-only'", () => {
    // When the only predicate clauses are operator-objects on
    // fields none of which appear in any declared index, the
    // partition has zero equality / range / $in candidates that
    // could plausibly be routed.
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    // Use an unsupported mixed-operator shape on a non-indexed
    // field so the partitioner classifies it as neither range nor
    // $in nor equality — falling into the "other" bucket. Today
    // T1 validation would reject this, but the planner's behaviour
    // is well-defined for any partition state.
    const plan = planQuery(
      { priority: { $foo: "p0" } } as unknown as Predicate<JSONArraylessObject>,
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

describe("planQuery — range walks (T3)", () => {
  test("single-field range, inclusive lower, no upper", () => {
    const indexes: IndexDefinition[] = [{ name: "by_priority", on: "priority" }];
    const plan = planQuery(
      { priority: { $gte: "p2" } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
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
      { priority: { $gt: "p1", $lt: "p9" } } as unknown as Predicate<JSONArraylessObject>,
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
      {
        tenant: "acme",
        priority: { $gte: "p2", $lt: "p9" },
      } as unknown as Predicate<JSONArraylessObject>,
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

  test("range on non-last indexed field falls back to no-matching-index", () => {
    // Range op on the FIRST slot prevents left-anchored routing.
    const indexes: IndexDefinition[] = [{ name: "by_tenant_priority", on: ["tenant", "priority"] }];
    const plan = planQuery(
      { tenant: { $gt: "a" }, priority: "p1" } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    // No equality on `tenant`, so the planner can route by treating
    // `tenant` itself as a tail-slot range. That's a single-field
    // range walk over the composite. The `priority` clause becomes
    // postFilter residue.
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
      postFilter: { priority: "p1" },
    });
  });

  test("equality on first slot, range on non-indexed field falls into postFilter", () => {
    const indexes: IndexDefinition[] = [{ name: "by_tenant", on: "tenant" }];
    const plan = planQuery(
      { tenant: "acme", priority: { $gt: "p1" } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_tenant",
      equalityKeys: ["acme"],
      postFilter: { priority: { $gt: "p1" } },
    });
  });

  test("range inclusivity round-trip — $gte/$gt/$lte/$lt set flags correctly", () => {
    const indexes: IndexDefinition[] = [{ name: "by_p", on: "p" }];
    expect(
      planQuery({ p: { $gte: "a" } } as unknown as Predicate<JSONArraylessObject>, indexes),
    ).toMatchObject({
      rangeOn: { lo: "a", loInclusive: true, hiInclusive: false },
    });
    expect(
      planQuery({ p: { $gt: "a" } } as unknown as Predicate<JSONArraylessObject>, indexes),
    ).toMatchObject({
      rangeOn: { lo: "a", loInclusive: false, hiInclusive: false },
    });
    expect(
      planQuery({ p: { $lte: "z" } } as unknown as Predicate<JSONArraylessObject>, indexes),
    ).toMatchObject({
      rangeOn: { hi: "z", hiInclusive: true, loInclusive: false },
    });
    expect(
      planQuery({ p: { $lt: "z" } } as unknown as Predicate<JSONArraylessObject>, indexes),
    ).toMatchObject({
      rangeOn: { hi: "z", hiInclusive: false, loInclusive: false },
    });
  });

  test("string range is allowed (no numeric-range guard tripped)", () => {
    const indexes: IndexDefinition[] = [{ name: "by_priority", on: "priority" }];
    const plan = planQuery(
      { priority: { $gte: "p2" } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.rangeOn).toBeDefined();
    }
  });
});

describe("planQuery — $in multi-walk (T3)", () => {
  test("$in under fan-out threshold emits inOn walk plan", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const plan = planQuery(
      { status: { $in: ["open", "pending"] } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_status",
      equalityKeys: [],
      inOn: { field: "status", values: ["open", "pending"] },
    });
  });

  test("$in at the fan-out threshold (length === 50) emits inOn", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const values = Array.from({ length: IN_FANOUT_THRESHOLD }, (_, i) => `v${i}`);
    const plan = planQuery(
      { status: { $in: values } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.inOn).toBeDefined();
      expect(plan.inOn?.values).toHaveLength(IN_FANOUT_THRESHOLD);
    }
  });

  test("$in over the fan-out threshold (length === 51) falls back to full-scan", () => {
    const indexes: IndexDefinition[] = [{ name: "by_status", on: "status" }];
    const values = Array.from({ length: IN_FANOUT_THRESHOLD + 1 }, (_, i) => `v${i}`);
    const plan = planQuery(
      { status: { $in: values } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "full-scan",
      reason: "no-matching-index",
    });
  });

  test("composite eq + $in on tail field emits inOn walk plan", () => {
    const indexes: IndexDefinition[] = [{ name: "by_tenant_priority", on: ["tenant", "priority"] }];
    const plan = planQuery(
      {
        tenant: "acme",
        priority: { $in: ["p1", "p2"] },
      } as unknown as Predicate<JSONArraylessObject>,
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

describe("planQuery — numeric range / $in routing", () => {
  // The encoder at `./indexes.ts:encodeIndexValue` is value-order-
  // preserving for numbers — the old `numeric-range-on-byte-encoder`
  // full-scan reason was deleted along with the `containsNumber`
  // guard. These tests pin the routed plans.
  test("routes numeric $gte/$lt range on indexed field", () => {
    const indexes: IndexDefinition[] = [{ name: "by_age", on: "age" }];
    const plan = planQuery(
      { age: { $gte: 18, $lt: 65 } } as unknown as Predicate<JSONArraylessObject>,
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
    const plan = planQuery(
      { age: { $lt: 100 } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
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

  test("routes numeric $in on indexed field under threshold", () => {
    const indexes: IndexDefinition[] = [{ name: "by_priority", on: "priority" }];
    const plan = planQuery(
      { priority: { $in: [1, 2, 3] } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_priority",
      equalityKeys: [],
      inOn: { field: "priority", values: [1, 2, 3] },
    });
  });

  test("routes mixed numeric + string $in on indexed field", () => {
    const indexes: IndexDefinition[] = [{ name: "by_x", on: "x" }];
    const plan = planQuery(
      { x: { $in: ["a", 1] } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toEqual({
      kind: "index-walk",
      indexName: "by_x",
      equalityKeys: [],
      inOn: { field: "x", values: ["a", 1] },
    });
  });
});

describe("planQuery — filtered index cost bias (T4)", () => {
  test("filtered index whose filter is implied wins over unfiltered alternative", () => {
    const unfiltered: IndexDefinition = { name: "by_assignee", on: "assignee" };
    const filtered: IndexDefinition = {
      name: "open_by_assignee",
      on: "assignee",
      predicate: { status: "open" },
    };
    // Order the unfiltered FIRST in the array so the cost bias is
    // the only path to picking `filtered` — proves the bias overrides
    // definition order.
    const plan = planQuery(
      { status: "open", assignee: "alice" } as unknown as Predicate<JSONArraylessObject>,
      [unfiltered, filtered],
    );
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.indexName).toBe("open_by_assignee");
      expect(plan.equalityKeys).toEqual(["alice"]);
      // The full original predicate stays in `postFilter` — the
      // stale-row defence requires it, even when the filter is
      // implied. (See T4 step e — filter-elimination from postFilter
      // is explicitly out of scope.)
      expect(plan.postFilter).toEqual({ status: "open" });
    }
  });

  test("filtered index whose filter is NOT implied is skipped in favour of unfiltered", () => {
    const unfiltered: IndexDefinition = { name: "by_assignee", on: "assignee" };
    const filtered: IndexDefinition = {
      name: "open_by_assignee",
      on: "assignee",
      predicate: { status: "open" },
    };
    // Query has no `status` clause → filter is NOT implied. The
    // unfiltered index must win even though `filtered` walks at the
    // same equality prefix length.
    const plan = planQuery({ assignee: "alice" } as unknown as Predicate<JSONArraylessObject>, [
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
    const filtered_short: IndexDefinition = {
      name: "open_by_assignee",
      on: "assignee",
      predicate: { status: "open" },
    };
    const filtered_long: IndexDefinition = {
      name: "open_by_assignee_priority",
      on: ["assignee", "priority"],
      predicate: { status: "open" },
    };
    const plan = planQuery(
      {
        status: "open",
        assignee: "alice",
        priority: "p1",
      } as unknown as Predicate<JSONArraylessObject>,
      [filtered_short, filtered_long],
    );
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.indexName).toBe("open_by_assignee_priority");
      expect(plan.equalityKeys).toEqual(["alice", "p1"]);
    }
  });

  test("filtered composite index beats unfiltered single-field for the same query", () => {
    // Critical regression pin: planner must prefer an implied
    // filtered composite over an unfiltered single-field at the
    // same equality prefix length (the composite's larger key set
    // doesn't matter — the filtered prefix is sparse and correct).
    const unfiltered_single: IndexDefinition = { name: "by_assignee", on: "assignee" };
    const filtered_composite: IndexDefinition = {
      name: "open_by_assignee_priority",
      on: ["assignee", "priority"],
      predicate: { status: "open" },
    };
    const plan = planQuery(
      {
        status: "open",
        assignee: "alice",
        priority: "p1",
      } as unknown as Predicate<JSONArraylessObject>,
      [unfiltered_single, filtered_composite],
    );
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.indexName).toBe("open_by_assignee_priority");
    }
  });

  test("range-filtered index preferred when query range is contained", () => {
    const indexes: IndexDefinition[] = [
      { name: "any_age", on: "age" },
      { name: "adults_by_age", on: "age", predicate: { age: { $gte: 18 } } },
    ];
    const plan = planQuery(
      { age: { $gte: 21, $lte: 30 } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toMatchObject({ kind: "index-walk", indexName: "adults_by_age" });
  });

  test("$in-filtered index preferred when query value is in the filter set", () => {
    const indexes: IndexDefinition[] = [
      { name: "any_priority", on: "priority" },
      { name: "p0_p1", on: "priority", predicate: { priority: { $in: ["p0", "p1"] } } },
    ];
    const plan = planQuery(
      { priority: "p1" } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    expect(plan).toMatchObject({ kind: "index-walk", indexName: "p0_p1" });
  });

  test("range-filtered index NOT preferred when query exits the filter", () => {
    const indexes: IndexDefinition[] = [
      { name: "any_age", on: "age" },
      { name: "adults_by_age", on: "age", predicate: { age: { $gte: 18 } } },
    ];
    const plan = planQuery(
      { age: { $gte: 17, $lte: 30 } } as unknown as Predicate<JSONArraylessObject>,
      indexes,
    );
    // Falls back to the unfiltered index — walking adults_by_age would
    // miss age=17.
    expect(plan).toMatchObject({ kind: "index-walk", indexName: "any_age" });
  });
});
