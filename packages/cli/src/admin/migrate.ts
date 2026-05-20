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
 *   --app               Required (or via baerly.config.ts).
 *   --tenant            Required (or via baerly.config.ts).
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
 *   2 — Storage / Network error (or SchemaError raised by the
 *       operator-supplied transform).
 *   3 — Protocol invariant (Conflict / Internal / InvalidResponse).
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { type ArgsDef } from "citty";
import { BaerlyError, type DocumentData } from "@baerly/protocol";
import { migrateCollection } from "@baerly/server/maintenance";
import { parseBucketUri } from "../bucket-uri.ts";
import { emitSuccess } from "../output.ts";
import { defineBaerlySubcommand } from "../subcommand.ts";

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

type RowTransform = (row: DocumentData) => DocumentData | null;

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

const bundle = defineBaerlySubcommand({
  name: "admin.migrate",
  meta: {
    description: "Apply a schema-version row transform across one collection.",
  },
  args: MIGRATE_ARGS,
  handler: async (args, ctx) => {
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
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
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
  },
});

/** citty `defineCommand` block for `baerly admin migrate`. */
export const migrateCmd = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runMigrate = bundle.run;
