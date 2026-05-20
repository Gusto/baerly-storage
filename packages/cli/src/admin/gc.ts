/**
 * `baerly admin gc` — manually trigger one GC pass (mark + sweep
 * orphan blobs). Wraps `runGc()` from `@baerly/server/maintenance`
 * and surfaces the result on the JSON envelope.
 *
 * Production runs `runScheduledMaintenance` on a cron schedule (CF
 * Workers Cron Trigger, or pm2-driven `node-cron`). This subcommand
 * is the on-call escape hatch — fire a GC pass outside the schedule
 * to drain the orphan-blob queue or to validate cap behavior.
 *
 * Note that newly-marked candidates are only swept after the
 * GC_GRACE_PERIOD_MILLIS window has elapsed (7 days by default), so
 * back-to-back invocations on a fresh bucket will mark but not sweep.
 *
 * Args:
 *   --bucket               Required. Bucket URI.
 *   --app                  Required (or via baerly.config.ts).
 *   --tenant               Required (or via baerly.config.ts).
 *   --table                Required. Collection name.
 *   --cloudflare-free-tier Apply the CF free-tier GC caps
 *                          (maxMarksPerRun=20, maxSweepsPerRun=10).
 *   --json                 JSON envelope.
 *
 * Exit codes:
 *   0 — GC pass completed.
 *   1 — InvalidConfig (bad bucket URI, missing args, bad flag).
 *   2 — Storage / Network error.
 *   3 — Protocol invariant (Conflict / Internal / InvalidResponse).
 */

import { type ArgsDef } from "citty";
import {
  CLOUDFLARE_FREE_TIER,
  type RunGcOptions,
  runGc as runGcEngine,
} from "@baerly/server/maintenance";
import { parseBucketUri } from "../bucket-uri.ts";
import { emitSuccess } from "../output.ts";
import { defineBaerlySubcommand } from "../subcommand.ts";

const GC_ARGS = {
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
  "cloudflare-free-tier": {
    type: "boolean",
    description: "Apply the Cloudflare free-tier GC caps (maxMarksPerRun=20, maxSweepsPerRun=10).",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

const bundle = defineBaerlySubcommand({
  name: "admin.gc",
  meta: {
    description: "Manually trigger one GC pass (mark + sweep orphan blobs).",
  },
  args: GC_ARGS,
  handler: async (args, ctx) => {
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    const bucket = await parseBucketUri(args.bucket);
    const currentJsonKey = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.table}/current.json`;
    // `CLOUDFLARE_FREE_TIER` is typed as `MaintenanceOptions` but its
    // `.gc` field carries the internal `maxMarksPerRun` /
    // `maxSweepsPerRun` caps on the runtime object; spreading it
    // forwards those caps to `runGc()`.
    const options: RunGcOptions =
      args["cloudflare-free-tier"] === true ? (CLOUDFLARE_FREE_TIER.gc ?? {}) : {};
    const result = await runGcEngine({ storage: bucket.storage, currentJsonKey }, options);
    emitSuccess({
      command: "admin.gc",
      status: "ok",
      table: args.table,
      gc: {
        marked: {
          stale_log: result.marked.stale_log,
          orphan_snapshot: result.marked.orphan_snapshot,
          orphan_content: result.marked.orphan_content,
        },
        swept: result.swept,
        pendingDepth: result.pendingDepth,
      },
    });
    return 0;
  },
});

/** citty `defineCommand` block for `baerly admin gc`. */
export const gcCmd = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 *
 * Named `runGc` for symmetry with peer subcommands; the underlying
 * `runGc` from `@baerly/server/maintenance` is imported as
 * `runGcEngine` to avoid the shadow.
 */
export const runGc = bundle.run;
