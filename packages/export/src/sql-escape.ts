import { BaerlyError, type JSONArrayless } from "@baerly/protocol";
import type { SqlTarget } from "./types.ts";

/**
 * Quote an SQL identifier (table or column name) per the target's
 * lexical rules. All three targets accept double-quoted identifiers
 * with embedded `""` for a literal quote. SQLite and Postgres are
 * case-preserving inside double quotes; D1 (sqlite-flavoured)
 * matches.
 *
 * @throws BaerlyError code="SchemaError" — name is empty or contains
 *   a NUL byte.
 */
export const quoteIdentifier = (name: string, _target: SqlTarget): string => {
  if (name.length === 0) {
    throw new BaerlyError("SchemaError", "quoteIdentifier: empty identifier");
  }
  if (name.includes("\0")) {
    throw new BaerlyError(
      "SchemaError",
      `quoteIdentifier: NUL byte in identifier ${JSON.stringify(name)}`,
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
};

/**
 * Quote a value for inline embedding in `INSERT INTO … VALUES (…)`.
 * Targets agree on `'…'` with doubled `''` for embedded apostrophes
 * and `NULL` for SQL null. JSONB / JSON-encoded text values are
 * passed in as JSON-stringified text by the caller; this function
 * sees them as plain strings.
 *
 * @throws BaerlyError code="SchemaError" — value is an unsupported
 *   shape (e.g. raw `undefined` from a missing-field, which
 *   {@link emitInsertStatements} pre-filters into `NULL` before
 *   calling this).
 */
export const quoteValue = (value: JSONArrayless | null, target: SqlTarget): string => {
  if (value === null) return "NULL";
  if (typeof value === "string") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BaerlyError(
        "SchemaError",
        `quoteValue: ${String(value)} is not finite — JSON doesn't survive round-trip`,
      );
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    if (target === "postgres") return value ? "true" : "false";
    return value ? "1" : "0";
  }
  // Nested object: caller is responsible for setting the column's
  // `jsonEncoded` flag and pre-stringifying before reaching here.
  throw new BaerlyError(
    "SchemaError",
    `quoteValue: nested-object reached the quoter without pre-encoding — caller bug`,
  );
};
