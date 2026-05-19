import { describe, expect, test } from "vitest";
import { BaerlyError, type DocumentData } from "@baerly/protocol";
import { emitCreateTable } from "./ddl.ts";
import { inferPlanForCollection } from "./plan.ts";
import type { ExportRow } from "./types.ts";

const rowsFromRecord = (rec: Record<string, ExportRow>): ReadonlyMap<string, ExportRow> => {
  const m = new Map<string, ExportRow>();
  for (const [k, v] of Object.entries(rec)) {
    m.set(k, v);
  }
  return m;
};

describe("emitCreateTable", () => {
  test("postgres — text + integer + boolean column shape", () => {
    const rows = rowsFromRecord({
      a: { name: "alice", count: 1, active: true } as DocumentData,
      b: { name: "bob", count: 2, active: false } as DocumentData,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "users" });
    const sql = emitCreateTable(plan);
    expect(sql).toBe(
      'CREATE TABLE "users" (\n' +
        '  "_id" text NOT NULL PRIMARY KEY,\n' +
        '  "name" text NOT NULL,\n' +
        '  "count" integer NOT NULL,\n' +
        '  "active" boolean NOT NULL\n' +
        ");\n",
    );
  });

  test("sqlite — uppercase types + INTEGER for booleans", () => {
    const rows = rowsFromRecord({
      a: { name: "alice", count: 1, active: true } as DocumentData,
    });
    const plan = inferPlanForCollection({ rows, target: "sqlite", table: "users" });
    const sql = emitCreateTable(plan);
    expect(sql).toBe(
      'CREATE TABLE "users" (\n' +
        '  "_id" TEXT NOT NULL PRIMARY KEY,\n' +
        '  "name" TEXT NOT NULL,\n' +
        '  "count" INTEGER NOT NULL,\n' +
        '  "active" INTEGER NOT NULL\n' +
        ");\n",
    );
  });

  test("d1 — same shape as sqlite", () => {
    const rows = rowsFromRecord({
      a: { name: "alice" } as DocumentData,
    });
    const plan = inferPlanForCollection({ rows, target: "d1", table: "users" });
    const sql = emitCreateTable(plan);
    expect(sql).toBe(
      'CREATE TABLE "users" (\n' +
        '  "_id" TEXT NOT NULL PRIMARY KEY,\n' +
        '  "name" TEXT NOT NULL\n' +
        ");\n",
    );
  });

  test("nullable column omits NOT NULL", () => {
    const rows = rowsFromRecord({
      a: { name: "alice", nickname: "al" } as DocumentData,
      b: { name: "bob" } as DocumentData,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "users" });
    const sql = emitCreateTable(plan);
    expect(sql).toContain('"nickname" text\n'); // no NOT NULL on this line
    expect(sql).toContain('"name" text NOT NULL,');
  });

  test("_id is always PRIMARY KEY and never nullable", () => {
    const rows = rowsFromRecord({
      a: { name: "alice" } as DocumentData,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "users" });
    const sql = emitCreateTable(plan);
    expect(sql).toContain('"_id" text NOT NULL PRIMARY KEY');
  });

  test("nested-object column emits jsonb on postgres / TEXT on sqlite", () => {
    const rows = rowsFromRecord({
      a: { profile: { city: "sf" } } as DocumentData,
    });
    expect(
      emitCreateTable(inferPlanForCollection({ rows, target: "postgres", table: "u" })),
    ).toContain('"profile" jsonb NOT NULL');
    expect(
      emitCreateTable(inferPlanForCollection({ rows, target: "sqlite", table: "u" })),
    ).toContain('"profile" TEXT NOT NULL');
  });

  test("empty plan — no observed columns at all is impossible because _id is always first; but missing _id triggers the error", () => {
    // The way to trigger zero columns is to hand-craft a plan with an
    // empty columns array. This codepath exists because the
    // dependency is purely on `plan.columns.length`, not on whether
    // `inferPlanForCollection` could produce it.
    const plan = {
      target: "postgres" as const,
      table: "empty",
      tableIdentifier: '"empty"',
      columns: [],
      rowCount: 0,
    };
    expect(() => emitCreateTable(plan)).toThrow(BaerlyError);
    try {
      emitCreateTable(plan);
    } catch (error) {
      expect((error as BaerlyError).code).toBe("SchemaError");
    }
  });

  test("d1 — reserves the sqlite_ table-name prefix", () => {
    const rows = rowsFromRecord({
      a: { name: "alice" } as DocumentData,
    });
    const plan = inferPlanForCollection({ rows, target: "d1", table: "sqlite_master" });
    expect(() => emitCreateTable(plan)).toThrow(BaerlyError);
    try {
      emitCreateTable(plan);
    } catch (error) {
      expect((error as BaerlyError).code).toBe("SchemaError");
    }
  });

  test("d1 — rejects sqlite_ prefix case-insensitively", () => {
    const rows = rowsFromRecord({
      a: { name: "alice" } as DocumentData,
    });
    const plan = inferPlanForCollection({ rows, target: "d1", table: "SQLite_meta" });
    expect(() => emitCreateTable(plan)).toThrow(BaerlyError);
  });

  test("sqlite — sqlite_ table name is allowed (only D1 rejects)", () => {
    const rows = rowsFromRecord({
      a: { name: "alice" } as DocumentData,
    });
    const plan = inferPlanForCollection({ rows, target: "sqlite", table: "sqlite_my_stats" });
    expect(() => emitCreateTable(plan)).not.toThrow();
  });
});
