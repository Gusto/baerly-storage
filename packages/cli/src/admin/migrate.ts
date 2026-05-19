/**
 * `baerly admin migrate` — schema-version fold over one collection.
 *
 * Loads the operator-supplied transform module (must default-export a
 * `(row) => row | null` function), then calls `migrateCollection`
 * from `@baerly/server` to fold every row in the collection through
 * the transform and CAS-advance `current.json` to point at a fresh
 * L9 snapshot stamped with the new `migrated_to` version.
 *
 * Args:
 *   --bucket            Required. Bucket URI.
 *   --app               Default "app" (or `baerly.config.ts`).
 *   --tenant            Default "tenant" (or `baerly.config.ts`).
 *   --table             Required. Collection name.
 *   --transform         Required. Path to a `.js` / `.mjs` / `.cjs` /
 *                       `.json` file whose default export is the
 *                       transform function. `.ts` is rejected — point
 *                       at the compiled output.
 *   --target-version    Required. Non-negative integer; written to the
 *                       new `current.json`'s `migrated_to` field. A
 *                       re-run on a bucket already at this version
 *                       (or higher) is a no-op.
 *   --json              JSON envelope.
 *
 * Exit codes:
 *   0 — migrate completed (may be a no-op short-circuit).
 *   1 — InvalidConfig (bad bucket URI, missing args, transform path
 *       unresolvable, default export missing or not a function).
 *   2 — Storage / Network error.
 *   3 — Protocol invariant (Conflict / Internal / InvalidResponse /
 *       SchemaError raised by the transform).
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { BaerlyError, type JSONArraylessObject } from "@baerly/protocol";
import { migrateCollection } from "@baerly/server";
import { loadAppConfig } from "../config.ts";
import { parseBucketUri } from "../copy.ts";
import { emitError, emitSuccess, setJsonMode } from "../output.ts";

const MIGRATE_ARGS = {
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
  transform: {
    type: "string",
    required: true,
    description: "Path to a .js/.mjs/.cjs file whose default export is the row transform.",
    valueHint: "path",
  },
  "target-version": {
    type: "string",
    required: true,
    description: "Non-negative integer written to current.json.migrated_to.",
    valueHint: "int",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

type Args = ParsedArgs<typeof MIGRATE_ARGS>;

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "bucket",
  "app",
  "tenant",
  "table",
  "transform",
  "target-version",
  "json",
  "_",
]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") {
    return 1;
  }
  if (
    code === "Conflict" ||
    code === "Internal" ||
    code === "InvalidResponse" ||
    code === "SchemaError"
  ) {
    return 3;
  }
  return 2;
};

type RowTransform = (row: JSONArraylessObject) => JSONArraylessObject | null;

const loadTransform = async (transformPath: string): Promise<RowTransform> => {
  if (transformPath.endsWith(".ts")) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly admin migrate: --transform must point at compiled JS (got .ts: ${JSON.stringify(transformPath)})`,
    );
  }
  const pathMod = await import("node:path");
  const abs = transformPath.startsWith("file://")
    ? fileURLToPath(transformPath)
    : pathMod.resolve(transformPath);
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
  } catch (error) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly admin migrate: failed to load --transform=${JSON.stringify(transformPath)}: ${(error as Error).message}`,
      error,
    );
  }
  const fn = mod.default;
  if (typeof fn !== "function") {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly admin migrate: --transform=${JSON.stringify(transformPath)} has no default-export function`,
    );
  }
  return fn as RowTransform;
};

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

const handleMigrate = async (args: Args): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly admin migrate: unknown flag --${k}`);
      }
    }
    const targetVersion = Number.parseInt(args["target-version"], 10);
    if (
      !Number.isFinite(targetVersion) ||
      !Number.isInteger(targetVersion) ||
      targetVersion < 0 ||
      String(targetVersion) !== args["target-version"].trim()
    ) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly admin migrate: --target-version must be a non-negative integer (got ${JSON.stringify(args["target-version"])})`,
      );
    }
    const transform = await loadTransform(args.transform);
    const { app, tenant } = await resolveAppTenant(args);
    const bucket = await parseBucketUri(args.bucket);
    const currentJsonKey = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.table}/current.json`;
    const result = await migrateCollection({
      storage: bucket.storage,
      currentJsonKey,
      collection: args.table,
      transform,
      targetVersion,
    });
    emitSuccess({
      command: "admin.migrate",
      status: "ok",
      table: args.table,
      target_version: targetVersion,
      no_op: result.noOp,
      input_rows: result.inputRows,
      output_rows: result.outputRows,
      new_snapshot_key: result.newSnapshotKey,
    });
    return 0;
  } catch (error) {
    if (error instanceof BaerlyError) {
      emitError("admin.migrate", error.code, error.message);
      return errorToExitCode(error.code);
    }
    emitError("admin.migrate", "Unknown", (error as Error).message);
    return 2;
  }
};

/** citty `defineCommand` block for `baerly admin migrate`. */
export const migrateCmd = defineCommand({
  meta: {
    name: "migrate",
    description: "Apply a schema-version row transform across one collection.",
  },
  args: MIGRATE_ARGS,
  run: async ({ args }) => {
    const code = await handleMigrate(args);
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
export const runMigrate = async (argv: readonly string[]): Promise<number> => {
  let parsed: Args;
  try {
    parsed = parseArgs<typeof MIGRATE_ARGS>(argv as string[], MIGRATE_ARGS);
  } catch (error) {
    setJsonMode(argv.includes("--json"));
    emitError("admin.migrate", "InvalidConfig", (error as Error).message);
    return 1;
  }
  return handleMigrate(parsed);
};
