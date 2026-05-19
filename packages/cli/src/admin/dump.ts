/**
 * `baerly admin dump` — canonical NDJSON of the materialised view.
 *
 * Writes one row per line to stdout (or to the file path in
 * `BAERLY_DUMP_STDOUT_PATH` for the round-trip test), in a strict
 * byte-stable shape so two semantically-equal collections produce
 * byte-equal output.
 *
 * Canonical NDJSON dump format:
 *
 *   1. Each row is `{"_id":"<id>",…}` (no spaces).
 *   2. Row order = ASCII-lex sort on `_id`.
 *   3. Within each row, object keys are sorted ASCII-lex
 *      RECURSIVELY — every nested object's keys are sorted too.
 *   4. Numbers as their canonical `JSON.stringify` output.
 *      Finite-only (the protocol forbids NaN / Infinity).
 *   5. Strings as `JSON.stringify` output (escape sequences
 *      identical to `\uXXXX` for control codes).
 *   6. One trailing newline at EOF (`\n`, not `\r\n`).
 *   7. No BOM.
 *
 * The round-trip ticket (73) gates byte-equality on this format. A
 * change to any of (1)–(7) is a BREAKING change requiring a
 * round-trip schema-version bump.
 *
 * Empty collection → empty file (no trailing newline) — disambiguates
 * "zero rows" from "one row with empty body".
 *
 * Args:
 *   --bucket   Required. Bucket URI.
 *   --app      Default from baerly.config.ts; falls back to "app".
 *   --tenant   Default from baerly.config.ts; falls back to "tenant".
 *   --table    Required. Collection name.
 *   --json     JSON envelope (on stdout). Mutually informative with the
 *              NDJSON output: when --json is set the NDJSON body is
 *              redirected to `BAERLY_DUMP_STDOUT_PATH` (or rejected).
 *
 * Exit codes:
 *   0 — dump completed.
 *   1 — InvalidConfig (bad bucket URI, missing args).
 *   2 — Storage / Network / Internal protocol violation.
 */

import { open, type FileHandle } from "node:fs/promises";
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { BaerlyError, type DocumentValue, type DocumentData } from "@baerly/protocol";
import { loadMaterialisedView } from "../export/index.ts";
import { loadAppConfig } from "../config.ts";
import { parseBucketUri } from "../copy.ts";
import { emitError, emitSuccess, setJsonMode } from "../output.ts";

const DUMP_ARGS = {
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
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

type Args = ParsedArgs<typeof DUMP_ARGS>;

const KNOWN_KEYS: ReadonlySet<string> = new Set(["bucket", "app", "tenant", "table", "json", "_"]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") {
    return 1;
  }
  if (code === "Conflict" || code === "Internal" || code === "InvalidResponse") {
    return 3;
  }
  return 2;
};

/**
 * Recursive byte-stable JSON stringifier. Keys at every nesting level
 * are sorted ASCII-lex. Numbers must be finite (protocol forbids
 * NaN / Infinity in bodies). Arrays are rejected — the protocol
 * forbids them in bodies; documenting the case here keeps a future
 * widening from silently drifting the canonical format.
 */
export const canonicalStringify = (value: DocumentValue): string => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BaerlyError(
        "InvalidResponse",
        `baerly admin dump: non-finite number in row body (${String(value)}); protocol violation`,
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value === null) {
    // DocumentValue excludes null at the type level, but `unknown` may
    // sneak in via the snapshot fold — be defensive.
    return "null";
  }
  if (Array.isArray(value)) {
    throw new BaerlyError(
      "InvalidResponse",
      "baerly admin dump: array in row body; protocol violation",
    );
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).toSorted();
    const parts: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, DocumentValue>)[k];
      if (v === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(k)}:${canonicalStringify(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new BaerlyError(
    "InvalidResponse",
    `baerly admin dump: unsupported value type ${typeof value}`,
  );
};

/** Default-app / default-tenant resolution. Falls back silently to "app"/"tenant". */
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

const writeToSink = async (
  sinkPath: string | undefined,
  rows: ReadonlyMap<string, DocumentData>,
): Promise<number> => {
  const encoder = new TextEncoder();
  const ids = [...rows.keys()].toSorted();
  let handle: FileHandle | undefined;
  try {
    if (sinkPath !== undefined) {
      handle = await open(sinkPath, "w");
    }
    let count = 0;
    for (const id of ids) {
      const body = rows.get(id);
      if (body === undefined) {
        continue;
      }
      // Merge `_id` into the body so the row literal carries it. The
      // map key is authoritative; if a stale `_id` field disagrees, we
      // overwrite it.
      const row: DocumentData = { ...body, _id: id };
      const line = `${canonicalStringify(row)}\n`;
      if (handle !== undefined) {
        await handle.write(encoder.encode(line));
      } else {
        process.stdout.write(line);
      }
      count++;
    }
    return count;
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
};

const handleDump = async (args: Args): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly admin dump: unknown flag --${k}`);
      }
    }
    const bucket = await parseBucketUri(args.bucket);
    const { app, tenant } = await resolveAppTenant(args);
    const currentJsonKey = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.table}/current.json`;
    const view = await loadMaterialisedView({
      storage: bucket.storage,
      currentJsonKey,
      collection: args.table,
    });
    if (view === null) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly admin dump: current.json not found at ${currentJsonKey}`,
      );
    }
    const sinkPath = process.env["BAERLY_DUMP_STDOUT_PATH"];
    const count = await writeToSink(sinkPath, view);
    emitSuccess({
      command: "admin.dump",
      status: "ok",
      table: args.table,
      dumped: count,
    });
    return 0;
  } catch (error) {
    if (error instanceof BaerlyError) {
      emitError("admin.dump", error.code, error.message);
      return errorToExitCode(error.code);
    }
    emitError("admin.dump", "Unknown", (error as Error).message);
    return 2;
  }
};

/** citty `defineCommand` block for `baerly admin dump`. */
export const dumpCmd = defineCommand({
  meta: {
    name: "dump",
    description: "Canonical NDJSON of the materialised view of one collection.",
  },
  args: DUMP_ARGS,
  run: async ({ args }) => {
    const code = await handleDump(args);
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
export const runDump = async (argv: readonly string[]): Promise<number> => {
  let parsed: Args;
  try {
    parsed = parseArgs<typeof DUMP_ARGS>(argv as string[], DUMP_ARGS);
  } catch (error) {
    setJsonMode(argv.includes("--json"));
    emitError("admin.dump", "InvalidConfig", (error as Error).message);
    return 1;
  }
  return handleDump(parsed);
};
