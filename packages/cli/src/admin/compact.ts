/**
 * `baerly admin compact` — manually trigger one maintenance pass
 * (compact + GC, configurable). Wraps `runScheduledMaintenance` from
 * `@baerly/server` and surfaces the per-phase result on the JSON
 * envelope.
 *
 * Production runs `runScheduledMaintenance` on a cron schedule (CF
 * Workers Cron Trigger, or pm2-driven `node-cron`). This subcommand
 * is the on-call escape hatch — fire a pass outside the schedule
 * after a known write storm, while iterating, or when validating a
 * profile choice from `--profile=`.
 *
 * Args:
 *   --bucket            Required. Bucket URI.
 *   --app               Default "app" (or `baerly.config.ts`).
 *   --tenant            Default "tenant" (or `baerly.config.ts`).
 *   --table             Required. Collection name.
 *   --profile           "cloudflare-free" | "cloudflare-paid" | "node".
 *                       Default "node".
 *   --skip-gc           Run compact only.
 *   --skip-compact      Run GC only.
 *   --min-entries       Override the active profile's
 *                       `minEntriesToCompact` threshold (non-negative
 *                       integer). Useful on brand-new buckets that
 *                       haven't yet accumulated the profile default.
 *   --json              JSON envelope.
 *
 * Exit codes:
 *   0 — pass completed.
 *   1 — InvalidConfig (bad bucket URI, unknown --profile, missing args).
 *   2 — Storage / Network error.
 *   3 — Protocol invariant (Conflict / Internal / InvalidResponse).
 */

import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { BaerlyError } from "@baerly/protocol";
import {
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  NODE_PROFILE,
  runScheduledMaintenance,
  type MaintenanceOptions,
} from "@baerly/server/maintenance";
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
  profile: {
    type: "string",
    required: false,
    default: "node",
    description: "Maintenance profile: cloudflare-free | cloudflare-paid | node.",
    valueHint: "cloudflare-free|cloudflare-paid|node",
  },
  "skip-gc": {
    type: "boolean",
    description: "Run compact only (skip GC).",
  },
  "skip-compact": {
    type: "boolean",
    description: "Run GC only (skip compact).",
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
  "profile",
  "skip-gc",
  "skip-compact",
  "min-entries",
  "json",
  "_",
]);

const PROFILES: Record<string, MaintenanceOptions> = {
  "cloudflare-free": CLOUDFLARE_FREE_TIER,
  "cloudflare-paid": CLOUDFLARE_PAID_TIER,
  node: NODE_PROFILE,
};

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") return 1;
  if (code === "Conflict" || code === "Internal" || code === "InvalidResponse") return 3;
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
    const profile = PROFILES[args.profile];
    if (profile === undefined) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly admin compact: unknown --profile=${JSON.stringify(args.profile)} — expected cloudflare-free | cloudflare-paid | node`,
      );
    }
    if (args["skip-gc"] === true && args["skip-compact"] === true) {
      throw new BaerlyError(
        "InvalidConfig",
        "baerly admin compact: --skip-gc and --skip-compact are mutually exclusive (the pass would be a no-op)",
      );
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
    const options: MaintenanceOptions = {
      ...profile,
      ...(args["skip-gc"] === true && { skipGc: true }),
      ...(args["skip-compact"] === true && { skipCompact: true }),
      ...(minEntriesOverride !== undefined && {
        compact: { ...profile.compact, minEntriesToCompact: minEntriesOverride },
      }),
    };
    const result = await runScheduledMaintenance(
      { storage: bucket.storage, currentJsonKey },
      options,
    );
    emitSuccess({
      command: "admin.compact",
      status: "ok",
      table: args.table,
      profile: args.profile,
      compact:
        result.compact === null
          ? null
          : {
              written: result.compact.written,
              skipped_reason: result.compact.skippedReason ?? null,
              entries_folded: result.compact.entriesFolded,
              log_seq_start_before: result.compact.logSeqStartBefore,
              log_seq_start_after: result.compact.logSeqStartAfter,
              previous_snapshot_key: result.compact.previousSnapshotKey,
              new_snapshot_key: result.compact.newSnapshotKey ?? null,
            },
      gc:
        result.gc === null
          ? null
          : {
              marked: result.gc.marked,
              swept: result.gc.swept,
            },
    });
    return 0;
  } catch (err) {
    if (err instanceof BaerlyError) {
      emitError("admin.compact", err.code, err.message);
      return errorToExitCode(err.code);
    }
    emitError("admin.compact", "Unknown", (err as Error).message);
    return 2;
  }
};

/** citty `defineCommand` block for `baerly admin compact`. */
export const compactCmd = defineCommand({
  meta: {
    name: "compact",
    description: "Manually trigger one maintenance pass (compact + GC).",
  },
  args: COMPACT_ARGS,
  run: async ({ args }) => {
    const code = await handleCompact(args);
    if (code !== 0) process.exit(code);
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
  } catch (err) {
    setJsonMode(argv.includes("--json"));
    emitError("admin.compact", "InvalidConfig", (err as Error).message);
    return 1;
  }
  return handleCompact(parsed);
};
