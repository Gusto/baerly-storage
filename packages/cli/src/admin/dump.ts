/**
 * `baerly admin dump` — canonical NDJSON of the materialised view.
 *
 * Writes one row per line to stdout, in a strict byte-stable shape so
 * two semantically-equal collections produce byte-equal output. Tests
 * and other programmatic callers can divert the NDJSON output to a
 * file or buffer by passing `{ streams: { stdout } }` to {@link runDump}.
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
 *   --collection Required. Collection name.
 *   --recover-legacy-names Select only this exact stored collection
 *              spelling in a mixed legacy log. Snapshot validation
 *              remains strict; historical completeness is not guaranteed.
 *   --json     JSON envelope (on stdout). Its `legacy` field is the
 *              migration preflight: `non_nfc_names` (roles),
 *              `non_nfc_ids`, and `twin_ids` (groups of canonically-
 *              equivalent `_id`s). Text mode prints the same as
 *              warnings on stderr. Every row is exported either way. Programmatic callers can
 *              divert the NDJSON body to a separate writable via the
 *              `streams.stdout` option on {@link runDump}.
 *
 * Exit codes:
 *   0 — dump completed.
 *   1 — InvalidConfig (bad bucket URI, missing args).
 *   2 — Storage / Network / Internal protocol violation.
 *   3 — Protocol invariant / conflict (WriteConflict / AlreadyExists /
 *       Internal / InvalidResponse / AmbiguousCommit).
 */

import { type Writable } from "node:stream";
import { type ArgsDef } from "citty";
import { BaerlyError, type DocumentValue, type DocumentData } from "@baerly/protocol";
import { loadMaterialisedView } from "../export/index.ts";
import { parseBucketUri } from "../bucket-uri.ts";
import {
  LEGACY_ID_MIGRATION,
  LEGACY_NAME_MIGRATION,
  type LegacyIdReport,
  legacyIdReport,
  type NameRole,
  nonNfcNames,
} from "../legacy-names.ts";
import { emitSuccess, isJsonMode } from "../output.ts";
import {
  APP_ARG,
  assertCollectionArg,
  BUCKET_ARG,
  COLLECTION_ARG,
  defineBaerlySubcommand,
  JSON_ARG,
  TENANT_ARG,
} from "../subcommand.ts";

const DUMP_ARGS = {
  bucket: BUCKET_ARG,
  app: APP_ARG,
  tenant: TENANT_ARG,
  collection: COLLECTION_ARG,
  "recover-legacy-names": {
    type: "boolean",
    description:
      "Recover one exact collection spelling from a mixed legacy log; requires a matching snapshot and cannot recover previously discarded data.",
  },
  json: JSON_ARG,
} as const satisfies ArgsDef;

/**
 * Recursive byte-stable JSON stringifier. Object keys at every nesting
 * level are sorted ASCII-lex; array element order is preserved as-is.
 * Numbers must be finite (protocol forbids NaN / Infinity in bodies).
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
    const parts = value.map((v) => canonicalStringify(v));
    return `[${parts.join(",")}]`;
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

/**
 * Drain rows to the supplied writable, applying back-pressure on every
 * line. We don't `end()` the stream — the caller owns its lifecycle
 * (`process.stdout` shouldn't be closed; a test-supplied
 * `createWriteStream` flushes on its own `end()`).
 */
const writeToSink = async (
  sink: Writable,
  rows: ReadonlyMap<string, DocumentData>,
): Promise<number> => {
  const ids = [...rows.keys()].toSorted();
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
    if (!sink.write(line)) {
      await new Promise<void>((resolve) => sink.once("drain", resolve));
    }
    count++;
  }
  return count;
};

/** Text-mode migration warnings on stderr; stdout carries the NDJSON. */
const warnLegacy = (legacy: LegacyIdReport & { non_nfc_names: readonly NameRole[] }): void => {
  const lines: string[] = [];
  if (legacy.non_nfc_names.length > 0) {
    lines.push(`non-NFC ${legacy.non_nfc_names.join(", ")} name: ${LEGACY_NAME_MIGRATION}`);
  }
  if (legacy.non_nfc_ids.length > 0) {
    lines.push(
      `${legacy.non_nfc_ids.length} non-NFC _id(s) ${JSON.stringify(legacy.non_nfc_ids)}: ${LEGACY_ID_MIGRATION}`,
    );
  }
  for (const group of legacy.twin_ids) {
    lines.push(
      `canonically-equivalent twin _ids ${JSON.stringify(group)} share index markers on R2: ${LEGACY_ID_MIGRATION}`,
    );
  }
  for (const line of lines) {
    process.stderr.write(`baerly admin dump: warning: ${line}\n`);
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
    assertCollectionArg(args.collection, "baerly admin dump");
    const currentJsonKey = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.collection}/current.json`;
    const view = await loadMaterialisedView({
      storage: bucket.storage,
      currentJsonKey,
      collection: args.collection,
      recoverLegacyNames: args["recover-legacy-names"] === true,
    });
    if (view === null) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly admin dump: current.json not found at ${currentJsonKey}`,
      );
    }
    const sink: Writable = ctx.streams?.stdout ?? process.stdout;
    const count = await writeToSink(sink, view);
    // Migration preflight. Every row is still exported; this reports
    // what `admin restore` (which requires NFC names and `_id`s) needs
    // changed first.
    const legacy = {
      non_nfc_names: nonNfcNames({ app, tenant, collection: args.collection }),
      ...legacyIdReport(view.keys()),
    };
    if (!isJsonMode()) {
      warnLegacy(legacy);
      if (args["recover-legacy-names"] === true) {
        process.stderr.write(
          "baerly admin dump: warning: recovery selects only the exact stored collection spelling; historical completeness is not guaranteed. Rows discarded by earlier compaction cannot be recovered. Keep a copy of the source bucket.\n",
        );
      }
    }
    emitSuccess({
      command: "admin.dump",
      status: "ok",
      collection: args.collection,
      dumped: count,
      legacy,
      ...(args["recover-legacy-names"] === true && {
        recovery: { collection_match: "exact", historical_completeness: "not_guaranteed" },
      }),
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
