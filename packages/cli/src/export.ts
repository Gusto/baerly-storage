/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; the exporter threads it
   through the materialised view and the emitted INSERT rows. */

/**
 * `baerly export` — snapshot dump of one collection to SQL.
 *
 * Drives the export modules end-to-end: load the materialised view,
 * infer an `ExportPlan` over the row shape, emit `CREATE TABLE` +
 * `INSERT` statements. When `--where=<json>` is supplied the
 * predicate is translated via `translatePredicateToSql` and applied
 * in-memory through `matches(...)` so the emitted INSERTs already
 * match the filter; the translated WHERE clause is also surfaced as a
 * comment above the inserts so operators can inspect / hand-edit it.
 *
 * The sidecar file (`<output>.plan.json`) carries the `ExportPlan` so
 * a follow-up round-trip ingest can verify the column schema. The
 * sidecar is JSON via `JSON.stringify` — the plan shape is the public
 * contract.
 *
 * Args:
 *   --bucket            Required. Bucket URI.
 *   --app               Required (or via baerly.config.ts).
 *   --tenant            Required (or via baerly.config.ts).
 *   --table             Required. Collection name.
 *   --target            Required. postgres | sqlite | d1.
 *   --where             Optional. JSON-encoded `Predicate<T>`.
 *   --where-comment     Optional. Caller hint surfaced as a
 *                       `-- TODO(baerly export):` comment.
 *   --output            Optional. Path to write SQL into; default
 *                       stdout. The sidecar plan is written to
 *                       `<output>.plan.json` unless `--no-sidecar`.
 *   --no-sidecar        Skip emitting the sidecar plan file.
 *   --json              JSON envelope on stdout (or stderr on error).
 *
 * Exit codes:
 *   0 — dump completed.
 *   1 — InvalidConfig (bad args / bucket URI / --where JSON / unknown --target).
 *   2 — Storage / Network error.
 *   3 — Protocol invariant (Internal / InvalidResponse / Conflict).
 */

import { writeFile } from "node:fs/promises";
import { type ArgsDef } from "citty";
import {
  BaerlyError,
  matchesWire,
  type PredicateWire,
  validateWire,
} from "@baerly/protocol";
import {
  type ExportPlan,
  type ExportRow,
  type SqlTarget,
  emitCreateTable,
  emitInsertStatements,
  inferPlanForCollection,
  loadMaterialisedView,
  serializeExportPlan,
  translatePredicateWireToSql,
} from "./export/index.ts";
import { parseBucketUri } from "./bucket-uri.ts";
import { emitSuccess } from "./output.ts";
import { defineBaerlySubcommand } from "./subcommand.ts";

const EXPORT_ARGS = {
  bucket: {
    type: "string",
    required: true,
    description: "Bucket URI (s3://<bucket>[/<prefix>], file:///<abs>, memory://<bucket>)",
    valueHint: "bucket-uri",
  },
  app: {
    type: "string",
    required: false,
    description: "Application name segment (defaults to baerly.config.ts).",
    valueHint: "app",
  },
  tenant: {
    type: "string",
    required: false,
    description: "Tenant name segment (defaults to baerly.config.ts).",
    valueHint: "tenant",
  },
  table: {
    type: "string",
    required: true,
    description: "Collection (table) name.",
    valueHint: "name",
  },
  target: {
    type: "enum",
    options: ["postgres", "sqlite", "d1"],
    required: true,
    description: "SQL target: postgres | sqlite | d1.",
  },
  where: {
    type: "string",
    required: false,
    description: "JSON-encoded PredicateWire ({ clauses: [...] }) filtering the rows to export.",
    valueHint: "json",
  },
  "where-comment": {
    type: "string",
    required: false,
    description: "Caller hint surfaced as a -- TODO(baerly export): comment.",
    valueHint: "text",
  },
  output: {
    type: "string",
    required: false,
    description: "Path to write SQL into; default stdout.",
    valueHint: "path",
  },
  sidecar: {
    type: "boolean",
    default: true,
    description: "Emit a <output>.plan.json sidecar (default true; pass --no-sidecar to skip).",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

const parseWherePredicate = (raw: string): PredicateWire => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly export: --where is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly export: --where must decode to a JSON object (got ${describeNonObject(parsed)})`,
    );
  }
  // Re-validate defensively; the translator will reject too, but
  // surfacing the error here gives a single uniform error path.
  validateWire(parsed as PredicateWire);
  return parsed as PredicateWire;
};

const filterRows = (
  rows: ReadonlyMap<string, ExportRow>,
  wire: PredicateWire | null,
): Map<string, ExportRow> => {
  const filtered = new Map<string, ExportRow>();
  for (const [id, body] of rows) {
    if (wire === null) {
      filtered.set(id, body);
      continue;
    }
    if (matchesWire(wire, body)) {
      filtered.set(id, body);
    }
  }
  return filtered;
};

const buildSql = async (
  plan: ExportPlan,
  rows: ReadonlyMap<string, ExportRow>,
  whereClause: string,
  whereHints: readonly string[],
): Promise<string> => {
  let out = emitCreateTable(plan);
  for (const hint of whereHints) {
    out += `-- TODO(baerly export): ${hint}\n`;
  }
  if (whereClause.length > 0) {
    out += `-- WHERE clause for review: ${whereClause}\n`;
  }
  for await (const chunk of emitInsertStatements(plan, rows)) {
    out += chunk;
  }
  return out;
};

const bundle = defineBaerlySubcommand({
  name: "export",
  meta: {
    description: "Snapshot dump of one collection to SQL.",
  },
  args: EXPORT_ARGS,
  handler: async (args, ctx) => {
    const target: SqlTarget = args.target;
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    const bucket = await parseBucketUri(args.bucket);
    const currentJsonKey = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.table}/current.json`;
    const view = await loadMaterialisedView({
      storage: bucket.storage,
      currentJsonKey,
      collection: args.table,
    });
    if (view === null) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly export: collection ${JSON.stringify(args.table)} is not provisioned (no current.json at ${currentJsonKey})`,
      );
    }
    const plan = inferPlanForCollection({
      rows: view,
      target,
      table: args.table,
    });

    let wire: PredicateWire | null = null;
    let whereClause = "";
    let whereHints: readonly string[] = [];
    if (typeof args.where === "string" && args.where.length > 0) {
      wire = parseWherePredicate(args.where);
      const translation = translatePredicateWireToSql(
        wire,
        plan,
        typeof args["where-comment"] === "string" && args["where-comment"].length > 0
          ? { dynamicHint: args["where-comment"] }
          : undefined,
      );
      whereClause = translation.sql;
      whereHints = translation.hints;
    } else if (typeof args["where-comment"] === "string" && args["where-comment"].length > 0) {
      // Bare --where-comment with no predicate still surfaces the operator's
      // note so reviewers see the intent.
      whereHints = [
        `caller-flagged dynamic predicate: ${args["where-comment"]}. No predicate supplied; emitted INSERTs cover the full collection.`,
      ];
    }

    const filtered = filterRows(view, wire);
    const sql = await buildSql(plan, filtered, whereClause, whereHints);

    const outputPath = args.output;
    if (typeof outputPath === "string" && outputPath.length > 0) {
      await writeFile(outputPath, sql, "utf8");
      if (args.sidecar !== false) {
        await writeFile(`${outputPath}.plan.json`, serializeExportPlan(plan), "utf8");
      }
    } else {
      process.stdout.write(sql);
    }

    emitSuccess({
      command: "export",
      status: "ok",
      table: args.table,
      target,
      rows: filtered.size,
      hints: whereHints,
      ...(typeof outputPath === "string" && outputPath.length > 0 && { output: outputPath }),
    });
    return 0;
  },
});

/** citty `defineCommand` block for `baerly export`. */
export const exportCmd = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runExport = bundle.run;

// Build a human-readable label for the "expected JSON object" error.
// `null`, arrays, and the bare `undefined` need to be disambiguated
// from `typeof`'s default "object".
const describeNonObject = (v: unknown): string => {
  if (v === null) {
    return "null";
  }
  if (Array.isArray(v)) {
    return "array";
  }
  return typeof v;
};
