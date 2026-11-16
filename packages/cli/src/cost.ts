/**
 * `baerly cost` — bounded cost trajectory for one collection.
 *
 * Samples the live log tail, projects monthly Class A write operations,
 * and reports a stable provider-cost band. Storage and other account
 * usage are explicit assumptions, not observed inputs.
 *
 * Args:
 *   --bucket      Required. Bucket URI.
 *   --app         Required (or via baerly.config.ts).
 *   --tenant      Required (or via baerly.config.ts).
 *   --collection  Required. Collection name.
 *   --provider    Optional pricing provider override:
 *                 r2 | aws-s3 | gcs | self-hosted | dev.
 *   --profile     Optional host profile override: cf-free | node.
 *   --json        JSON envelope.
 *
 * Cost shape:
 *   1 GET for current.json + bounded galloping/binary tail probes
 *   + up to 120 trailing log GETs. No log LIST; historical depth does
 *   not change the sample window.
 *
 * Exit codes:
 *   0 — projection rendered.
 *   1 — InvalidConfig (bad bucket URI, missing args, unknown flag,
 *       insufficient log entries to estimate, dev backend).
 *   2 — Storage / Network error.
 *   3 — Protocol invariant / conflict (WriteConflict / AlreadyExists /
 *       Internal / InvalidResponse / AmbiguousCommit).
 */

import { type ArgsDef } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { parseBucketUri } from "./bucket-uri.ts";
import { emitSuccess, isJsonMode } from "./output.ts";
import {
  costProfileFor,
  defaultCostProfileFor,
  detectProvider,
  pricingFor,
  type ProviderTag,
} from "./cost/provider.ts";
import {
  project,
  type CostProfileTag,
  type ProjectedUsdBand,
  type Trajectory,
} from "./cost/project.ts";
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
      "Override pricing provider (r2|aws-s3|gcs|self-hosted|dev). Auto-detected from bucket URI + BAERLY_S3_ENDPOINT.",
    valueHint: "r2|aws-s3|gcs|self-hosted|dev",
  },
  profile: {
    type: "string",
    required: false,
    description:
      "Override host maintenance profile (cf-free|node). Inferred as cf-free for R2 and node otherwise.",
    valueHint: "cf-free|node",
  },
  json: JSON_ARG,
} as const satisfies ArgsDef;

const PROVIDER_TAGS: ReadonlySet<string> = new Set(["r2", "aws-s3", "gcs", "self-hosted", "dev"]);
const PROFILE_TAGS: ReadonlySet<string> = new Set(["cf-free", "node"]);

const GCS_PRICING_BASIS = {
  storageClass: "Standard",
  namespace: "flat",
  locationPricing: "regional",
  freeAllowance: {
    classAOperationsPerMonth: 5_000,
    storageGbMonth: 5,
    eligibleRegions: ["us-west1", "us-central1", "us-east1"],
  },
} as const;

const GCS_UNMODELED = [
  "hierarchical-namespace",
  "dual-or-multi-region-pricing",
  "egress",
  "soft-delete-retention",
] as const;

/** Compact `1.5M` / `22k` / `842` rendering for Class A op counts. */
const formatOps = (n: number): string => {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}k`;
  }
  return n.toFixed(0);
};

const providerDisplayName = (provider: ProviderTag): string => {
  switch (provider) {
    case "r2": {
      return "R2";
    }
    case "aws-s3": {
      return "S3";
    }
    case "gcs": {
      return "GCS";
    }
    case "self-hosted": {
      return "self-hosted";
    }
    case "dev": {
      return "dev";
    }
  }
};

const renderUsdBand = (band: ProjectedUsdBand): string => {
  if (band === "$0") {
    return "$0";
  }
  if (band === "<$25") {
    return "<$25/mo";
  }
  return `~${band}/mo`;
};

/** Advisory rendered after 100 writes/min and before the hard trigger. */
const renderAdvisoryLine = (trajectory: Trajectory): string => {
  if (trajectory.percentOfAdvisory < 100 || trajectory.percentOfGraduation >= 100) {
    return "";
  }
  if (trajectory.projectedUsdBand === null) {
    return (
      `  advisory:            ~100 writes/min crossed. Object storage buys zero ops, no on-call,\n` +
      `                       no migration; a managed DB trades those dollars for schema + SQL + ops.\n` +
      `                       Hard graduation trigger: 50M Class A/mo. Self-hosted — bill model not modelled.\n`
    );
  }
  const atAdvisory = project(
    100,
    0,
    pricingFor(trajectory.provider),
    costProfileFor(trajectory.profile),
  );
  const costNote = `${renderUsdBand(atAdvisory!.projectedUsdBand!)} on ${providerDisplayName(trajectory.provider)}`;
  return (
    `  advisory:            ~100 writes/min crossed (${costNote}, object-storage ops). Object storage buys\n` +
    `                       zero ops, no on-call, and no migration for your bytes. A managed DB trades those\n` +
    `                       dollars for a schema, SQL, and an ops surface. Review if that tradeoff\n` +
    `                       makes sense for your workload. Hard graduation trigger: 50M Class A/mo.\n`
  );
};

const renderTrajectory = (trajectory: Trajectory): string => {
  const writesPerMin = trajectory.writesPerMin.toFixed(trajectory.writesPerMin < 10 ? 1 : 0);
  const classA = formatOps(trajectory.classAPerMonth);
  if (trajectory.projectedUsdBand === null) {
    const advisory = renderAdvisoryLine(trajectory);
    return [
      `  trajectory:          ~${writesPerMin} writes/min  →  ~${classA} Class A/mo`,
      `                       ${trajectory.percentOfGraduation.toFixed(2)}% of 50M/mo graduation trigger. Self-hosted — bill model not modelled.`,
      ...(advisory ? [advisory] : []),
    ].join("\n");
  }

  const providerLabel = providerDisplayName(trajectory.provider);
  const usd = trajectory.withinFreeTier
    ? `${renderUsdBand(trajectory.projectedUsdBand)} (${providerLabel} free tier)`
    : renderUsdBand(trajectory.projectedUsdBand);
  const tail = trajectory.withinFreeTier
    ? `${trajectory.percentOfFreeTier!.toFixed(0)}% of free-tier Class A budget. ${trajectory.percentOfFreeTier! < 50 ? "Well inside the promise." : "Approaching free-tier ceiling."}`
    : `${trajectory.percentOfGraduation.toFixed(2)}% of 50M/mo graduation trigger.`;
  const advisory = renderAdvisoryLine(trajectory);
  return [
    `  trajectory:          ~${writesPerMin} writes/min  →  ~${classA} Class A/mo  →  ${usd}`,
    `                       ${tail}`,
    ...(advisory ? [advisory] : []),
  ].join("\n");
};

const bundle = defineBaerlySubcommand({
  name: "cost",
  meta: {
    description: "Project a collection's monthly Class A write-operation trajectory.",
  },
  args: COST_ARGS,
  handler: async (args, ctx) => {
    if (typeof args.provider === "string" && args.provider.length > 0) {
      if (!PROVIDER_TAGS.has(args.provider)) {
        throw new BaerlyError(
          "InvalidConfig",
          `baerly cost: --provider must be one of r2|aws-s3|gcs|self-hosted|dev (got ${JSON.stringify(args.provider)})`,
        );
      }
    }
    if (typeof args.profile === "string" && args.profile.length > 0) {
      if (!PROFILE_TAGS.has(args.profile)) {
        throw new BaerlyError(
          "InvalidConfig",
          `baerly cost: --profile must be one of cf-free|node (got ${JSON.stringify(args.profile)})`,
        );
      }
    }

    const bucket = await parseBucketUri(args.bucket);
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    assertCollectionArg(args.collection, "baerly cost");

    const providerOverride =
      typeof args.provider === "string" && args.provider.length > 0
        ? (args.provider as ProviderTag)
        : undefined;
    const provider = detectProvider({
      bucketUri: args.bucket,
      s3Endpoint: process.env["BAERLY_S3_ENDPOINT"],
      override: providerOverride,
    });
    if (provider === "dev") {
      throw new BaerlyError(
        "InvalidConfig",
        "baerly cost: dev backends (file://, memory://) have no $ model; pass --provider=r2|aws-s3|gcs|self-hosted to project against one.",
      );
    }

    const profileOverride =
      typeof args.profile === "string" && args.profile.length > 0
        ? (args.profile as CostProfileTag)
        : undefined;
    const profileTag = profileOverride ?? defaultCostProfileFor(provider);

    const verdict = await estimateWritesPerMin(bucket.storage, app, tenant, args.collection, {
      keyPrefix: bucket.keyPrefix,
    });
    const trajectory = project(
      verdict.writesPerMin,
      0,
      pricingFor(provider),
      costProfileFor(profileTag),
    );
    if (trajectory === null) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly cost: not enough log entries under ${args.collection} to estimate writes/min (need >= 2)`,
      );
    }

    const scope = {
      kind: "collection" as const,
      collection: args.collection,
      includesOtherAccountUsage: false as const,
      includesStoredBytes: false as const,
    };
    const commonAssumptions = {
      pricingProvider: provider,
      maintenanceProfile: profileTag,
      maintenanceProfileSource:
        profileOverride === undefined ? ("inferred" as const) : ("explicit" as const),
      otherAccountClassAPerMonth: 0,
      storedBytes: 0,
    };
    const assumptions =
      provider === "gcs"
        ? {
            ...commonAssumptions,
            pricingBasis: GCS_PRICING_BASIS,
            unmodeled: GCS_UNMODELED,
          }
        : commonAssumptions;

    if (isJsonMode()) {
      emitSuccess({ command: "cost", collection: args.collection, scope, assumptions, trajectory });
    } else {
      process.stdout.write(
        `baerly cost ${args.collection}\n` +
          `  scope:               selected collection only; storage and other account usage excluded\n` +
          `  assumptions:         provider=${provider}; profile=${profileTag} (${assumptions.maintenanceProfileSource}); free-tier and dollar projection assumes 0 other account Class A ops and 0 stored bytes\n` +
          (provider === "gcs"
            ? `  GCS pricing basis:   GCS Standard storage; flat namespace; regional pricing\n` +
              `                       5,000 Class A ops and 5 GB-month free allowance assumes us-west1, us-central1, or us-east1\n` +
              `                       actual HNS, dual/multi-region pricing, egress, and soft-delete retention are not detected or modeled\n`
            : "") +
          `${renderTrajectory(trajectory)}\n`,
      );
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
