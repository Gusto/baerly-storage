/**
 * `baerly cost` — projected cost trajectory for one collection.
 *
 * Sniffs the writes/min rate over the trailing log sample for one
 * collection and projects it into a free-tier-aware monthly Class A
 * + storage cost projection vs. the M-size graduation trigger
 * (50M Class A/mo). Read-only; never mutates anything.
 *
 * Args:
 *   --bucket    Required. Bucket URI.
 *   --app       Required (or via baerly.config.ts).
 *   --tenant    Required (or via baerly.config.ts).
 *   --collection Required. Collection name.
 *   --provider  Optional. r2 | aws-s3 | self-hosted | dev. Overrides
 *               the auto-detected provider (bucket URI +
 *               BAERLY_S3_ENDPOINT).
 *   --json      JSON envelope.
 *
 * Cost shape:
 *   ceil(logKeys/1000) LIST pages over the log/ prefix (1 for typical
 *     logs; more only for deep, uncompacted logs — R2/S3 list pages cap
 *     at 1000 keys)
 *   + up to 120 GETs for trailing log entries (`SAMPLE_SIZE`)
 *
 * Exit codes:
 *   0 — projection rendered.
 *   1 — InvalidConfig (bad bucket URI, missing args, unknown flag,
 *       insufficient log entries to estimate, dev backend).
 *   2 — Storage / Network error.
 *   3 — Protocol invariant (Conflict / Internal / InvalidResponse).
 */

import { type ArgsDef } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { parseBucketUri } from "./bucket-uri.ts";
import { emitSuccess, isJsonMode } from "./output.ts";
import { detectProvider, pricingFor, type ProviderTag } from "./cost/provider.ts";
import { project, type Trajectory } from "./cost/project.ts";
import { estimateWritesPerMin } from "./admin/usage.ts";
import {
  APP_ARG,
  assertCollectionArg,
  BUCKET_ARG,
  COLLECTION_ARG,
  defineBaerlySubcommand,
  JSON_ARG,
  TENANT_ARG,
} from "./subcommand.ts";

const COST_ARGS = {
  bucket: BUCKET_ARG,
  app: APP_ARG,
  tenant: TENANT_ARG,
  collection: COLLECTION_ARG,
  provider: {
    type: "string",
    required: false,
    description:
      "Override pricing provider (r2|aws-s3|self-hosted|dev). Auto-detected from bucket URI + BAERLY_S3_ENDPOINT.",
    valueHint: "r2|aws-s3|self-hosted|dev",
  },
  json: JSON_ARG,
} as const satisfies ArgsDef;

/** Compact "1.5M" / "22k" / "842" rendering for Class A op counts. */
const formatOps = (n: number): string => {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}k`;
  }
  return n.toFixed(0);
};

/** Advisory line rendered when past 100 writes/min but under the 50M/mo graduation trigger. */
const renderAdvisoryLine = (t: Trajectory): string => {
  if (t.percentOfAdvisory < 100 || t.percentOfGraduation >= 100) {
    return "";
  }
  if (t.projectedUsdPerMonth === null) {
    return (
      `  advisory:            ~100 writes/min crossed. Object storage buys zero ops, no on-call,\n` +
      `                       no migration; a managed DB trades those dollars for schema + SQL + ops.\n` +
      `                       Hard graduation trigger: 50M Class A/mo. Self-hosted — bill model not modelled.\n`
    );
  }
  const costNote = t.provider === "r2" ? "~$54/mo on R2" : "~$86/mo on S3";
  return (
    `  advisory:            ~100 writes/min crossed (${costNote}, object-storage ops). Object storage buys\n` +
    `                       zero ops, no on-call, and no migration for your bytes. A managed DB trades those\n` +
    `                       dollars for a schema, SQL, and an ops surface. Review if that tradeoff\n` +
    `                       makes sense for your workload. Hard graduation trigger: 50M Class A/mo.\n`
  );
};

/** Two-line trajectory block. Three output states per design spec §4.2. */
const renderTrajectory = (t: Trajectory): string => {
  const wpm = t.writesPerMin.toFixed(t.writesPerMin < 10 ? 1 : 0);
  const classA = formatOps(t.classAPerMonth);
  // State 2: ops-only — provider known but no $ model. Today only
  // self-hosted reaches this (dev is filtered out upstream).
  if (t.projectedUsdPerMonth === null) {
    const advisory = renderAdvisoryLine(t);
    return [
      `  trajectory:          ~${wpm} writes/min  →  ~${classA} Class A/mo`,
      `                       ${t.percentOfGraduation.toFixed(2)}% of 50M/mo graduation trigger. Self-hosted — bill model not modelled.`,
      ...(advisory ? [advisory] : []),
    ].join("\n");
  }
  // Only "r2" can reach withinFreeTier===true (aws-s3 has freeClassAPerMonth: 0).
  // self-hosted/dev are filtered upstream.
  const usd = t.withinFreeTier
    ? `~$0 (R2 free tier)`
    : `~$${t.projectedUsdPerMonth!.toFixed(2)}/mo`;
  // Invariant: withinFreeTier===true implies pricing.freeClassAPerMonth>0,
  // which in turn implies percentOfFreeTier!==null (see project.ts).
  const tail = t.withinFreeTier
    ? `${t.percentOfFreeTier!.toFixed(0)}% of free-tier Class A budget. ${t.percentOfFreeTier! < 50 ? "Well inside the promise." : "Approaching free-tier ceiling."}`
    : `${t.percentOfGraduation.toFixed(2)}% of 50M/mo graduation trigger.`;
  const advisory = renderAdvisoryLine(t);
  return [
    `  trajectory:          ~${wpm} writes/min  →  ~${classA} Class A/mo  →  ${usd}`,
    `                       ${tail}`,
    ...(advisory ? [advisory] : []),
  ].join("\n");
};

const PROVIDER_TAGS: ReadonlySet<string> = new Set(["r2", "aws-s3", "self-hosted", "dev"]);

const bundle = defineBaerlySubcommand({
  name: "cost",
  meta: {
    description: "Project a collection's monthly Class A + storage cost trajectory.",
  },
  args: COST_ARGS,
  handler: async (args, ctx) => {
    if (typeof args.provider === "string" && args.provider.length > 0) {
      if (!PROVIDER_TAGS.has(args.provider)) {
        throw new BaerlyError(
          "InvalidConfig",
          `baerly cost: --provider must be one of r2|aws-s3|self-hosted|dev (got ${JSON.stringify(args.provider)})`,
        );
      }
    }
    const bucket = await parseBucketUri(args.bucket);
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    assertCollectionArg(args.collection, "baerly cost");

    const override =
      typeof args.provider === "string" && args.provider.length > 0
        ? (args.provider as ProviderTag)
        : undefined;
    const provider = detectProvider({
      bucketUri: args.bucket,
      s3Endpoint: process.env["BAERLY_S3_ENDPOINT"],
      override,
    });
    if (provider === "dev") {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly cost: dev backends (file://, memory://) have no $ model; pass --provider=r2|aws-s3|self-hosted to project against one.`,
      );
    }

    const verdict = await estimateWritesPerMin(bucket.storage, app, tenant, args.collection, {
      keyPrefix: bucket.keyPrefix,
    });
    const trajectory = project(verdict.writesPerMin, 0, pricingFor(provider));
    if (trajectory === null) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly cost: not enough log entries under ${args.collection} to estimate writes/min (need >= 2)`,
      );
    }

    if (isJsonMode()) {
      emitSuccess({ command: "cost", collection: args.collection, trajectory });
    } else {
      process.stdout.write(`baerly cost ${args.collection}\n${renderTrajectory(trajectory)}\n`);
    }
    return 0;
  },
});

/** citty `defineCommand` block for `baerly cost`. */
export const cost = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runCost = bundle.run;
