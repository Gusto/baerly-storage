/**
 * `baerly inspect` — read-only summary for one collection.
 *
 * Args:
 *   --bucket   Required. Bucket URI.
 *   --app      Default from baerly.config.ts; falls back to "app".
 *   --tenant   Default from baerly.config.ts; falls back to "tenant".
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
 *   - materialised row count (via @baerly/export's loadMaterialisedView).
 *   - per-declared-index key count (when --config supplied).
 *   - well-formed status: "ok" or "error" with an `errors` array.
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
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { BaerlyError, readCurrentJson, type CurrentJson, type Storage } from "@baerly/protocol";
import { loadMaterialisedView } from "@baerly/export";
import { type BaerlyConfig, type IndexDefinition } from "@baerly/server";
import { loadAppConfig } from "./config.ts";
import { parseBucketUri } from "./copy.ts";
import { emitError, emitSuccess, isJsonMode, setJsonMode } from "./output.ts";
import { detectProvider, pricingFor } from "./cost/provider.ts";
import { project, type Trajectory } from "./cost/project.ts";
import { estimateWritesPerMin } from "./doctor/usage.ts";

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
  config: {
    type: "string",
    required: false,
    description:
      "Path to baerly.config.{js,mjs,json}; pulls declared indexes for key-count probes.",
    valueHint: "path",
  },
  provider: {
    type: "string",
    required: false,
    description:
      "Override pricing provider for the trajectory footer (r2|aws-s3|self-hosted|dev). Auto-detected from the bucket URI + BAERLY_S3_ENDPOINT.",
    valueHint: "r2|aws-s3|self-hosted|dev",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

type Args = ParsedArgs<typeof INSPECT_ARGS>;

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "bucket",
  "app",
  "tenant",
  "table",
  "config",
  "provider",
  "json",
  "_",
]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") {
    return 1;
  }
  return 2;
};

const loadConfigIndexes = async (
  configPath: string,
  table: string,
): Promise<readonly IndexDefinition[]> => {
  if (configPath.endsWith(".ts")) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly inspect: --config must point at compiled JS / JSON (got .ts: ${JSON.stringify(configPath)})`,
    );
  }
  let cfg: BaerlyConfig;
  if (configPath.endsWith(".json")) {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(configPath, "utf8");
    try {
      cfg = JSON.parse(text) as BaerlyConfig;
    } catch (error) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly inspect: --config JSON parse error in ${JSON.stringify(configPath)}: ${(error as Error).message}`,
      );
    }
  } else {
    const pathMod = await import("node:path");
    const abs = configPath.startsWith("file://")
      ? fileURLToPath(configPath)
      : pathMod.resolve(configPath);
    const mod = (await import(pathToFileURL(abs).href)) as { default?: BaerlyConfig };
    if (mod.default === undefined) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly inspect: --config ${JSON.stringify(configPath)} has no default export`,
      );
    }
    cfg = mod.default;
  }
  const collection = cfg.collections?.[table];
  return collection?.indexes ?? [];
};

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

/** Default-app / default-tenant resolution, with a JSON-mode warning when falling through. */
const resolveAppTenant = async (
  args: Args,
): Promise<{ app: string; tenant: string; warning?: string }> => {
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
      warning:
        "baerly inspect: no baerly.config.{ts,js,mjs,json} in cwd; falling back to defaults app=app, tenant=tenant",
    };
  }
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
  trajectory: Trajectory | null;
  warning?: string;
}

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

/** Two-line trajectory block. Three output states per design spec §4.2. */
const renderTrajectory = (t: Trajectory): string => {
  const wpm = t.writesPerMin.toFixed(t.writesPerMin < 10 ? 1 : 0);
  const classA = formatOps(t.classAPerMonth);
  // State 2: ops-only — provider known but no $ model. Today only
  // self-hosted reaches this (dev is filtered out by the
  // `provider !== "dev"` gate in inspect.ts before calling project()).
  if (t.projectedUsdPerMonth === null) {
    return [
      `  trajectory:          ~${wpm} writes/min  →  ~${classA} Class A/mo`,
      `                       ${t.percentOfGraduation.toFixed(2)}% of 50M/mo graduation trigger. Self-hosted — bill model not modelled.`,
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
  return [
    `  trajectory:          ~${wpm} writes/min  →  ~${classA} Class A/mo  →  ${usd}`,
    `                       ${tail}`,
  ].join("\n");
};

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
  if (r.trajectory !== null) {
    lines.push(renderTrajectory(r.trajectory));
  }
  lines.push(`  status:              ${r.status}`);
  if (r.errors.length > 0) {
    for (const e of r.errors) {
      lines.push(`  error:               ${e}`);
    }
  }
  if (r.warning !== undefined) {
    lines.push(`  warning:             ${r.warning}`);
  }
  return lines.join("\n") + "\n";
};

const handleInspect = async (args: Args): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly inspect: unknown flag --${k}`);
      }
    }
    if (typeof args.provider === "string" && args.provider.length > 0) {
      const allowed = new Set(["r2", "aws-s3", "self-hosted", "dev"]);
      if (!allowed.has(args.provider)) {
        throw new BaerlyError(
          "InvalidConfig",
          `baerly inspect: --provider must be one of r2|aws-s3|self-hosted|dev (got ${JSON.stringify(args.provider)})`,
        );
      }
    }
    const bucket = await parseBucketUri(args.bucket);
    const { app, tenant, warning } = await resolveAppTenant(args);
    const tablePrefix = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.table}`;
    const currentJsonKey = `${tablePrefix}/current.json`;

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

    // Orphan-snapshot detection: list every file under <tablePrefix>/snapshot/
    // and flag anything that isn't the currently-pointed-at snapshot.
    try {
      const snapshotPrefix = `${tablePrefix}/snapshot/`;
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
      const defs = await loadConfigIndexes(args.config, args.table);
      for (const def of defs) {
        const prefix = `${tablePrefix}/index/${def.name}/`;
        const { count } = await countListEntries(bucket.storage, prefix);
        indexes.push({ name: def.name, count });
      }
    }

    // Trajectory footer: derive a projected cost trajectory from a fresh
    // estimate of writes/min. Skipped for dev backends (file://, memory://)
    // because $ projection is meaningless there. Errors land in errors[]
    // so the inspection still completes — consistent with how
    // loadMaterialisedView failure is handled above.
    const providerOverride =
      typeof args.provider === "string" && args.provider.length > 0
        ? (args.provider as "r2" | "aws-s3" | "self-hosted" | "dev")
        : undefined;
    const provider = detectProvider({
      bucketUri: args.bucket,
      s3Endpoint: process.env["BAERLY_S3_ENDPOINT"],
      override: providerOverride,
    });
    let trajectory: Trajectory | null = null;
    if (provider !== "dev") {
      try {
        const verdict = await estimateWritesPerMin(bucket.storage, app, tenant, args.table, {
          keyPrefix: bucket.keyPrefix,
        });
        trajectory = project(verdict.writesPerMin, 0, pricingFor(provider));
      } catch (error) {
        if (error instanceof BaerlyError) {
          errors.push(`${error.code}: ${error.message}`);
        } else {
          errors.push((error as Error).message);
        }
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
      trajectory,
      ...(warning !== undefined && { warning }),
    };

    if (isJsonMode()) {
      emitSuccess({ command: "inspect", ...result });
    } else {
      process.stdout.write(renderText(result, args.table));
    }
    return 0;
  } catch (error) {
    if (error instanceof BaerlyError) {
      emitError("inspect", error.code, error.message);
      return errorToExitCode(error.code);
    }
    emitError("inspect", "Unknown", (error as Error).message);
    return 2;
  }
};

/** citty `defineCommand` block for `baerly inspect`. */
export const inspect = defineCommand({
  meta: {
    name: "inspect",
    description: "Read-only summary of one collection's snapshot + log state.",
  },
  args: INSPECT_ARGS,
  run: async ({ args }) => {
    const code = await handleInspect(args);
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
export const runInspect = async (argv: readonly string[]): Promise<number> => {
  let parsed: Args;
  try {
    parsed = parseArgs<typeof INSPECT_ARGS>(argv as string[], INSPECT_ARGS);
  } catch (error) {
    setJsonMode(argv.includes("--json"));
    emitError("inspect", "InvalidConfig", (error as Error).message);
    return 1;
  }
  return handleInspect(parsed);
};
