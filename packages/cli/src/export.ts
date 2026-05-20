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
 *   --app               Default "app" (or `baerly.config.ts`).
 *   --tenant            Default "tenant" (or `baerly.config.ts`).
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
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import {
  BaerlyError,
  type DocumentData,
  matches,
  validatePredicate,
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
  translatePredicateToSql,
} from "./export/index.ts";
import { loadAppConfig } from "./config.ts";
import { parseBucketUri } from "./bucket-uri.ts";
import { emitError, emitSuccess, setJsonMode } from "./output.ts";

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
    description: "Application name segment (defaults to baerly.config.ts, then 'app').",
    valueHint: "app",
  },
  tenant: {
    type: "string",
    required: false,
    description: "Tenant name segment (defaults to baerly.config.ts, then 'tenant').",
    valueHint: "tenant",
  },
  table: {
    type: "string",
    required: true,
    description: "Collection (table) name.",
    valueHint: "name",
  },
  target: {
    type: "string",
    required: true,
    description: "SQL target: postgres | sqlite | d1.",
    valueHint: "postgres|sqlite|d1",
  },
  where: {
    type: "string",
    required: false,
    description: "JSON-encoded Predicate<T> filtering the rows to export.",
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

type Args = ParsedArgs<typeof EXPORT_ARGS>;

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "bucket",
  "app",
  "tenant",
  "table",
  "target",
  "where",
  "where-comment",
  "output",
  "sidecar",
  "json",
  "_",
]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") {
    return 1;
  }
  if (code === "Conflict" || code === "Internal" || code === "InvalidResponse") {
    return 3;
  }
  return 2;
};

const VALID_TARGETS = new Set<string>(["postgres", "sqlite", "d1"]);

const resolveAppTenant = async (args: Args): Promise<{ app: string; tenant: string }> => {
  if (
    typeof args.app === "string" &&
    args.app.length > 0 &&
    typeof args.tenant === "string" &&
    args.tenant.length > 0
  ) {
    return { app: args.app, tenant: args.tenant };
  }
  try {
    const cfg = await loadAppConfig();
    return {
      app: typeof args.app === "string" && args.app.length > 0 ? args.app : cfg.app,
      tenant: typeof args.tenant === "string" && args.tenant.length > 0 ? args.tenant : cfg.tenant,
    };
  } catch {
    return {
      app: typeof args.app === "string" && args.app.length > 0 ? args.app : "app",
      tenant: typeof args.tenant === "string" && args.tenant.length > 0 ? args.tenant : "tenant",
    };
  }
};

const parseWherePredicate = (raw: string): DocumentData => {
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
  validatePredicate(parsed as DocumentData);
  return parsed as DocumentData;
};

const filterRows = (
  rows: ReadonlyMap<string, ExportRow>,
  predicate: DocumentData | null,
): Map<string, ExportRow> => {
  const filtered = new Map<string, ExportRow>();
  for (const [id, body] of rows) {
    if (predicate === null) {
      filtered.set(id, body);
      continue;
    }
    if (matches(predicate, body)) {
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

const handleExport = async (args: Args): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly export: unknown flag --${k}`);
      }
    }
    if (!VALID_TARGETS.has(args.target)) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly export: --target must be postgres|sqlite|d1 (got ${JSON.stringify(args.target)})`,
      );
    }
    const target = args.target as SqlTarget;
    const { app, tenant } = await resolveAppTenant(args);
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

    let predicate: DocumentData | null = null;
    let whereClause = "";
    let whereHints: readonly string[] = [];
    if (typeof args.where === "string" && args.where.length > 0) {
      predicate = parseWherePredicate(args.where);
      const translation = translatePredicateToSql(
        predicate,
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

    const filtered = filterRows(view, predicate);
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
  } catch (error) {
    if (error instanceof BaerlyError) {
      emitError("export", error.code, error.message);
      return errorToExitCode(error.code);
    }
    emitError("export", "Unknown", (error as Error).message);
    return 2;
  }
};

/** citty `defineCommand` block for `baerly export`. */
export const exportCmd = defineCommand({
  meta: {
    name: "export",
    description: "Snapshot dump of one collection to SQL.",
  },
  args: EXPORT_ARGS,
  run: async ({ args }) => {
    const code = await handleExport(args);
    if (code !== 0) {
      process.exit(code);
    }
  },
});

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runExport = async (argv: readonly string[]): Promise<number> => {
  let parsed: Args;
  try {
    parsed = parseArgs<typeof EXPORT_ARGS>(argv as string[], EXPORT_ARGS);
  } catch (error) {
    setJsonMode(argv.includes("--json"));
    emitError("export", "InvalidConfig", (error as Error).message);
    return 1;
  }
  return handleExport(parsed);
};

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
