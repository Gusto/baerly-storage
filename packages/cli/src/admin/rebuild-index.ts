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
 *   --app     Application name segment. Default "app".
 *   --tenant  Tenant name segment. Default "tenant".
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

import { fileURLToPath, pathToFileURL } from "node:url";
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { type IndexDefinition, rebuildIndex, type BaerlyConfig } from "@baerly/server";
import { parseBucketUri } from "../copy";
import { emitError, emitSuccess, setJsonMode } from "../output";

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
    default: "app",
    description: "Application segment in the physical key prefix",
    valueHint: "app",
  },
  tenant: {
    type: "string",
    required: false,
    default: "tenant",
    description: "Tenant segment in the physical key prefix",
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
} as const satisfies ArgsDef;

type Args = ParsedArgs<typeof REBUILD_INDEX_ARGS>;

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "bucket",
  "app",
  "tenant",
  "table",
  "index",
  "on",
  "config",
  "json",
  "_",
]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") return 1;
  if (code === "Conflict" || code === "Internal" || code === "InvalidResponse") return 3;
  return 2;
};

/** Load a .js / .mjs / .json config and resolve the matching index's `on` field. */
const onFieldFromConfig = async (
  configPath: string,
  table: string,
  indexName: string,
): Promise<string | readonly string[]> => {
  if (configPath.endsWith(".ts")) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly admin rebuild-index: --config must point at compiled JS / JSON (got .ts: ${JSON.stringify(configPath)})`,
    );
  }
  // Dynamic import with a `file://` URL works for `.js` / `.mjs`.
  // For `.json` we read + parse directly — Node's JSON-module loader
  // requires `--experimental-json-modules` on some versions.
  let cfg: BaerlyConfig;
  if (configPath.endsWith(".json")) {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(configPath, "utf8");
    try {
      cfg = JSON.parse(text) as BaerlyConfig;
    } catch (e) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly admin rebuild-index: --config JSON parse error in ${JSON.stringify(configPath)}: ${(e as Error).message}`,
      );
    }
  } else {
    // Absolute-path import for filesystem files.
    const abs = configPath.startsWith("file://")
      ? fileURLToPath(configPath)
      : (await import("node:path")).resolve(configPath);
    const mod = (await import(pathToFileURL(abs).href)) as { default?: BaerlyConfig };
    if (mod.default === undefined) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly admin rebuild-index: --config ${JSON.stringify(configPath)} has no default export`,
      );
    }
    cfg = mod.default;
  }
  const collection = cfg.collections?.[table];
  if (collection === undefined) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly admin rebuild-index: config has no collections.${table}`,
    );
  }
  const def = collection.indexes?.find((d) => d.name === indexName);
  if (def === undefined) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly admin rebuild-index: config has no index ${JSON.stringify(indexName)} on collection ${JSON.stringify(table)}`,
    );
  }
  return def.on;
};

const handleRebuildIndex = async (args: Args): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly admin rebuild-index: unknown flag --${k}`);
      }
    }
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
    const currentJsonKey = `${bucket.keyPrefix}app/${args.app}/tenant/${args.tenant}/manifests/${args.table}/current.json`;
    const result = await rebuildIndex(bucket.storage, currentJsonKey, def);
    emitSuccess({
      command: "admin.rebuild-index",
      status: "ok",
      added: result.added,
      removed: result.removed,
      kept: result.kept,
    });
    if (process.env["BAERLY_REBUILD_INDEX_VERBOSE"] === "1") {
      process.stdout.write(
        `rebuild-index: added=${result.added} removed=${result.removed} kept=${result.kept}\n`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof BaerlyError) {
      emitError("admin.rebuild-index", err.code, err.message);
      return errorToExitCode(err.code);
    }
    emitError("admin.rebuild-index", "Unknown", (err as Error).message);
    return 2;
  }
};

/**
 * citty `defineCommand` block for `baerly admin rebuild-index`.
 * Mounted on the `admin` subcommand tree in `baerly.ts`.
 */
export const rebuildIndexCmd = defineCommand({
  meta: {
    name: "rebuild-index",
    description: "Idempotent reconciliation of one secondary index.",
  },
  args: REBUILD_INDEX_ARGS,
  run: async ({ args }) => {
    const code = await handleRebuildIndex(args);
    if (code !== 0) process.exit(code);
  },
});

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 *
 * @param argv Args AFTER the `admin rebuild-index` subcommand.
 */
export const runRebuildIndex = async (argv: readonly string[]): Promise<number> => {
  let parsed: Args;
  try {
    parsed = parseArgs<typeof REBUILD_INDEX_ARGS>(argv as string[], REBUILD_INDEX_ARGS);
  } catch (err) {
    setJsonMode(argv.includes("--json"));
    emitError("admin.rebuild-index", "InvalidConfig", (err as Error).message);
    return 1;
  }
  return handleRebuildIndex(parsed);
};
