/**
 * `baerly admin rebuild-index` — idempotent reconciliation for one
 * secondary index. Walks the live `(snapshot, log)` of the named
 * collection, computes the expected index-key set under the named
 * index's definition, then PUTs missing keys and DELETEs orphans.
 *
 * Cost shape: `1 GET (current.json) + 1 GET (snapshot, if any) + N
 * GETs (live tail) + 1 LIST (the index prefix) + K PUTs + L DELETEs`.
 *
 * Exit codes (mirrors `baerly copy`):
 *   - `0` — success (envelope on stdout in --json mode).
 *   - `1` — user error (InvalidConfig: bad bucket URI, missing
 *           args, unparseable config).
 *   - `2` — storage error (NetworkError, AccessDenied, anything
 *           non-BaerlyError).
 *   - `3` — protocol invariant (Conflict, Internal, InvalidResponse).
 *
 * Idempotent — re-running on a healthy index is `{ removed: 0,
 * added: 0 }`; re-running after a crashed mid-commit reconciles
 * toward the live current.json view.
 *
 * Args:
 *   --bucket  Bucket URI (s3://...,  file:///<abs>, memory://...).
 *   --app     Application name segment (defaults to baerly.config.ts).
 *   --tenant  Tenant name segment (defaults to baerly.config.ts).
 *   --table   Collection name.
 *   --index   Index name (e.g. "by_status").
 *   --on      Field the index projects on (string today; matches
 *             the IndexDefinition shape declared in baerly.config.ts).
 *   --config  Path to a baerly.config.{js,mjs,json}. Loaded with
 *             dynamic import; the matching collection.indexes[]
 *             definition is used. Mutually-exclusive with --on
 *             (config takes precedence). `.ts` configs are not
 *             supported today — point at the compiled output.
 *
 * The reconciliation logic itself lives in `@baerly/server`'s
 * `rebuildIndex`; this command is a thin URI + arg-parsing wrapper.
 */

import { type ArgsDef } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { type IndexDefinition } from "@baerly/server";
import { rebuildIndex } from "@baerly/server/maintenance";
import { loadCollectionIndexes } from "../config.ts";
import { parseBucketUri } from "../bucket-uri.ts";
import { emitSuccess } from "../output.ts";
import { defineBaerlySubcommand } from "../subcommand.ts";

/** citty arg shape. Kebab-case so --help and parsed-object keys line up. */
const REBUILD_INDEX_ARGS = {
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
    description: "Collection (table) name",
    valueHint: "name",
  },
  index: {
    type: "string",
    required: true,
    description: "Index name (e.g. by_status)",
    valueHint: "name",
  },
  on: {
    type: "string",
    required: false,
    description: "Field the index projects on. Required unless --config supplies it.",
    valueHint: "field",
  },
  config: {
    type: "string",
    required: false,
    description: "Path to baerly.config.{js,mjs,json} — used to resolve the index's `on` field.",
    valueHint: "path",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
  verbose: {
    type: "boolean",
    description: "Emit a one-line summary to stdout in addition to the JSON envelope.",
  },
} as const satisfies ArgsDef;

/** Resolve the `on` field of a single named index from the config file. */
const onFieldFromConfig = async (
  configPath: string,
  table: string,
  indexName: string,
): Promise<string | readonly string[]> => {
  const indexes = await loadCollectionIndexes(configPath, table, "baerly admin rebuild-index");
  const def = indexes.find((d) => d.name === indexName);
  if (def === undefined) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly admin rebuild-index: config has no index ${JSON.stringify(indexName)} on collection ${JSON.stringify(table)}`,
    );
  }
  return def.on;
};

const bundle = defineBaerlySubcommand({
  name: "admin.rebuild-index",
  meta: {
    description: "Idempotent reconciliation of one secondary index.",
  },
  args: REBUILD_INDEX_ARGS,
  handler: async (args, ctx) => {
    const bucket = await parseBucketUri(args.bucket);
    const on =
      args.config !== undefined && args.config.length > 0
        ? await onFieldFromConfig(args.config, args.table, args.index)
        : args.on;
    if (on === undefined || on.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        "baerly admin rebuild-index: --on=<field> (or --config=<path>) is required",
      );
    }
    const def: IndexDefinition = { name: args.index, on };
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    const currentJsonKey = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.table}/current.json`;
    const result = await rebuildIndex(bucket.storage, currentJsonKey, def);
    emitSuccess({
      command: "admin.rebuild-index",
      status: "ok",
      added: result.added,
      removed: result.removed,
      kept: result.kept,
    });
    if (args.verbose === true) {
      process.stdout.write(
        `rebuild-index: added=${result.added} removed=${result.removed} kept=${result.kept}\n`,
      );
    }
    return 0;
  },
});

/**
 * citty `defineCommand` block for `baerly admin rebuild-index`.
 * Mounted on the `admin` subcommand tree in `baerly.ts`.
 */
export const rebuildIndexCmd = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 *
 * @param argv Args AFTER the `admin rebuild-index` subcommand.
 */
export const runRebuildIndex = bundle.run;
