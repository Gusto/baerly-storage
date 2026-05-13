import { describe, expect, test } from "vitest";
import { BaerlyError, type JSONArraylessObject } from "@baerly/protocol";
import { inferPlanForCollection } from "./plan.ts";
import type { ExportRow } from "./types.ts";

const rowsFromRecord = (rec: Record<string, ExportRow>): ReadonlyMap<string, ExportRow> => {
  const m = new Map<string, ExportRow>();
  for (const [k, v] of Object.entries(rec)) m.set(k, v);
  return m;
};

describe("inferPlanForCollection — per-column type inference (§3 table)", () => {
  test("only-string column → text on postgres, TEXT on sqlite/d1", () => {
    const rows = rowsFromRecord({
      a: { name: "alice" } as JSONArraylessObject,
      b: { name: "bob" } as JSONArraylessObject,
    });
    expect(
      inferPlanForCollection({ rows, target: "postgres", table: "users" }).columns.find(
        (c) => c.source === "name",
      )?.sqlType,
    ).toBe("text");
    expect(
      inferPlanForCollection({ rows, target: "sqlite", table: "users" }).columns.find(
        (c) => c.source === "name",
      )?.sqlType,
    ).toBe("TEXT");
    expect(
      inferPlanForCollection({ rows, target: "d1", table: "users" }).columns.find(
        (c) => c.source === "name",
      )?.sqlType,
    ).toBe("TEXT");
  });

  test("only-boolean column → boolean on postgres, INTEGER on sqlite/d1", () => {
    const rows = rowsFromRecord({
      a: { active: true } as JSONArraylessObject,
      b: { active: false } as JSONArraylessObject,
    });
    expect(
      inferPlanForCollection({ rows, target: "postgres", table: "t" }).columns.find(
        (c) => c.source === "active",
      )?.sqlType,
    ).toBe("boolean");
    expect(
      inferPlanForCollection({ rows, target: "sqlite", table: "t" }).columns.find(
        (c) => c.source === "active",
      )?.sqlType,
    ).toBe("INTEGER");
    expect(
      inferPlanForCollection({ rows, target: "d1", table: "t" }).columns.find(
        (c) => c.source === "active",
      )?.sqlType,
    ).toBe("INTEGER");
  });

  test("only-integer column (fits int32) → integer / INTEGER", () => {
    const rows = rowsFromRecord({
      a: { count: 1 } as JSONArraylessObject,
      b: { count: 100 } as JSONArraylessObject,
    });
    expect(
      inferPlanForCollection({ rows, target: "postgres", table: "t" }).columns.find(
        (c) => c.source === "count",
      )?.sqlType,
    ).toBe("integer");
    expect(
      inferPlanForCollection({ rows, target: "sqlite", table: "t" }).columns.find(
        (c) => c.source === "count",
      )?.sqlType,
    ).toBe("INTEGER");
  });

  test("non-integer number → double precision on postgres, REAL on sqlite/d1", () => {
    const rows = rowsFromRecord({
      a: { ratio: 1.5 } as JSONArraylessObject,
      b: { ratio: 2.0 } as JSONArraylessObject,
    });
    expect(
      inferPlanForCollection({ rows, target: "postgres", table: "t" }).columns.find(
        (c) => c.source === "ratio",
      )?.sqlType,
    ).toBe("double precision");
    expect(
      inferPlanForCollection({ rows, target: "sqlite", table: "t" }).columns.find(
        (c) => c.source === "ratio",
      )?.sqlType,
    ).toBe("REAL");
  });

  test("integer overflow (> int32) → double precision / REAL", () => {
    const rows = rowsFromRecord({
      a: { big: 3_000_000_000 } as JSONArraylessObject,
    });
    expect(
      inferPlanForCollection({ rows, target: "postgres", table: "t" }).columns.find(
        (c) => c.source === "big",
      )?.sqlType,
    ).toBe("double precision");
    expect(
      inferPlanForCollection({ rows, target: "sqlite", table: "t" }).columns.find(
        (c) => c.source === "big",
      )?.sqlType,
    ).toBe("REAL");
  });

  test("only nested-object → jsonb on postgres, TEXT on sqlite/d1 with jsonEncoded", () => {
    const rows = rowsFromRecord({
      a: { profile: { city: "sf" } } as JSONArraylessObject,
      b: { profile: { city: "ny" } } as JSONArraylessObject,
    });
    const pg = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    const sl = inferPlanForCollection({ rows, target: "sqlite", table: "t" });
    const d1 = inferPlanForCollection({ rows, target: "d1", table: "t" });
    const pgCol = pg.columns.find((c) => c.source === "profile");
    expect(pgCol?.sqlType).toBe("jsonb");
    expect(pgCol?.jsonEncoded).toBe(true);
    expect(sl.columns.find((c) => c.source === "profile")?.sqlType).toBe("TEXT");
    expect(sl.columns.find((c) => c.source === "profile")?.jsonEncoded).toBe(true);
    expect(d1.columns.find((c) => c.source === "profile")?.sqlType).toBe("TEXT");
    expect(d1.columns.find((c) => c.source === "profile")?.jsonEncoded).toBe(true);
  });

  test("mixed primitives (string + number) → text / TEXT, not JSON-encoded", () => {
    const rows = rowsFromRecord({
      a: { val: "hello" } as JSONArraylessObject,
      b: { val: 42 } as JSONArraylessObject,
    });
    const pg = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    const sl = inferPlanForCollection({ rows, target: "sqlite", table: "t" });
    expect(pg.columns.find((c) => c.source === "val")?.sqlType).toBe("text");
    expect(pg.columns.find((c) => c.source === "val")?.jsonEncoded).toBe(false);
    expect(sl.columns.find((c) => c.source === "val")?.sqlType).toBe("TEXT");
  });

  test("primitive + nested-object → jsonb / TEXT with jsonEncoded", () => {
    const rows = rowsFromRecord({
      a: { thing: "string-form" } as JSONArraylessObject,
      b: { thing: { nested: "obj" } } as JSONArraylessObject,
    });
    const pg = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    const sl = inferPlanForCollection({ rows, target: "sqlite", table: "t" });
    expect(pg.columns.find((c) => c.source === "thing")?.sqlType).toBe("jsonb");
    expect(pg.columns.find((c) => c.source === "thing")?.jsonEncoded).toBe(true);
    expect(sl.columns.find((c) => c.source === "thing")?.sqlType).toBe("TEXT");
    expect(sl.columns.find((c) => c.source === "thing")?.jsonEncoded).toBe(true);
  });

  test("absent on some rows → nullable: true", () => {
    const rows = rowsFromRecord({
      a: { name: "alice", nickname: "al" } as JSONArraylessObject,
      b: { name: "bob" } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    expect(plan.columns.find((c) => c.source === "nickname")?.nullable).toBe(true);
    expect(plan.columns.find((c) => c.source === "name")?.nullable).toBe(false);
  });

  test("field first observed on the last row → still nullable when earlier rows lacked it", () => {
    // Regression: the back-fill that marks a column nullable used to
    // only fire when a row after the first-appearance row was missing
    // the field. A column that debuted on the FINAL row of the map
    // therefore never got its retroactive nullable upgrade, and the
    // emitted DDL was `col TYPE NOT NULL`. Earlier rows then failed
    // SQLite's NOT NULL check on INSERT. Fix is a post-pass that
    // compares each column's observed-row count against the total
    // row count.
    const rows = rowsFromRecord({
      a: { name: "alice" } as JSONArraylessObject,
      b: { name: "bob" } as JSONArraylessObject,
      c: { name: "carol", deleted: true } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "sqlite", table: "t" });
    expect(plan.columns.find((c) => c.source === "deleted")?.nullable).toBe(true);
    expect(plan.columns.find((c) => c.source === "name")?.nullable).toBe(false);
  });

  test("present on every row → nullable: false", () => {
    const rows = rowsFromRecord({
      a: { name: "alice" } as JSONArraylessObject,
      b: { name: "bob" } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    expect(plan.columns.find((c) => c.source === "name")?.nullable).toBe(false);
  });

  test("_id is always first and never nullable", () => {
    const rows = rowsFromRecord({
      a: { name: "alice" } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    expect(plan.columns[0]?.source).toBe("_id");
    expect(plan.columns[0]?.nullable).toBe(false);
  });

  test("empty input → only _id column", () => {
    const rows = rowsFromRecord({});
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    expect(plan.columns).toHaveLength(1);
    expect(plan.columns[0]?.source).toBe("_id");
    expect(plan.rowCount).toBe(0);
  });

  test("stable column order across runs with same input", () => {
    const rows = rowsFromRecord({
      a: { gamma: "g", alpha: "a", beta: "b" } as JSONArraylessObject,
      b: { alpha: "a2" } as JSONArraylessObject,
    });
    const p1 = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    const p2 = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    expect(p1.columns.map((c) => c.source)).toEqual(p2.columns.map((c) => c.source));
    // First-appearance: gamma, alpha, beta (after _id).
    expect(p1.columns.map((c) => c.source)).toEqual(["_id", "gamma", "alpha", "beta"]);
  });

  test("rowCount equals input map size", () => {
    const rows = rowsFromRecord({
      a: {} as JSONArraylessObject,
      b: {} as JSONArraylessObject,
      c: {} as JSONArraylessObject,
    });
    expect(inferPlanForCollection({ rows, target: "postgres", table: "t" }).rowCount).toBe(3);
  });

  test("rejects malformed body (defensive guard)", () => {
    const bad = new Map<string, ExportRow>();
    bad.set("a", null as unknown as ExportRow);
    expect(() => inferPlanForCollection({ rows: bad, target: "postgres", table: "t" })).toThrow(
      BaerlyError,
    );
    try {
      inferPlanForCollection({ rows: bad, target: "postgres", table: "t" });
    } catch (e) {
      expect((e as BaerlyError).code).toBe("SchemaError");
    }
  });
});
