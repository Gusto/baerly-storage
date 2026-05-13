import { describe, expect, test } from "vitest";
import { BaerlyError, type JSONArraylessObject } from "@baerly/protocol";
import { inferPlanForCollection } from "./plan.ts";
import type { ExportRow, SqlTarget } from "./types.ts";
import { translatePredicateToSql } from "./where.ts";

const buildPlan = (
  target: SqlTarget,
  rec: Record<string, JSONArraylessObject>,
  table = "tickets",
) => {
  const rows = new Map<string, ExportRow>();
  for (const [k, v] of Object.entries(rec)) rows.set(k, v);
  return inferPlanForCollection({ rows, target, table });
};

describe("translatePredicateToSql — translation rules (§3)", () => {
  test("§3.8 empty predicate → empty SQL, no hints", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    const r = translatePredicateToSql({}, plan);
    expect(r.sql).toBe("");
    expect(r.hints).toEqual([]);
  });

  test("§3.2 flat-string column equality, postgres", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    const r = translatePredicateToSql({ status: "open" }, plan);
    expect(r.sql).toBe(`"status" = 'open'`);
    expect(r.hints).toEqual([]);
  });

  test("§3.2 flat-boolean column → 'true' / 'false' on postgres, 1 / 0 on sqlite", () => {
    const pg = buildPlan("postgres", { a: { deleted: false } as JSONArraylessObject });
    const sl = buildPlan("sqlite", { a: { deleted: false } as JSONArraylessObject });
    const d1 = buildPlan("d1", { a: { deleted: false } as JSONArraylessObject });
    expect(translatePredicateToSql({ deleted: true }, pg).sql).toBe(`"deleted" = true`);
    expect(translatePredicateToSql({ deleted: false }, pg).sql).toBe(`"deleted" = false`);
    expect(translatePredicateToSql({ deleted: true }, sl).sql).toBe(`"deleted" = 1`);
    expect(translatePredicateToSql({ deleted: true }, d1).sql).toBe(`"deleted" = 1`);
  });

  test("§3.2 flat-integer column", () => {
    const plan = buildPlan("postgres", { a: { priority: 1 } as JSONArraylessObject });
    expect(translatePredicateToSql({ priority: 1 }, plan).sql).toBe(`"priority" = 1`);
  });

  test("§3.7 multi-key top-level → AND-joined", () => {
    const plan = buildPlan("postgres", {
      a: { status: "open", priority: 1 } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ status: "open", priority: 1 }, plan);
    expect(r.sql).toBe(`"status" = 'open' AND "priority" = 1`);
    expect(r.hints).toEqual([]);
  });

  test("§3.5 JSON column, dotted path → postgres ->> operator", () => {
    const plan = buildPlan("postgres", {
      a: { assignee: { team: "platform" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ "assignee.team": "platform" }, plan);
    expect(r.sql).toBe(`"assignee"->>'team' = 'platform'`);
    expect(r.hints).toEqual([]);
  });

  test("§3.5 JSON column, dotted path → sqlite json_extract", () => {
    const plan = buildPlan("sqlite", {
      a: { assignee: { team: "platform" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ "assignee.team": "platform" }, plan);
    expect(r.sql).toBe(`json_extract("assignee", '$.team') = 'platform'`);
  });

  test("§3.5 JSON column, dotted path → d1 json_extract", () => {
    const plan = buildPlan("d1", {
      a: { assignee: { team: "platform" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ "assignee.team": "platform" }, plan);
    expect(r.sql).toBe(`json_extract("assignee", '$.team') = 'platform'`);
  });

  test("§3.4 sub-predicate against JSON column → same shape as dotted path (postgres)", () => {
    const plan = buildPlan("postgres", {
      a: { assignee: { team: "platform" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ assignee: { team: "platform" } }, plan);
    expect(r.sql).toBe(`"assignee"->>'team' = 'platform'`);
  });

  test("§3.4 sub-predicate against JSON column → sqlite json_extract", () => {
    const plan = buildPlan("sqlite", {
      a: { assignee: { team: "platform" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ assignee: { team: "platform" } }, plan);
    expect(r.sql).toBe(`json_extract("assignee", '$.team') = 'platform'`);
  });

  test("§3.4 multi-key sub-predicate → AND-joined json_extract clauses (sqlite)", () => {
    const plan = buildPlan("sqlite", {
      a: { assignee: { team: "platform", oncall: "alice" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ assignee: { team: "platform", oncall: "alice" } }, plan);
    expect(r.sql).toBe(
      `json_extract("assignee", '$.team') = 'platform' AND json_extract("assignee", '$.oncall') = 'alice'`,
    );
  });

  test("§3.4 multi-key sub-predicate → AND-joined ->> clauses (postgres)", () => {
    const plan = buildPlan("postgres", {
      a: { assignee: { team: "platform", oncall: "alice" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ assignee: { team: "platform", oncall: "alice" } }, plan);
    expect(r.sql).toBe(`"assignee"->>'team' = 'platform' AND "assignee"->>'oncall' = 'alice'`);
  });

  test("§3.5 two-level JSON path → -> chains, last seg uses ->> (postgres)", () => {
    const plan = buildPlan("postgres", {
      a: { a: { b: { c: "x" } } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ "a.b.c": "x" }, plan);
    expect(r.sql).toBe(`"a"->'b'->>'c' = 'x'`);
  });

  test("§3.5 two-level JSON path → flat $.a.b.c (sqlite)", () => {
    const plan = buildPlan("sqlite", {
      a: { a: { b: { c: "x" } } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ "a.b.c": "x" }, plan);
    expect(r.sql).toBe(`json_extract("a", '$.b.c') = 'x'`);
  });

  test("§3.3 JSON column, top-level primitive predicate (promoted-column case) → JSON-encoded literal (postgres)", () => {
    // Mixed primitive + nested-object promotes the column to JSON.
    // A top-level primitive predicate against that column compares
    // against the JSON-encoded literal that `rows.ts` writes.
    const plan = buildPlan("postgres", {
      a: { thing: "stringy" } as JSONArraylessObject,
      b: { thing: { nested: "obj" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ thing: "stringy" }, plan);
    expect(r.sql).toBe(`"thing"::text = '"stringy"'`);
  });

  test("§3.3 JSON column, top-level primitive predicate → JSON-encoded literal (sqlite)", () => {
    const plan = buildPlan("sqlite", {
      a: { thing: "stringy" } as JSONArraylessObject,
      b: { thing: { nested: "obj" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ thing: "stringy" }, plan);
    expect(r.sql).toBe(`"thing" = '"stringy"'`);
  });

  test("§3.6 unknown top-level key → 1 = 0 + hint naming the key", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    const r = translatePredicateToSql({ ghost: "x" }, plan);
    expect(r.sql).toBe("1 = 0");
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toContain("ghost");
    expect(r.hints[0]).toContain("never observed");
  });

  test("§3.6 dotted path against flat column → 1 = 0 + hint naming the path", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    const r = translatePredicateToSql({ "status.sub": "x" }, plan);
    expect(r.sql).toBe("1 = 0");
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toContain("status.sub");
    expect(r.hints[0]).toContain("flat column");
  });

  test("§3.6 unknown + matchable key → AND of 1 = 0 with the rest", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    const r = translatePredicateToSql({ status: "open", ghost: "x" }, plan);
    expect(r.sql).toBe(`"status" = 'open' AND 1 = 0`);
    expect(r.hints).toHaveLength(1);
  });

  test("apostrophe in flat string value is doubled", () => {
    const plan = buildPlan("postgres", { a: { note: "x" } as JSONArraylessObject });
    const r = translatePredicateToSql({ note: "O'Brien" }, plan);
    expect(r.sql).toBe(`"note" = 'O''Brien'`);
  });

  test("apostrophe in JSON-path key is doubled (postgres)", () => {
    const plan = buildPlan("postgres", {
      a: { meta: { "tricky'key": "x" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ meta: { "tricky'key": "v" } }, plan);
    expect(r.sql).toBe(`"meta"->>'tricky''key' = 'v'`);
  });

  test("apostrophe in JSON-path key is doubled (sqlite)", () => {
    const plan = buildPlan("sqlite", {
      a: { meta: { "tricky'key": "x" } } as JSONArraylessObject,
    });
    const r = translatePredicateToSql({ meta: { "tricky'key": "v" } }, plan);
    expect(r.sql).toBe(`json_extract("meta", '$.tricky''key') = 'v'`);
  });

  test("predicate validation runs defensively — rejects $-prefixed key", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    expect(() => translatePredicateToSql({ $or: "x" } as never, plan)).toThrow(BaerlyError);
    try {
      translatePredicateToSql({ $or: "x" } as never, plan);
    } catch (e) {
      expect((e as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("predicate validation runs defensively — rejects null value", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    expect(() => translatePredicateToSql({ status: null } as never, plan)).toThrow(BaerlyError);
  });

  test("§4.4 dynamicHint option emits caller-flagged hint", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    const r = translatePredicateToSql({ status: "open" }, plan, {
      dynamicHint: "constructed from filter object",
    });
    expect(r.sql).toBe(`"status" = 'open'`);
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toContain("caller-flagged dynamic predicate");
    expect(r.hints[0]).toContain("constructed from filter object");
  });

  test("§4.4 empty-string dynamicHint is ignored", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    const r = translatePredicateToSql({ status: "open" }, plan, { dynamicHint: "" });
    expect(r.hints).toEqual([]);
  });

  test("multiple unmatchable clauses → one hint each, all 1 = 0", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    const r = translatePredicateToSql({ ghost1: "a", ghost2: "b" }, plan);
    expect(r.sql).toBe("1 = 0 AND 1 = 0");
    expect(r.hints).toHaveLength(2);
    expect(r.hints[0]).toContain("ghost1");
    expect(r.hints[1]).toContain("ghost2");
  });

  test("dynamicHint co-exists with unmatchable-clause hints", () => {
    const plan = buildPlan("postgres", { a: { status: "open" } as JSONArraylessObject });
    const r = translatePredicateToSql({ ghost: "x" }, plan, {
      dynamicHint: "via spread",
    });
    expect(r.sql).toBe("1 = 0");
    expect(r.hints).toHaveLength(2);
    expect(r.hints[0]).toContain("caller-flagged dynamic predicate");
    expect(r.hints[1]).toContain("ghost");
  });
});
