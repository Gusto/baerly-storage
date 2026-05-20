/**
 * `baerly admin compact` — manually trigger one compact pass (fold
 * log entries into a new snapshot). Wraps `compact()` from
 * `@baerly/server/maintenance` and surfaces the per-phase result on
 * the JSON envelope.
 *
 * Production runs `runScheduledMaintenance` on a cron schedule (CF
 * Workers Cron Trigger, or pm2-driven `node-cron`). This subcommand
 * is the on-call escape hatch — fire a compact pass outside the
 * schedule after a known write storm, while iterating, or when
 * forcing compaction on a freshly-seeded bucket that hasn't yet
 * tripped the default `minEntriesToCompact` threshold.
 *
 * Args:
 *   --bucket               Required. Bucket URI.
 *   --app                  Default "app" (or `baerly.config.ts`).
 *   --tenant               Default "tenant" (or `baerly.config.ts`).
 *   --table                Required. Collection name.
 *   --cloudflare-free-tier Apply the CF free-tier compact caps
 *                          (maxEntriesPerRun=20, minEntriesToCompact=50).
 *   --min-entries          Override the active profile's
 *                          `minEntriesToCompact` threshold (non-negative
 *                          integer). Useful on brand-new buckets that
 *                          haven't yet accumulated the profile default.
 *   --json                 JSON envelope.
 *
 * Exit codes:
 *   0 — compact pass completed.
 *   1 — InvalidConfig (bad bucket URI, missing args, bad flag).
 *   2 — Storage / Network error.
 *   3 — Protocol invariant (Conflict / Internal / InvalidResponse).
 */

import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { CLOUDFLARE_FREE_TIER, type CompactOptions, compact } from "@baerly/server/maintenance";
import { loadAppConfig } from "../config.ts";
import { parseBucketUri } from "../copy.ts";
import { emitError, emitSuccess, setJsonMode } from "../output.ts";

const COMPACT_ARGS = {
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
  "cloudflare-free-tier": {
    type: "boolean",
    description:
      "Apply the Cloudflare free-tier compact caps (maxEntriesPerRun=20, minEntriesToCompact=50).",
  },
  "min-entries": {
    type: "string",
    required: false,
    description:
      "Override the active profile's minEntriesToCompact (compact regardless of live-tail length).",
    valueHint: "int",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

type Args = ParsedArgs<typeof COMPACT_ARGS>;

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "bucket",
  "app",
  "tenant",
  "table",
  "cloudflare-free-tier",
  "min-entries",
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

const handleCompact = async (args: Args): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly admin compact: unknown flag --${k}`);
      }
    }
    let minEntriesOverride: number | undefined;
    if (typeof args["min-entries"] === "string") {
      const raw = args["min-entries"];
      const parsed = Number.parseInt(raw, 10);
      if (
        !Number.isFinite(parsed) ||
        !Number.isInteger(parsed) ||
        parsed < 0 ||
        String(parsed) !== raw.trim()
      ) {
        throw new BaerlyError(
          "InvalidConfig",
          `baerly admin compact: --min-entries must be a non-negative integer (got ${JSON.stringify(raw)})`,
        );
      }
      minEntriesOverride = parsed;
    }
    const { app, tenant } = await resolveAppTenant(args);
    const bucket = await parseBucketUri(args.bucket);
    const currentJsonKey = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.table}/current.json`;
    // `CLOUDFLARE_FREE_TIER` is typed as `MaintenanceOptions` but its
    // `.compact` field carries the internal `maxEntriesPerRun` cap on
    // the runtime object; spreading it forwards that cap to `compact()`.
    const baseCompact: CompactOptions =
      args["cloudflare-free-tier"] === true ? (CLOUDFLARE_FREE_TIER.compact ?? {}) : {};
    const options: CompactOptions = {
      ...baseCompact,
      ...(minEntriesOverride !== undefined && { minEntriesToCompact: minEntriesOverride }),
    };
    const result = await compact({ storage: bucket.storage, currentJsonKey }, options);
    emitSuccess({
      command: "admin.compact",
      status: "ok",
      table: args.table,
      compact: {
        written: result.written,
        skipped_reason: result.skippedReason ?? null,
        entries_folded: result.entriesFolded,
        log_seq_start_before: result.logSeqStartBefore,
        log_seq_start_after: result.logSeqStartAfter,
        previous_snapshot_key: result.previousSnapshotKey,
        new_snapshot_key: result.newSnapshotKey ?? null,
      },
    });
    return 0;
  } catch (error) {
    if (error instanceof BaerlyError) {
      emitError("admin.compact", error.code, error.message);
      return errorToExitCode(error.code);
    }
    emitError("admin.compact", "Unknown", (error as Error).message);
    return 2;
  }
};

/** citty `defineCommand` block for `baerly admin compact`. */
export const compactCmd = defineCommand({
  meta: {
    name: "compact",
    description: "Manually trigger one compact pass (fold log entries into a new snapshot).",
  },
  args: COMPACT_ARGS,
  run: async ({ args }) => {
    const code = await handleCompact(args);
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
export const runCompact = async (argv: readonly string[]): Promise<number> => {
  let parsed: Args;
  try {
    parsed = parseArgs<typeof COMPACT_ARGS>(argv as string[], COMPACT_ARGS);
  } catch (error) {
    setJsonMode(argv.includes("--json"));
    emitError("admin.compact", "InvalidConfig", (error as Error).message);
    return 1;
  }
  return handleCompact(parsed);
};
