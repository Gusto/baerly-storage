/**
 * `baerly inspect` — read-only summary for one collection.
 *
 * Args:
 *   --bucket   Required. Bucket URI.
 *   --app      Required (or via baerly.config.ts).
 *   --tenant   Required (or via baerly.config.ts).
 *   --table    Required. Collection name.
 *   --config   Optional path to baerly.config.{js,mjs,json} for index info.
 *   --json     JSON envelope.
 *
 * Reports, per-collection:
 *   - currentJsonKey path.
 *   - schema_version, next_seq, log_seq_start (default 0).
 *   - live_log_tail (= next_seq - log_seq_start).
 *   - snapshot key (or null).
 *   - writer_fence (epoch, owner, claimed_at).
 *   - materialised row count (via export/loadMaterialisedView).
 *   - per-declared-index key count (when --config supplied).
 *   - well-formed status: "ok" or "error" with an `errors` array.
 *
 * For projected monthly Class A / $ trajectories, use
 * `baerly cost --table=<name>` — the projection used to live as a
 * footer here but moved to its own verb so inspect stays a glance
 * command (no GET-storm over the trailing log sample).
 *
 * Cost shape:
 *   1 GET current.json
 *   + 1 GET snapshot (if any)
 *   + N GETs log tail (= next_seq - log_seq_start)
 *   + K LISTs (one per declared index, when --config supplied)
 *   + 1 LIST snapshot/ prefix (orphan detection)
 *
 * Never mutates anything.
 *
 * Exit codes:
 *   0 — inspection ran (status may be "ok" or "error"; both exit 0).
 *   1 — InvalidConfig (bad bucket URI, missing args, unknown flag).
 *   2 — Storage / Network error.
 *   3 — Protocol invariant (Conflict / Internal / InvalidResponse).
 */

import { type ArgsDef } from "citty";
import { BaerlyError, readCurrentJson, type CurrentJson, type Storage } from "@baerly/protocol";
import { loadMaterialisedView } from "./export/index.ts";
import { loadCollectionIndexes } from "./config.ts";
import { parseBucketUri } from "./bucket-uri.ts";
import { emitSuccess, isJsonMode } from "./output.ts";
import { defineBaerlySubcommand } from "./subcommand.ts";

const INSPECT_ARGS = {
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
  config: {
    type: "string",
    required: false,
    description:
      "Path to baerly.config.{js,mjs,json}; pulls declared indexes for key-count probes.",
    valueHint: "path",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

const countListEntries = async (
  storage: Storage,
  prefix: string,
): Promise<{ count: number; keys: string[] }> => {
  let count = 0;
  const keys: string[] = [];
  for await (const entry of storage.list(prefix)) {
    count++;
    keys.push(entry.key);
  }
  return { count, keys };
};

interface InspectResult {
  currentJsonKey: string;
  schema_version: number;
  next_seq: number;
  log_seq_start: number;
  live_log_tail: number;
  snapshot: string | null;
  writer_fence: CurrentJson["writer_fence"];
  materialised_rows: number;
  indexes: { name: string; count: number }[];
  status: "ok" | "error";
  errors: string[];
}

const renderText = (r: InspectResult, table: string): string => {
  const lines: string[] = [];
  lines.push(`baerly inspect ${table}`);
  lines.push(`  current.json:        ${r.currentJsonKey}`);
  lines.push(`  schema_version:      ${r.schema_version}`);
  lines.push(`  next_seq:            ${r.next_seq}`);
  lines.push(`  log_seq_start:       ${r.log_seq_start}`);
  lines.push(`  live_log_tail:       ${r.live_log_tail}`);
  lines.push(`  snapshot:            ${r.snapshot ?? "(none)"}`);
  lines.push(
    `  writer_fence:        epoch=${r.writer_fence.epoch} owner=${JSON.stringify(r.writer_fence.owner)} claimed_at=${JSON.stringify(r.writer_fence.claimed_at)}`,
  );
  lines.push(`  materialised_rows:   ${r.materialised_rows}`);
  if (r.indexes.length > 0) {
    const formatted = r.indexes.map((i) => `${i.name} (count=${i.count})`).join(", ");
    lines.push(`  indexes:             ${formatted}`);
  } else {
    lines.push(`  indexes:             (none declared)`);
  }
  lines.push(`  status:              ${r.status}`);
  if (r.errors.length > 0) {
    for (const e of r.errors) {
      lines.push(`  error:               ${e}`);
    }
  }
  return lines.join("\n") + "\n";
};

const bundle = defineBaerlySubcommand({
  name: "inspect",
  meta: {
    description: "Read-only summary of one collection's snapshot + log state.",
  },
  args: INSPECT_ARGS,
  handler: async (args, ctx) => {
    const bucket = await parseBucketUri(args.bucket);
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    const collectionPrefix = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.table}`;
    const currentJsonKey = `${collectionPrefix}/current.json`;

    const read = await readCurrentJson(bucket.storage, currentJsonKey);
    if (read === null) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly inspect: current.json not found at ${currentJsonKey}`,
      );
    }
    const cur = read.json;
    const log_seq_start = cur.log_seq_start ?? 0;

    const errors: string[] = [];
    let materialisedRows = 0;
    try {
      const view = await loadMaterialisedView({
        storage: bucket.storage,
        currentJsonKey,
        collection: args.table,
      });
      materialisedRows = view?.size ?? 0;
    } catch (error) {
      if (error instanceof BaerlyError) {
        errors.push(`${error.code}: ${error.message}`);
      } else {
        errors.push((error as Error).message);
      }
    }

    // Orphan-snapshot detection: list every file under <collectionPrefix>/snapshot/
    // and flag anything that isn't the currently-pointed-at snapshot.
    try {
      const snapshotPrefix = `${collectionPrefix}/snapshot/`;
      const { keys } = await countListEntries(bucket.storage, snapshotPrefix);
      for (const k of keys) {
        if (cur.snapshot !== k) {
          errors.push(`orphan snapshot: ${k}`);
        }
      }
    } catch (error) {
      if (error instanceof BaerlyError) {
        errors.push(`${error.code}: ${error.message}`);
      }
    }

    const indexes: { name: string; count: number }[] = [];
    if (typeof args.config === "string" && args.config.length > 0) {
      const defs = await loadCollectionIndexes(args.config, args.table, "baerly inspect");
      for (const def of defs) {
        const prefix = `${collectionPrefix}/index/${def.name}/`;
        const { count } = await countListEntries(bucket.storage, prefix);
        indexes.push({ name: def.name, count });
      }
    }

    const result: InspectResult = {
      currentJsonKey,
      schema_version: cur.schema_version,
      next_seq: cur.next_seq,
      log_seq_start,
      live_log_tail: cur.next_seq - log_seq_start,
      snapshot: cur.snapshot,
      writer_fence: cur.writer_fence,
      materialised_rows: materialisedRows,
      indexes,
      status: errors.length === 0 ? "ok" : "error",
      errors,
    };

    if (isJsonMode()) {
      emitSuccess({ command: "inspect", ...result });
    } else {
      process.stdout.write(renderText(result, args.table));
    }
    return 0;
  },
});

/** citty `defineCommand` block for `baerly inspect`. */
export const inspect = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runInspect = bundle.run;
