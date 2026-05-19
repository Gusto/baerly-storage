/**
 * `baerly admin restore` — bulk-import NDJSON into a fresh collection.
 *
 * Reads NDJSON from stdin (or from `BAERLY_RESTORE_STDIN_PATH` if
 * set — the round-trip test uses this), reconstructs each row, and
 * calls `ServerWriter.commit({op:"I"})` per row into the target
 * bucket. Idempotent on a fresh bucket: re-running on a
 * half-completed restore **refuses** unless `--force` is set (which
 * bumps the writer fence and seeds a fresh `current.json` first).
 *
 * Args:
 *   --bucket   Required. Target bucket URI.
 *   --app      Default from baerly.config.ts; falls back to "app".
 *   --tenant   Default from baerly.config.ts; falls back to "tenant".
 *   --table    Required. Target collection name.
 *   --force    Truncate the target if it exists (fence-bump + reseed).
 *   --json     JSON envelope.
 *
 * stdin: NDJSON, one `{_id, ...}` row per line. Empty lines tolerated.
 *        EOF terminates.
 *
 * Cost shape: 1 PUT current.json (initial) + N × (1 PUT log + 1 PUT
 *   content + 1 PUT current.json CAS) = 3N + 1 Class A ops for N rows.
 *
 * Partial-restore semantics: a mid-stream Network / Internal / parse
 * error leaves the target in a partial state (some rows committed,
 * `current.json` advanced to wherever the last successful commit
 * landed). Re-run with `--force` to truncate, or hand-clean. The
 * malformed-line case (missing `_id`, bad JSON) fails fast on that
 * line; rows committed BEFORE it survive.
 *
 * Exit codes:
 *   0 — every row committed.
 *   1 — InvalidConfig (bad bucket URI, missing args, malformed NDJSON
 *       line — line-level shape problems are operator-fixable).
 *   2 — Network / storage error mid-stream.
 *   3 — Conflict from a pre-existing target without --force, or from a
 *       concurrent writer when --force was used.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import {
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type CurrentJson,
  type DocumentData,
  readCurrentJson,
} from "@baerly/protocol";
import { ServerWriter } from "@baerly/server";
import { loadAppConfig } from "../config.ts";
import { parseBucketUri } from "../copy.ts";
import { emitError, emitSuccess, setJsonMode } from "../output.ts";

const RESTORE_OWNER = "baerly-restore";

const RESTORE_ARGS = {
  bucket: {
    type: "string",
    required: true,
    description: "Target bucket URI (s3://<bucket>[/<prefix>], file:///<abs>, memory://<bucket>)",
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
    description: "Target collection (table) name.",
    valueHint: "name",
  },
  force: {
    type: "boolean",
    description: "Truncate the target if it exists (bump fence + reseed current.json).",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

type Args = ParsedArgs<typeof RESTORE_ARGS>;

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "bucket",
  "app",
  "tenant",
  "table",
  "force",
  "json",
  "_",
]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") {
    return 1;
  }
  if (code === "Conflict") {
    return 3;
  }
  if (code === "Internal" || code === "InvalidResponse") {
    return 3;
  }
  return 2;
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

const handleRestore = async (args: Args): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly admin restore: unknown flag --${k}`);
      }
    }

    const bucket = await parseBucketUri(args.bucket);
    const { app, tenant } = await resolveAppTenant(args);
    const currentJsonKey = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.table}/current.json`;

    const head = await readCurrentJson(bucket.storage, currentJsonKey);
    if (head !== null && args.force !== true) {
      throw new BaerlyError(
        "Conflict",
        `baerly admin restore: ${currentJsonKey} exists; pass --force to truncate`,
      );
    }
    if (head !== null) {
      // --force: bump the fence on the existing record so any
      // in-flight writer aborts, then overwrite `current.json` with a
      // fresh seed under If-Match. A concurrent writer landing
      // between our read and our CAS PUT surfaces Conflict (exit 3).
      //
      // CRITICAL: stale log entries from the old generation still
      // live on disk under `log/<seq>.json` paths. The writer's
      // `If-None-Match: "*"` log PUT will 412 if we restart `next_seq`
      // at 0 and collide with `log/0.json`. We instead advance
      // `next_seq` and `log_seq_start` past the old data so new
      // commits land at fresh sequence numbers and the old log files
      // become unreferenced orphans (the compactor / GC sweep them on
      // the next maintenance pass).
      const truncatedNext = head.json.next_seq;
      const reseeded: CurrentJson = {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        next_seq: truncatedNext,
        log_seq_start: truncatedNext,
        writer_fence: {
          epoch: head.json.writer_fence.epoch + 1,
          owner: RESTORE_OWNER,
          claimed_at: "",
        },
      };
      try {
        await bucket.storage.put(
          currentJsonKey,
          new TextEncoder().encode(JSON.stringify(reseeded)),
          { ifMatch: head.etag, contentType: "application/json" },
        );
      } catch (error) {
        if (error instanceof BaerlyError) {
          throw error;
        }
        throw new BaerlyError(
          "NetworkError",
          `baerly admin restore: failed to reseed current.json: ${(error as Error).message}`,
        );
      }
    } else {
      // Fresh target: seed `current.json` with `next_seq=0`.
      const seed: CurrentJson = {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        next_seq: 0,
        log_seq_start: 0,
        writer_fence: { epoch: 0, owner: RESTORE_OWNER, claimed_at: "" },
      };
      await createCurrentJson(bucket.storage, currentJsonKey, seed);
    }

    const writer = new ServerWriter({ storage: bucket.storage, currentJsonKey });

    const stdinPath = process.env["BAERLY_RESTORE_STDIN_PATH"];
    const stream =
      stdinPath !== undefined && stdinPath.length > 0 ? createReadStream(stdinPath) : process.stdin;
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;
    let lineNo = 0;
    for await (const line of rl) {
      lineNo++;
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        // Malformed NDJSON mid-stream → exit 2 (the ticket's
        // partial-restore contract: the line that failed wasn't
        // committed, but anything BEFORE it survives).
        throw new Error(
          `baerly admin restore: line ${lineNo} is not valid JSON: ${(error as Error).message}`,
          { cause: error },
        );
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`baerly admin restore: line ${lineNo} is not a JSON object`);
      }
      const row = parsed as Record<string, unknown>;
      const id = row["_id"];
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(`baerly admin restore: line ${lineNo} missing non-empty string _id`);
      }
      // Pass the full object as the body — `_id` is part of the
      // body in the doc shape, and the writer keys on `docId`
      // separately.
      const body = row as unknown as DocumentData;
      await writer.commit({
        op: "I",
        collection: args.table,
        docId: id,
        body,
      });
      count++;
    }
    emitSuccess({
      command: "admin.restore",
      status: "ok",
      table: args.table,
      restored: count,
    });
    return 0;
  } catch (error) {
    if (error instanceof BaerlyError) {
      emitError("admin.restore", error.code, error.message);
      return errorToExitCode(error.code);
    }
    emitError("admin.restore", "Unknown", (error as Error).message);
    return 2;
  }
};

/** citty `defineCommand` block for `baerly admin restore`. */
export const restoreCmd = defineCommand({
  meta: {
    name: "restore",
    description: "Bulk-import canonical NDJSON into a fresh collection.",
  },
  args: RESTORE_ARGS,
  run: async ({ args }) => {
    const code = await handleRestore(args);
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
export const runRestore = async (argv: readonly string[]): Promise<number> => {
  let parsed: Args;
  try {
    parsed = parseArgs<typeof RESTORE_ARGS>(argv as string[], RESTORE_ARGS);
  } catch (error) {
    setJsonMode(argv.includes("--json"));
    emitError("admin.restore", "InvalidConfig", (error as Error).message);
    return 1;
  }
  return handleRestore(parsed);
};
