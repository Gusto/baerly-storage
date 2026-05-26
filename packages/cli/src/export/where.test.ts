import { describe, expect, test } from "vitest";
import {
  BaerlyError,
  type DocumentData,
  type DocumentValue,
  type PredicateClause,
  type PredicateWire,
} from "@baerly/protocol";
import { inferPlanForCollection } from "./plan.ts";
import type { ExportRow, SqlTarget } from "./types.ts";
import { translatePredicateWireToSql } from "./where.ts";

const buildPlan = (
  target: SqlTarget,
  rec: Record<string, DocumentData>,
  table = "tickets",
) => {
  const rows = new Map<string, ExportRow>();
  for (const [k, v] of Object.entries(rec)) {
    rows.set(k, v);
  }
  return inferPlanForCollection({ rows, target, table });
};

const wire = (clauses: PredicateClause[]): PredicateWire => ({ clauses });
const eq = (field: string, value: DocumentValue): PredicateClause => ({
  op: "eq",
  field,
  value,
});

describe("translatePredicateWireToSql — translation rules (§3)", () => {
  test("§3.8 empty wire → empty SQL, no hints", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    const r = translatePredicateWireToSql(wire([]), plan);
    expect(r.sql).toBe("");
    expect(r.hints).toEqual([]);
  });

  test("§3.2 flat-string column equality, postgres", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    const r = translatePredicateWireToSql(wire([eq("status", "open")]), plan);
    expect(r.sql).toBe(`"status" = 'open'`);
    expect(r.hints).toEqual([]);
  });

  test("§3.2 flat-boolean column → 'true' / 'false' on postgres, 1 / 0 on sqlite", () => {
    const pg = buildPlan("postgres", { a: { deleted: false } as DocumentData });
    const sl = buildPlan("sqlite", { a: { deleted: false } as DocumentData });
    const d1 = buildPlan("d1", { a: { deleted: false } as DocumentData });
    expect(translatePredicateWireToSql(wire([eq("deleted", true)]), pg).sql).toBe(
      `"deleted" = true`,
    );
    expect(translatePredicateWireToSql(wire([eq("deleted", false)]), pg).sql).toBe(
      `"deleted" = false`,
    );
    expect(translatePredicateWireToSql(wire([eq("deleted", true)]), sl).sql).toBe(
      `"deleted" = 1`,
    );
    expect(translatePredicateWireToSql(wire([eq("deleted", true)]), d1).sql).toBe(
      `"deleted" = 1`,
    );
  });

  test("§3.2 flat-integer column", () => {
    const plan = buildPlan("postgres", { a: { priority: 1 } as DocumentData });
    expect(translatePredicateWireToSql(wire([eq("priority", 1)]), plan).sql).toBe(
      `"priority" = 1`,
    );
  });

  test("§3.7 multi-clause top-level → AND-joined", () => {
    const plan = buildPlan("postgres", {
      a: { status: "open", priority: 1 } as DocumentData,
    });
    const r = translatePredicateWireToSql(wire([eq("status", "open"), eq("priority", 1)]), plan);
    expect(r.sql).toBe(`"status" = 'open' AND "priority" = 1`);
    expect(r.hints).toEqual([]);
  });

  test("§3.5 JSON column, dotted path → postgres ->> operator", () => {
    const plan = buildPlan("postgres", {
      a: { assignee: { team: "platform" } } as DocumentData,
    });
    const r = translatePredicateWireToSql(wire([eq("assignee.team", "platform")]), plan);
    expect(r.sql).toBe(`"assignee"->>'team' = 'platform'`);
    expect(r.hints).toEqual([]);
  });

  test("§3.5 JSON column, dotted path → sqlite json_extract", () => {
    const plan = buildPlan("sqlite", {
      a: { assignee: { team: "platform" } } as DocumentData,
    });
    const r = translatePredicateWireToSql(wire([eq("assignee.team", "platform")]), plan);
    expect(r.sql).toBe(`json_extract("assignee", '$.team') = 'platform'`);
  });

  test("§3.5 JSON column, dotted path → d1 json_extract", () => {
    const plan = buildPlan("d1", {
      a: { assignee: { team: "platform" } } as DocumentData,
    });
    const r = translatePredicateWireToSql(wire([eq("assignee.team", "platform")]), plan);
    expect(r.sql).toBe(`json_extract("assignee", '$.team') = 'platform'`);
  });

  test("§3.4 flattened-multi-key sub-predicate → AND-joined json_extract (sqlite)", () => {
    // The normaliser flattens `{assignee: {team, oncall}}` to two
    // dotted-path eq clauses; the translator emits one json_extract
    // per clause.
    const plan = buildPlan("sqlite", {
      a: { assignee: { team: "platform", oncall: "alice" } } as DocumentData,
    });
    const r = translatePredicateWireToSql(
      wire([eq("assignee.team", "platform"), eq("assignee.oncall", "alice")]),
      plan,
    );
    expect(r.sql).toBe(
      `json_extract("assignee", '$.team') = 'platform' AND json_extract("assignee", '$.oncall') = 'alice'`,
    );
  });

  test("§3.4 flattened-multi-key sub-predicate → AND-joined ->> clauses (postgres)", () => {
    const plan = buildPlan("postgres", {
      a: { assignee: { team: "platform", oncall: "alice" } } as DocumentData,
    });
    const r = translatePredicateWireToSql(
      wire([eq("assignee.team", "platform"), eq("assignee.oncall", "alice")]),
      plan,
    );
    expect(r.sql).toBe(`"assignee"->>'team' = 'platform' AND "assignee"->>'oncall' = 'alice'`);
  });

  test("§3.5 two-level JSON path → -> chains, last seg uses ->> (postgres)", () => {
    const plan = buildPlan("postgres", {
      a: { a: { b: { c: "x" } } } as DocumentData,
    });
    const r = translatePredicateWireToSql(wire([eq("a.b.c", "x")]), plan);
    expect(r.sql).toBe(`"a"->'b'->>'c' = 'x'`);
  });

  test("§3.5 two-level JSON path → flat $.a.b.c (sqlite)", () => {
    const plan = buildPlan("sqlite", {
      a: { a: { b: { c: "x" } } } as DocumentData,
    });
    const r = translatePredicateWireToSql(wire([eq("a.b.c", "x")]), plan);
    expect(r.sql).toBe(`json_extract("a", '$.b.c') = 'x'`);
  });

  test("§3.3 JSON column, top-level primitive predicate → JSON-encoded literal (postgres)", () => {
    // Mixed primitive + nested-object promotes the column to JSON.
    // A top-level primitive predicate against that column compares
    // against the JSON-encoded literal that `rows.ts` writes.
    const plan = buildPlan("postgres", {
      a: { thing: "stringy" } as DocumentData,
      b: { thing: { nested: "obj" } } as DocumentData,
    });
    const r = translatePredicateWireToSql(wire([eq("thing", "stringy")]), plan);
    expect(r.sql).toBe(`"thing"::text = '"stringy"'`);
  });

  test("§3.3 JSON column, top-level primitive predicate → JSON-encoded literal (sqlite)", () => {
    const plan = buildPlan("sqlite", {
      a: { thing: "stringy" } as DocumentData,
      b: { thing: { nested: "obj" } } as DocumentData,
    });
    const r = translatePredicateWireToSql(wire([eq("thing", "stringy")]), plan);
    expect(r.sql).toBe(`"thing" = '"stringy"'`);
  });

  test("§3.6 unknown top-level key → 1 = 0 + hint naming the key", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    const r = translatePredicateWireToSql(wire([eq("ghost", "x")]), plan);
    expect(r.sql).toBe("1 = 0");
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toContain("ghost");
    expect(r.hints[0]).toContain("never observed");
  });

  test("§3.6 dotted path against flat column → 1 = 0 + hint naming the path", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    const r = translatePredicateWireToSql(wire([eq("status.sub", "x")]), plan);
    expect(r.sql).toBe("1 = 0");
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toContain("status.sub");
    expect(r.hints[0]).toContain("flat column");
  });

  test("§3.6 unknown + matchable key → AND of 1 = 0 with the rest", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    const r = translatePredicateWireToSql(wire([eq("status", "open"), eq("ghost", "x")]), plan);
    expect(r.sql).toBe(`"status" = 'open' AND 1 = 0`);
    expect(r.hints).toHaveLength(1);
  });

  test("apostrophe in flat string value is doubled", () => {
    const plan = buildPlan("postgres", { a: { note: "x" } as DocumentData });
    const r = translatePredicateWireToSql(wire([eq("note", "O'Brien")]), plan);
    expect(r.sql).toBe(`"note" = 'O''Brien'`);
  });

  test("apostrophe in JSON-path key is doubled (postgres)", () => {
    const plan = buildPlan("postgres", {
      a: { meta: { "tricky'key": "x" } } as DocumentData,
    });
    const r = translatePredicateWireToSql(wire([eq("meta.tricky'key", "v")]), plan);
    expect(r.sql).toBe(`"meta"->>'tricky''key' = 'v'`);
  });

  test("apostrophe in JSON-path key is doubled (sqlite)", () => {
    const plan = buildPlan("sqlite", {
      a: { meta: { "tricky'key": "x" } } as DocumentData,
    });
    const r = translatePredicateWireToSql(wire([eq("meta.tricky'key", "v")]), plan);
    expect(r.sql).toBe(`json_extract("meta", '$.tricky''key') = 'v'`);
  });

  test("predicate validation runs defensively — rejects top-level _id on the wire", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    expect(() => translatePredicateWireToSql(wire([eq("_id", "x")]), plan)).toThrow(BaerlyError);
    try {
      translatePredicateWireToSql(wire([eq("_id", "x")]), plan);
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("predicate validation runs defensively — rejects null value on a clause", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    expect(() =>
      translatePredicateWireToSql(
        wire([{ op: "eq", field: "status", value: null as unknown as string }]),
        plan,
      ),
    ).toThrow(BaerlyError);
  });

  test("§4.4 dynamicHint option emits caller-flagged hint", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    const r = translatePredicateWireToSql(wire([eq("status", "open")]), plan, {
      dynamicHint: "constructed from filter object",
    });
    expect(r.sql).toBe(`"status" = 'open'`);
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toContain("caller-flagged dynamic predicate");
    expect(r.hints[0]).toContain("constructed from filter object");
  });

  test("§4.4 empty-string dynamicHint is ignored", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    const r = translatePredicateWireToSql(wire([eq("status", "open")]), plan, {
      dynamicHint: "",
    });
    expect(r.hints).toEqual([]);
  });

  test("multiple unmatchable clauses → one hint each, all 1 = 0", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    const r = translatePredicateWireToSql(wire([eq("ghost1", "a"), eq("ghost2", "b")]), plan);
    expect(r.sql).toBe("1 = 0 AND 1 = 0");
    expect(r.hints).toHaveLength(2);
    expect(r.hints[0]).toContain("ghost1");
    expect(r.hints[1]).toContain("ghost2");
  });

  test("dynamicHint co-exists with unmatchable-clause hints", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    const r = translatePredicateWireToSql(wire([eq("ghost", "x")]), plan, {
      dynamicHint: "via spread",
    });
    expect(r.sql).toBe("1 = 0");
    expect(r.hints).toHaveLength(2);
    expect(r.hints[0]).toContain("caller-flagged dynamic predicate");
    expect(r.hints[1]).toContain("ghost");
  });
});

describe("translatePredicateWireToSql — operator vocabulary", () => {
  test("flat-column range clauses emit direct comparators", () => {
    const plan = buildPlan("postgres", { a: { priority: 5 } as DocumentData });
    expect(
      translatePredicateWireToSql(wire([{ op: "gt", field: "priority", value: 5 }]), plan).sql,
    ).toBe(`"priority" > 5`);
    expect(
      translatePredicateWireToSql(wire([{ op: "gte", field: "priority", value: 5 }]), plan).sql,
    ).toBe(`"priority" >= 5`);
    expect(
      translatePredicateWireToSql(wire([{ op: "lt", field: "priority", value: 5 }]), plan).sql,
    ).toBe(`"priority" < 5`);
    expect(
      translatePredicateWireToSql(wire([{ op: "lte", field: "priority", value: 5 }]), plan).sql,
    ).toBe(`"priority" <= 5`);
  });

  test("flat-column in clause emits SQL IN (...)", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as DocumentData });
    expect(
      translatePredicateWireToSql(
        wire([{ op: "in", field: "status", value: ["open", "pending"] }]),
        plan,
      ).sql,
    ).toBe(`"status" IN ('open', 'pending')`);
  });

  test("JSON-path range and in clauses use the json accessor", () => {
    const plan = buildPlan("postgres", {
      a: { meta: { count: 7 } } as DocumentData,
    });
    expect(
      translatePredicateWireToSql(wire([{ op: "gte", field: "meta.count", value: 5 }]), plan).sql,
    ).toBe(`"meta"->>'count' >= 5`);
    expect(
      translatePredicateWireToSql(
        wire([{ op: "in", field: "meta.count", value: [1, 2, 3] }]),
        plan,
      ).sql,
    ).toBe(`"meta"->>'count' IN (1, 2, 3)`);
  });

  test("AND across mixed operator clauses", () => {
    const plan = buildPlan("postgres", {
      a: { status: "open", priority: 5 } as DocumentData,
    });
    const r = translatePredicateWireToSql(
      wire([
        eq("status", "open"),
        { op: "gte", field: "priority", value: 1 },
        { op: "lt", field: "priority", value: 10 },
      ]),
      plan,
    );
    expect(r.sql).toBe(`"status" = 'open' AND "priority" >= 1 AND "priority" < 10`);
  });

  test("range on a JSON-encoded root column falls back to lex compare on the JSON text", () => {
    // Mixed primitive + nested-object promotes the column to JSON.
    const plan = buildPlan("postgres", {
      a: { thing: "stringy" } as DocumentData,
      b: { thing: { nested: "obj" } } as DocumentData,
    });
    expect(
      translatePredicateWireToSql(wire([{ op: "gt", field: "thing", value: "a" }]), plan).sql,
    ).toBe(`"thing"::text > '"a"'`);
  });

  test("in on a JSON-encoded root column quotes each value as a JSON literal", () => {
    const plan = buildPlan("postgres", {
      a: { thing: "stringy" } as DocumentData,
      b: { thing: { nested: "obj" } } as DocumentData,
    });
    expect(
      translatePredicateWireToSql(
        wire([{ op: "in", field: "thing", value: ["a", "b"] }]),
        plan,
      ).sql,
    ).toBe(`"thing"::text IN ('"a"', '"b"')`);
  });
});
