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
 *   --app      Required (or via baerly.config.ts).
 *   --tenant   Required (or via baerly.config.ts).
 *   --table    Required. Collection name.
 *   --json     JSON envelope (on stdout). Mutually informative with the
 *              NDJSON output: when --json is set the NDJSON body is
 *              redirected to `BAERLY_DUMP_STDOUT_PATH` (or rejected).
 *
 * Exit codes:
 *   0 — dump completed.
 *   1 — InvalidConfig (bad bucket URI, missing args).
 *   2 — Storage / Network / Internal protocol violation.
 *   3 — Protocol invariant (Conflict / Internal / InvalidResponse).
 */

import { open, type FileHandle } from "node:fs/promises";
import { type ArgsDef } from "citty";
import { BaerlyError, type DocumentValue, type DocumentData } from "@baerly/protocol";
import { loadMaterialisedView } from "../export/index.ts";
import { parseBucketUri } from "../bucket-uri.ts";
import { emitSuccess } from "../output.ts";
import { defineBaerlySubcommand } from "../subcommand.ts";

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
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

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

const bundle = defineBaerlySubcommand({
  name: "admin.dump",
  meta: {
    description: "Canonical NDJSON of the materialised view of one collection.",
  },
  args: DUMP_ARGS,
  handler: async (args, ctx) => {
    const bucket = await parseBucketUri(args.bucket);
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
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
  },
});

/** citty `defineCommand` block for `baerly admin dump`. */
export const dumpCmd = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runDump = bundle.run;
