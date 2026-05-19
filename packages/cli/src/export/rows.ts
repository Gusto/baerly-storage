import type { JSONArrayless } from "@baerly/protocol";
import type { ExportPlan, ExportRow } from "./types.ts";
import { quoteValue } from "./sql-escape.ts";

/**
 * Emit one `INSERT INTO …` statement per row. The emitted SQL is
 * directly pipeable into `psql` / `sqlite3` / `wrangler d1
 * execute`. Per-row statements (not one big VALUES tuple) so a
 * mid-stream failure has bounded blast radius.
 *
 * For columns whose plan has `jsonEncoded: true`, the row's value
 * is JSON-stringified first and then string-quoted. Postgres
 * accepts a literal text JSON in a `jsonb` column. SQLite / D1 see
 * the JSON as plain TEXT.
 *
 * Rows are streamed via the async-iterable protocol so the export
 * never materialises the full SQL output in memory. The caller
 * concatenates the yielded chunks (or pipes them straight to disk
 * / stdout).
 */
export async function* emitInsertStatements(
  plan: ExportPlan,
  rows: ReadonlyMap<string, ExportRow>,
): AsyncIterable<string> {
  const columnList = plan.columns.map((c) => c.identifier).join(", ");
  // Iterate in `Map` insertion order — stable, and the snapshot
  // body itself sorts by `_id` (compactor.ts: `docs is sorted by
  // _id for deterministic byte output`).
  for (const [id, body] of rows) {
    const values: string[] = [];
    for (const col of plan.columns) {
      const raw: JSONArrayless | undefined =
        col.source === "_id"
          ? (id as JSONArrayless)
          : (body as Record<string, JSONArrayless>)[col.source];
      if (raw === undefined) {
        values.push("NULL");
        continue;
      }
      if (col.jsonEncoded) {
        const json = JSON.stringify(raw);
        values.push(quoteValue(json, plan.target));
      } else {
        values.push(quoteValue(raw, plan.target));
      }
    }
    yield `INSERT INTO ${plan.tableIdentifier} (${columnList}) VALUES (${values.join(", ")});\n`;
  }
}
