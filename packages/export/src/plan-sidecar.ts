/**
 * Sidecar plan serialisation for `baerly export`.
 *
 * `baerly export --output=foo.sql` writes the inferred {@link ExportPlan}
 * alongside the SQL dump as `foo.sql.plan.json`. The round-trip test
 * (`tests/integration/export-round-trip.test.ts`) consumes the sidecar
 * to coerce SQLite-returned values back to their original JS type
 * (e.g. SQLite stores booleans as 0/1; we restore `true`/`false`).
 *
 * Wire shape (`schemaVersion = 1`):
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "table": "tickets",
 *   "target": "sqlite",
 *   "columns": [
 *     { "source": "_id", "sqlType": "TEXT", "nullable": false, "jsonEncoded": false },
 *     ...
 *   ]
 * }
 * ```
 *
 * `identifier` is NOT carried on the wire — we re-derive it via
 * {@link quoteIdentifier} on deserialise. An attacker writing the
 * sidecar should not get SQL-emit control over identifiers.
 *
 * `rowCount` is also not preserved across the sidecar boundary; the
 * deserialised plan reports `0`. This is intentional — consumers that
 * care about row count read the SQL stream itself.
 */

import { BaerlyError } from "@baerly/protocol";
import { quoteIdentifier } from "./sql-escape.ts";
import type { ColumnPlan, ExportPlan, SqlTarget, SqlType } from "./types.ts";

const SIDECAR_SCHEMA_VERSION = 1 as const;

const VALID_TARGETS: ReadonlySet<string> = new Set(["postgres", "sqlite", "d1"]);

const VALID_SQL_TYPES: ReadonlySet<string> = new Set([
  "text",
  "boolean",
  "integer",
  "double precision",
  "jsonb",
  "TEXT",
  "INTEGER",
  "REAL",
]);

/**
 * Encode an {@link ExportPlan} as the canonical sidecar JSON string.
 *
 * Wire format is pretty-printed (`indent=2`) with a trailing newline
 * so `cat sidecar.plan.json` is human-readable and `diff` works on
 * two sidecars without spurious line-end noise. The on-wire bytes
 * embed the `schemaVersion` discriminator so future shape changes
 * are detectable; `identifier` and `tableIdentifier` are NOT carried
 * (they're re-derived via {@link quoteIdentifier} on deserialise).
 */
export const serializeExportPlan = (plan: ExportPlan): string => {
  return (
    JSON.stringify(
      {
        schemaVersion: SIDECAR_SCHEMA_VERSION,
        table: plan.table,
        target: plan.target,
        columns: plan.columns.map((c) => ({
          source: c.source,
          sqlType: c.sqlType,
          nullable: c.nullable,
          jsonEncoded: c.jsonEncoded,
        })),
      },
      null,
      2,
    ) + "\n"
  );
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Parse the sidecar JSON string back into an {@link ExportPlan}.
 *
 * @throws BaerlyError code="InvalidConfig" when the sidecar JSON is
 *   malformed, the schema version is unsupported, or any required
 *   field is missing / has an unexpected type. Identifiers are
 *   re-quoted via {@link quoteIdentifier} rather than copied off the
 *   wire — the sidecar cannot smuggle SQL-injection via a
 *   pre-quoted identifier.
 */
export const deserializeExportPlan = (text: string): ExportPlan => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new BaerlyError(
      "InvalidConfig",
      `deserializeExportPlan: parse failed: ${(e as Error).message}`,
    );
  }
  if (!isObject(raw)) {
    throw new BaerlyError(
      "InvalidConfig",
      "deserializeExportPlan: top-level value is not an object",
    );
  }
  if (raw.schemaVersion !== SIDECAR_SCHEMA_VERSION) {
    throw new BaerlyError(
      "InvalidConfig",
      `deserializeExportPlan: unsupported schemaVersion ${String(raw.schemaVersion)} (expected ${String(SIDECAR_SCHEMA_VERSION)})`,
    );
  }
  if (typeof raw.table !== "string" || raw.table.length === 0) {
    throw new BaerlyError("InvalidConfig", "deserializeExportPlan: missing or empty table");
  }
  if (typeof raw.target !== "string" || !VALID_TARGETS.has(raw.target)) {
    throw new BaerlyError(
      "InvalidConfig",
      `deserializeExportPlan: unknown target ${JSON.stringify(raw.target)}`,
    );
  }
  if (!Array.isArray(raw.columns)) {
    throw new BaerlyError("InvalidConfig", "deserializeExportPlan: columns is not an array");
  }
  const table = raw.table;
  const target = raw.target as SqlTarget;
  const columns: ColumnPlan[] = [];
  for (const [i, col] of raw.columns.entries()) {
    if (!isObject(col)) {
      throw new BaerlyError(
        "InvalidConfig",
        `deserializeExportPlan: columns[${i}] is not an object`,
      );
    }
    if (typeof col.source !== "string" || col.source.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        `deserializeExportPlan: columns[${i}].source is missing or empty`,
      );
    }
    if (typeof col.sqlType !== "string" || !VALID_SQL_TYPES.has(col.sqlType)) {
      throw new BaerlyError(
        "InvalidConfig",
        `deserializeExportPlan: columns[${i}].sqlType ${JSON.stringify(col.sqlType)} is not a recognised SqlType`,
      );
    }
    if (typeof col.nullable !== "boolean") {
      throw new BaerlyError(
        "InvalidConfig",
        `deserializeExportPlan: columns[${i}].nullable is not a boolean`,
      );
    }
    if (typeof col.jsonEncoded !== "boolean") {
      throw new BaerlyError(
        "InvalidConfig",
        `deserializeExportPlan: columns[${i}].jsonEncoded is not a boolean`,
      );
    }
    columns.push({
      source: col.source,
      identifier: quoteIdentifier(col.source, target),
      sqlType: col.sqlType as SqlType,
      nullable: col.nullable,
      jsonEncoded: col.jsonEncoded,
    });
  }
  return {
    table,
    target,
    tableIdentifier: quoteIdentifier(table, target),
    columns,
    // Not preserved across the sidecar boundary — see file JSDoc.
    rowCount: 0,
  };
};
