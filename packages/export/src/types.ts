import type { JSONArraylessObject } from "@baerly/protocol";

/**
 * Supported SQL targets for `baerly export`. Each target gets its own
 * per-column type pick (see {@link SqlType}) and value-quoting rules
 * (see `sql-escape.ts`).
 */
export type SqlTarget = "postgres" | "sqlite" | "d1";

/**
 * SQL type for one column. The string IS the wire SQL type — it's
 * literally what the DDL emits. Per-target distinctness is the
 * point; do NOT collapse "text" and "TEXT" into a single label.
 */
export type SqlType =
  | "text" // postgres
  | "boolean" // postgres
  | "integer" // postgres + sqlite + d1 (uppercase variant below)
  | "double precision" // postgres
  | "jsonb" // postgres
  | "TEXT" // sqlite + d1
  | "INTEGER" // sqlite + d1 (also for booleans → 0/1)
  | "REAL"; // sqlite + d1

export interface ColumnPlan {
  /** Field name as it appears on the doc body. */
  readonly source: string;
  /** Quoted identifier in the target dialect — emitted verbatim. */
  readonly identifier: string;
  readonly sqlType: SqlType;
  /** `true` when at least one observed row had the field absent. */
  readonly nullable: boolean;
  /**
   * `true` when the column was promoted to JSON because of mixed
   * primitive-and-object values. JSON-encode the row value on
   * insert (otherwise we'd quote a string-shaped `[object Object]`
   * — wrong). The `rows.ts` writer reads this flag.
   */
  readonly jsonEncoded: boolean;
}

export interface ExportPlan {
  readonly target: SqlTarget;
  readonly table: string;
  /** Quoted identifier in the target dialect — emitted verbatim. */
  readonly tableIdentifier: string;
  /** Stable, deterministic column order. `_id` is always first. */
  readonly columns: readonly ColumnPlan[];
  /**
   * Total rows scanned to build the plan. Surfaced for operator
   * logs ("inferred over N rows"); not on the wire.
   */
  readonly rowCount: number;
}

/**
 * One materialised row from the L9 snapshot fold. Matches the shape
 * of `JSONArraylessObject` from `@baerly/protocol`: every value is
 * `string | number | boolean | JSONArraylessObject`.
 *
 * Note: `_id` is not part of the body — it's the map key. The
 * exporter assembles the SQL row by reading the map key into the
 * `_id` column and the body keys into the remaining columns.
 */
export type ExportRow = JSONArraylessObject;
