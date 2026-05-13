import { BaerlyError, readCurrentJson, type JSONArrayless, type Storage } from "@baerly/protocol";
import { loadSnapshotAsMap, walkLogRange } from "@baerly/server";
import type { ColumnPlan, ExportPlan, ExportRow, SqlTarget, SqlType } from "./types.ts";
import { quoteIdentifier } from "./sql-escape.ts";

/**
 * Worst-case observed shape for one column across all scanned rows.
 * Drives the {@link ColumnPlan.sqlType} pick in §3's table.
 */
interface ColumnObservation {
  hasString: boolean;
  hasBoolean: boolean;
  hasInteger: boolean;
  /** A floating number, OR an integer that doesn't fit 32-bit signed. */
  hasNonInteger: boolean;
  hasNestedObject: boolean;
  /** Any row missing this field → column is nullable. */
  hasNull: boolean;
}

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

const observe = (obs: ColumnObservation, value: JSONArrayless): void => {
  if (typeof value === "string") obs.hasString = true;
  else if (typeof value === "boolean") obs.hasBoolean = true;
  else if (typeof value === "number") {
    if (Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX) {
      obs.hasInteger = true;
    } else {
      obs.hasNonInteger = true;
    }
  } else if (value !== null && typeof value === "object") {
    obs.hasNestedObject = true;
  }
};

const pickSqlType = (
  obs: ColumnObservation,
  target: SqlTarget,
): { sqlType: SqlType; jsonEncoded: boolean } => {
  // Nested object present, in any combination → JSON.
  if (obs.hasNestedObject) {
    if (target === "postgres") return { sqlType: "jsonb", jsonEncoded: true };
    return { sqlType: "TEXT", jsonEncoded: true };
  }
  const primitiveKinds =
    (obs.hasString ? 1 : 0) +
    (obs.hasBoolean ? 1 : 0) +
    (obs.hasInteger || obs.hasNonInteger ? 1 : 0);
  // Mixed primitives → safest superset = text.
  if (primitiveKinds > 1) {
    if (target === "postgres") return { sqlType: "text", jsonEncoded: false };
    return { sqlType: "TEXT", jsonEncoded: false };
  }
  if (obs.hasString) {
    if (target === "postgres") return { sqlType: "text", jsonEncoded: false };
    return { sqlType: "TEXT", jsonEncoded: false };
  }
  if (obs.hasBoolean) {
    if (target === "postgres") return { sqlType: "boolean", jsonEncoded: false };
    return { sqlType: "INTEGER", jsonEncoded: false };
  }
  if (obs.hasNonInteger) {
    if (target === "postgres") return { sqlType: "double precision", jsonEncoded: false };
    return { sqlType: "REAL", jsonEncoded: false };
  }
  if (obs.hasInteger) {
    if (target === "postgres") return { sqlType: "integer", jsonEncoded: false };
    return { sqlType: "INTEGER", jsonEncoded: false };
  }
  // No observed value at all (column present-but-null on every row).
  // Fall back to text — won't matter because every insert will
  // emit NULL for it.
  if (target === "postgres") return { sqlType: "text", jsonEncoded: false };
  return { sqlType: "TEXT", jsonEncoded: false };
};

/**
 * Build an {@link ExportPlan} by scanning every row in the
 * materialised view. Column order is `_id` first, then every other
 * field sorted by first-appearance order (deterministic for a given
 * input map — JavaScript Maps preserve insertion order).
 *
 * @throws BaerlyError code="SchemaError" — a row body is not a
 *   `JSONArraylessObject` (defensive — the type system enforces it,
 *   but the snapshot reader hands us `unknown`-shaped JSON).
 */
export const inferPlanForCollection = (params: {
  rows: ReadonlyMap<string, ExportRow>;
  target: SqlTarget;
  table: string;
}): ExportPlan => {
  const { rows, target, table } = params;
  const obsByField = new Map<string, ColumnObservation>();
  // Track first-appearance order so the column list is stable.
  const orderedFields: string[] = [];
  // Per-field count of rows that carried this field (non-undefined).
  // Compared against `rows.size` in the second pass — any column
  // observed on fewer than every row is nullable.
  const rowsWithField = new Map<string, number>();

  // First pass — accumulate observations.
  for (const [id, body] of rows) {
    if (body === null || typeof body !== "object") {
      throw new BaerlyError(
        "SchemaError",
        `inferPlanForCollection: row ${JSON.stringify(id)} body is not an object`,
      );
    }
    for (const [field, value] of Object.entries(body)) {
      if (value === undefined) continue;
      let obs = obsByField.get(field);
      if (obs === undefined) {
        obs = {
          hasString: false,
          hasBoolean: false,
          hasInteger: false,
          hasNonInteger: false,
          hasNestedObject: false,
          hasNull: false,
        };
        obsByField.set(field, obs);
        orderedFields.push(field);
      }
      observe(obs, value);
      rowsWithField.set(field, (rowsWithField.get(field) ?? 0) + 1);
    }
  }

  // Second pass — any column observed on fewer than every row is
  // nullable. A single full sweep at the end captures both "field
  // disappears after appearing" AND "field first appears on the last
  // row" (the latter was a regression hole when the back-fill was
  // inlined into the per-row loop).
  const totalRows = rows.size;
  for (const [field, obs] of obsByField) {
    if ((rowsWithField.get(field) ?? 0) < totalRows) obs.hasNull = true;
  }

  // Build the column list. `_id` first (always — protocol-locked).
  // `_id` is the map key, not a body field, so its observation comes
  // implicitly: every row has a non-empty string id → text / TEXT.
  const columns: ColumnPlan[] = [];
  const idSqlType: SqlType = target === "postgres" ? "text" : "TEXT";
  columns.push({
    source: "_id",
    identifier: quoteIdentifier("_id", target),
    sqlType: idSqlType,
    // _id is special: ALWAYS NOT NULL (it's the PK).
    nullable: false,
    jsonEncoded: false,
  });
  for (const field of orderedFields) {
    if (field === "_id") continue; // _id from the body is ignored; the map key wins
    const obs = obsByField.get(field);
    if (obs === undefined) continue; // never observed → skip
    const { sqlType, jsonEncoded } = pickSqlType(obs, target);
    columns.push({
      source: field,
      identifier: quoteIdentifier(field, target),
      sqlType,
      nullable: obs.hasNull,
      jsonEncoded,
    });
  }

  return {
    target,
    table,
    tableIdentifier: quoteIdentifier(table, target),
    columns,
    rowCount: rows.size,
  };
};

/**
 * Read the live materialised view of one collection — snapshot
 * folded with the live log tail. Same shape `baerly copy` uses
 * (see `packages/cli/src/copy.ts`'s `loadSnapshotAsMap` JSDoc
 * example block).
 *
 * Returns `null` when `current.json` is missing (collection not
 * provisioned). Returns an empty map when the collection is
 * provisioned but holds no rows (every doc tombstoned, or no
 * inserts yet).
 */
export const loadMaterialisedView = async (params: {
  storage: Storage;
  currentJsonKey: string;
  collection: string;
  signal?: AbortSignal;
}): Promise<ReadonlyMap<string, ExportRow> | null> => {
  const { storage, currentJsonKey, collection } = params;
  const read = await readCurrentJson(
    storage,
    currentJsonKey,
    params.signal !== undefined ? { signal: params.signal } : undefined,
  );
  if (read === null) return null;
  const tablePrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  const base =
    read.json.snapshot === null
      ? new Map<string, ExportRow>()
      : await loadSnapshotAsMap(storage, read.json.snapshot, collection, params.signal);
  const entries = await walkLogRange(
    storage,
    tablePrefix,
    read.json.log_seq_start ?? 0,
    read.json.next_seq,
  );
  for (const entry of entries) {
    if (entry.collection !== collection) continue;
    if (entry.doc_id === undefined) continue;
    if (entry.op === "I" || entry.op === "U") {
      if (entry.new !== undefined) base.set(entry.doc_id, entry.new);
    } else if (entry.op === "D") {
      base.delete(entry.doc_id);
    }
  }
  return base;
};
