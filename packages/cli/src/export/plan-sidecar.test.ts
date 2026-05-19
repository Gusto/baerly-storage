/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key column name carried in `ColumnPlan.source`. */

/**
 * Unit tests for {@link serializeExportPlan} and
 * {@link deserializeExportPlan}.
 *
 * Property under test: every plan that {@link inferPlanForCollection}
 * produces round-trips through the sidecar serialiser losslessly,
 * modulo `rowCount` (intentionally not preserved) and
 * `tableIdentifier` / per-column `identifier` (re-derived via
 * {@link quoteIdentifier} on deserialise, NOT copied off the wire).
 */

import { describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { deserializeExportPlan, serializeExportPlan } from "./plan-sidecar.ts";
import { inferPlanForCollection } from "./plan.ts";
import type { ExportPlan, ExportRow } from "./types.ts";

const planFromRows = (
  rows: ReadonlyMap<string, ExportRow>,
  table: string,
  target: "sqlite" | "postgres" | "d1",
): ExportPlan => inferPlanForCollection({ rows, table, target });

describe("serializeExportPlan", () => {
  test("emits a pretty-printed JSON object with trailing newline", () => {
    const rows = new Map<string, ExportRow>([
      ["a", { status: "open" }],
      ["b", { status: "closed" }],
    ]);
    const plan = planFromRows(rows, "tickets", "sqlite");
    const text = serializeExportPlan(plan);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"schemaVersion": 1');
    expect(text).toContain('"table": "tickets"');
    expect(text).toContain('"target": "sqlite"');
    expect(text).toContain('"source": "_id"');
  });

  test("omits identifier / tableIdentifier from the wire", () => {
    const rows = new Map<string, ExportRow>([["a", { status: "open" }]]);
    const plan = planFromRows(rows, "tickets", "sqlite");
    const parsed = JSON.parse(serializeExportPlan(plan)) as Record<string, unknown>;
    expect("tableIdentifier" in parsed).toBe(false);
    const columns = parsed["columns"] as Array<Record<string, unknown>>;
    for (const col of columns) {
      expect("identifier" in col).toBe(false);
    }
  });
});

describe("deserializeExportPlan", () => {
  test("round-trips a sqlite plan losslessly (mod rowCount + identifier)", () => {
    const rows = new Map<string, ExportRow>([
      ["a", { status: "open", priority: 1 }],
      ["b", { status: "closed", priority: 2, deleted: true, tags: { primary: "bug" } }],
    ]);
    const plan = planFromRows(rows, "tickets", "sqlite");
    const wire = serializeExportPlan(plan);
    const decoded = deserializeExportPlan(wire);

    expect(decoded.table).toBe(plan.table);
    expect(decoded.target).toBe(plan.target);
    expect(decoded.tableIdentifier).toBe(plan.tableIdentifier);
    // rowCount is intentionally not preserved across the boundary.
    expect(decoded.rowCount).toBe(0);
    expect(decoded.columns.length).toBe(plan.columns.length);
    for (let i = 0; i < plan.columns.length; i++) {
      const a = plan.columns[i]!;
      const b = decoded.columns[i]!;
      expect(b.source).toBe(a.source);
      expect(b.sqlType).toBe(a.sqlType);
      expect(b.nullable).toBe(a.nullable);
      expect(b.jsonEncoded).toBe(a.jsonEncoded);
      expect(b.identifier).toBe(a.identifier);
    }
  });

  test("round-trips a postgres plan losslessly", () => {
    const rows = new Map<string, ExportRow>([
      ["a", { status: "open", count: 7 }],
      ["b", { status: "closed", count: 9, blob: { a: "x" } }],
    ]);
    const plan = planFromRows(rows, "tickets", "postgres");
    const decoded = deserializeExportPlan(serializeExportPlan(plan));
    expect(decoded.columns.map((c) => c.sqlType)).toEqual(plan.columns.map((c) => c.sqlType));
    expect(decoded.target).toBe("postgres");
  });

  test("rejects malformed JSON", () => {
    expect(() => deserializeExportPlan("{not-json}")).toThrow(BaerlyError);
  });

  test("rejects unsupported schemaVersion", () => {
    const text = JSON.stringify({
      schemaVersion: 999,
      table: "t",
      target: "sqlite",
      columns: [],
    });
    expect(() => deserializeExportPlan(text)).toThrow(/schemaVersion/);
  });

  test("rejects unknown target", () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      table: "t",
      target: "oracle",
      columns: [],
    });
    expect(() => deserializeExportPlan(text)).toThrow(/target/);
  });

  test("rejects unknown sqlType", () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      table: "t",
      target: "sqlite",
      columns: [
        {
          source: "foo",
          sqlType: "BLOB",
          nullable: false,
          jsonEncoded: false,
        },
      ],
    });
    expect(() => deserializeExportPlan(text)).toThrow(/sqlType/);
  });

  test("rejects empty / missing column source", () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      table: "t",
      target: "sqlite",
      columns: [{ source: "", sqlType: "TEXT", nullable: false, jsonEncoded: false }],
    });
    expect(() => deserializeExportPlan(text)).toThrow(/source/);
  });
});
