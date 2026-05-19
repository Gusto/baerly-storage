import { BaerlyError } from "@baerly/protocol";
import type { ExportPlan } from "./types.ts";

/**
 * Emit a `CREATE TABLE` statement for the plan, one line per column,
 * terminated with a semicolon + newline so the output is directly
 * pipeable into `psql` / `sqlite3` / `wrangler d1 execute`.
 *
 * `_id` is the primary key (always first in `plan.columns`).
 *
 * D1 today is sqlite-flavoured: same DDL as `target=sqlite` with a
 * single difference — D1 disallows table names starting with
 * `sqlite_`. We refuse them up front.
 */
export const emitCreateTable = (plan: ExportPlan): string => {
  if (plan.columns.length === 0) {
    throw new BaerlyError(
      "SchemaError",
      `emitCreateTable: collection ${JSON.stringify(plan.table)} has no observed columns — empty snapshot?`,
    );
  }
  if (plan.target === "d1" && plan.table.toLowerCase().startsWith("sqlite_")) {
    throw new BaerlyError(
      "SchemaError",
      `emitCreateTable: D1 reserves the sqlite_ table-name prefix (got ${JSON.stringify(plan.table)})`,
    );
  }
  const lines: string[] = [];
  lines.push(`CREATE TABLE ${plan.tableIdentifier} (`);
  const colLines: string[] = [];
  for (const col of plan.columns) {
    const nullClause = col.nullable ? "" : " NOT NULL";
    const pkClause = col.source === "_id" ? " PRIMARY KEY" : "";
    colLines.push(`  ${col.identifier} ${col.sqlType}${nullClause}${pkClause}`);
  }
  lines.push(colLines.join(",\n"));
  lines.push(");");
  return lines.join("\n") + "\n";
};
