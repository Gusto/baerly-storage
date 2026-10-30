/**
 * `baerly inspect` — read-only summary for one collection.
 *
 * Args:
 *   --bucket   Required. Bucket URI.
 *   --app      Required (or via baerly.config.ts).
 *   --tenant   Required (or via baerly.config.ts).
 *   --collection Required. Collection name.
 *   --config   Optional path to baerly.config.{js,mjs,json} for index info.
 *   --profile  Optional host profile (cf-free | cf-paid | node) for the
 *              fold_gate verdict. Default: report all three.
 *   --json     JSON envelope.
 *
 * Reports, per-collection:
 *   - currentJsonKey path.
 *   - schema_version, tail_hint, log_seq_start (default 0).
 *   - live_log_tail (= tail_hint - log_seq_start).
 *   - snapshot key (or null).
 *   - snapshot_bytes / snapshot_rows (the fold-ceiling inputs C / E
 *     are compared against; see graduation.md).
 *   - fold_gate, per host profile: `open`, `closed:bytes`, or
 *     `closed:rows` — the write-tick runner's pre-fold projection
 *     (`snapshot_bytes <= C && snapshot_rows + maxFoldEntriesPerPass <= E`)
 *     against that profile's ceilings, with `C` overridden by
 *     `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` from the CLI's environment. Plus
 *     `retention_stalled`: the gate is closed and the live tail has
 *     reached the write-tick fold floor, so the tail and log retention
 *     are frozen. The CLI cannot know the host, hence one verdict per
 *     profile. A collection whose stored snapshot is under `C` but whose
 *     next rebuild would exceed it reads `open` here; the runner's
 *     `fold_deferred` warning (gate `rebuild`) is that case's signal.
 *   - writer_fence (epoch, owner, claimed_at).
 *   - materialised row count (via export/loadMaterialisedView).
 *   - per-declared-index key count (when --config supplied).
 *   - well-formed status: "ok" or "error" with an `errors` array.
 *
 * For projected monthly Class A / $ trajectories, use
 * `baerly cost --bucket=<uri> --collection=<name>` — the projection
 * used to live as a footer here but moved to its own verb so inspect
 * stays a glance command (no GET-storm over the trailing log sample).
 *
 * Cost shape:
 *   1 GET current.json
 *   + 1 GET snapshot (if any)
 *   + N GETs log tail (= tail_hint - log_seq_start)
 *   + K LISTs (one per declared index, when --config supplied)
 *   + 1 LIST snapshot/ prefix (orphan detection)
 *
 * Never mutates anything.
 *
 * Exit codes:
 *   0 — inspection ran (status may be "ok" or "error"; both exit 0).
 *   1 — InvalidConfig (bad bucket URI, missing args, unknown flag).
 *   2 — Storage / Network error.
 *   3 — Protocol invariant (Conflict / Internal / InvalidResponse /
 *       AmbiguousCommit).
 */

import { type ArgsDef } from "citty";
import {
  BaerlyError,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_CF_PAID,
  MAINTENANCE_PROFILE_NODE,
  readCurrentJson,
  type CurrentJson,
  type Storage,
  WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
} from "@baerly/protocol";
import { probeTailFrom } from "@baerly/server";
import { type MaintenanceProfile, parseMaintenanceEnv } from "@baerly/server/maintenance";
import { loadMaterialisedView } from "./export/index.ts";
import { loadCollectionIndexes } from "./config.ts";
import { parseBucketUri } from "./bucket-uri.ts";
import { emitSuccess, isJsonMode } from "./output.ts";
import {
  APP_ARG,
  assertCollectionArg,
  BUCKET_ARG,
  COLLECTION_ARG,
  defineBaerlySubcommand,
  JSON_ARG,
  TENANT_ARG,
} from "./subcommand.ts";

const INSPECT_ARGS = {
  bucket: BUCKET_ARG,
  app: APP_ARG,
  tenant: TENANT_ARG,
  collection: COLLECTION_ARG,
  config: {
    type: "string",
    required: false,
    description:
      "Path to baerly.config.{js,mjs,json}; pulls declared indexes for key-count probes.",
    valueHint: "path",
  },
  profile: {
    type: "enum",
    options: ["cf-free", "cf-paid", "node"],
    required: false,
    description:
      "Host profile for the fold_gate verdict: cf-free | cf-paid | node. Default: all three.",
  },
  json: JSON_ARG,
} as const satisfies ArgsDef;

/** The host profiles `BAERLY_MAINTENANCE_PROFILE` / the adapters select, keyed by name. */
const HOST_PROFILES = {
  "cf-free": MAINTENANCE_PROFILE_CF_FREE,
  "cf-paid": MAINTENANCE_PROFILE_CF_PAID,
  node: MAINTENANCE_PROFILE_NODE,
} as const satisfies Record<string, MaintenanceProfile>;

type HostProfileName = keyof typeof HOST_PROFILES;

interface FoldGateVerdict {
  verdict: "open" | "closed:bytes" | "closed:rows";
  /** `C` for this profile, after any `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` override. */
  ceiling_bytes: number;
  /** `E` for this profile (no env override exists). */
  ceiling_rows: number;
  /** Gate closed AND the live tail has reached the write-tick fold floor. */
  retention_stalled: boolean;
}

/**
 * The write-tick runner's pre-fold projection, evaluated off stored
 * figures for one profile. Bytes is checked first, matching the runner's
 * `dimension` label.
 */
const foldGateVerdict = (
  cur: CurrentJson,
  liveLogTail: number,
  profile: MaintenanceProfile,
  maxFoldBytes: number | undefined,
): FoldGateVerdict => {
  const ceilingBytes = maxFoldBytes ?? profile.maxFoldBytes;
  const ceilingRows = profile.maxFoldRows;
  let verdict: FoldGateVerdict["verdict"] = "open";
  if (cur.snapshot_bytes > ceilingBytes) {
    verdict = "closed:bytes";
  } else if (cur.snapshot_rows + profile.maxFoldEntriesPerPass > ceilingRows) {
    verdict = "closed:rows";
  }
  return {
    verdict,
    ceiling_bytes: ceilingBytes,
    ceiling_rows: ceilingRows,
    retention_stalled: verdict !== "open" && liveLogTail >= WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
  };
};

/** Stderr warning for a maintenance env value the adapters would reject. */
const warnRejectedEnv = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `baerly inspect: warning: ${message} — the adapters reject this value with InvalidConfig on every request that reads it.\n`,
  );
};

/**
 * The maintenance env as `inspect` reports it, read from the CLI's own
 * environment. Each variable goes through {@link parseMaintenanceEnv} on its
 * own, so a value the adapters would reject (`BAERLY_MAINTENANCE_DISABLE=off`,
 * a non-positive `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`) becomes a stderr warning
 * rather than failing a read-only report, and never masks the other variable.
 * A rejected `MAX_FOLD_BYTES` falls back to each profile's default `C`.
 */
const readInspectMaintenanceEnv = (
  readEnv: (key: string) => string | undefined,
): { maxFoldBytes: number | undefined; maintenance: InspectResult["maintenance"] } => {
  const only =
    (key: string) =>
    (k: string): string | undefined =>
      k === key ? readEnv(k) : undefined;
  let maxFoldBytes: number | undefined;
  try {
    maxFoldBytes = parseMaintenanceEnv(only("BAERLY_MAINTENANCE_MAX_FOLD_BYTES")).maxFoldBytes;
  } catch (error) {
    warnRejectedEnv(error);
  }
  let maintenance: InspectResult["maintenance"];
  try {
    maintenance = parseMaintenanceEnv(only("BAERLY_MAINTENANCE_DISABLE")).disabled
      ? "disabled"
      : "enabled";
  } catch (error) {
    warnRejectedEnv(error);
    maintenance = "invalid-config";
  }
  return { maxFoldBytes, maintenance };
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

interface InspectResult {
  currentJsonKey: string;
  schema_version: number;
  /** The stored, compactor-advanced lower-bound hint (`current.json.tail_hint`). */
  tail_hint: number;
  /** The TRUE committed tail, discovered by forward-probe past `tail_hint`. */
  discovered_tail: number;
  log_seq_start: number;
  live_log_tail: number;
  snapshot: string | null;
  snapshot_bytes: number;
  snapshot_rows: number;
  fold_gate: Partial<Record<HostProfileName, FoldGateVerdict>>;
  /**
   * In-band fold/GC per `BAERLY_MAINTENANCE_DISABLE` in the CLI's environment.
   * `invalid-config`: a value outside the closed vocabulary, which the
   * adapters reject.
   */
  maintenance: "enabled" | "disabled" | "invalid-config";
  writer_fence: CurrentJson["writer_fence"];
  materialised_rows: number;
  indexes: { name: string; count: number }[];
  status: "ok" | "error";
  errors: string[];
}

const renderText = (r: InspectResult, collection: string): string => {
  const lines: string[] = [];
  lines.push(`baerly inspect ${collection}`);
  lines.push(`  current.json:        ${r.currentJsonKey}`);
  lines.push(`  schema_version:      ${r.schema_version}`);
  lines.push(`  tail_hint (stored):  ${r.tail_hint}`);
  lines.push(`  discovered_tail:     ${r.discovered_tail}`);
  lines.push(`  log_seq_start:       ${r.log_seq_start}`);
  lines.push(`  live_log_tail:       ${r.live_log_tail}`);
  lines.push(`  snapshot:            ${r.snapshot ?? "(none)"}`);
  lines.push(`  snapshot_bytes:      ${r.snapshot_bytes}`);
  lines.push(`  snapshot_rows:       ${r.snapshot_rows}`);
  for (const [name, g] of Object.entries(r.fold_gate)) {
    const label = `fold_gate (${name}):`.padEnd(21);
    const stalled = g.retention_stalled ? " retention_stalled" : "";
    lines.push(`  ${label}${g.verdict} (C=${g.ceiling_bytes} E=${g.ceiling_rows})${stalled}`);
  }
  lines.push(`  maintenance:         ${r.maintenance}`);
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
    assertCollectionArg(args.collection, "baerly inspect");
    const collectionPrefix = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.collection}`;
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
    // Discover the TRUE tail by forward-probe — under single-write commit
    // the stored `tail_hint` is only a lower bound (compactor-advanced),
    // so an accurate operator summary must probe past it.
    const tailProbe = await probeTailFrom(
      bucket.storage,
      collectionPrefix,
      Math.max(log_seq_start, cur.tail_hint),
    );
    const discoveredTail = tailProbe.tail;

    const errors: string[] = [];
    let materialisedRows = 0;
    try {
      const view = await loadMaterialisedView({
        storage: bucket.storage,
        currentJsonKey,
        collection: args.collection,
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
      const defs = await loadCollectionIndexes(args.config, args.collection, "baerly inspect");
      for (const def of defs) {
        const prefix = `${collectionPrefix}/index/${def.name}/`;
        const { count } = await countListEntries(bucket.storage, prefix);
        indexes.push({ name: def.name, count });
      }
    }

    const liveLogTail = discoveredTail - log_seq_start;
    const { maxFoldBytes, maintenance } = readInspectMaintenanceEnv((k) => process.env[k]);
    const profileNames: readonly HostProfileName[] =
      args.profile === undefined
        ? (Object.keys(HOST_PROFILES) as HostProfileName[])
        : [args.profile as HostProfileName];
    const foldGate: InspectResult["fold_gate"] = {};
    for (const name of profileNames) {
      foldGate[name] = foldGateVerdict(cur, liveLogTail, HOST_PROFILES[name], maxFoldBytes);
    }

    const result: InspectResult = {
      currentJsonKey,
      schema_version: cur.schema_version,
      tail_hint: cur.tail_hint,
      discovered_tail: discoveredTail,
      log_seq_start,
      live_log_tail: liveLogTail,
      snapshot: cur.snapshot,
      snapshot_bytes: cur.snapshot_bytes,
      snapshot_rows: cur.snapshot_rows,
      fold_gate: foldGate,
      maintenance,
      writer_fence: cur.writer_fence,
      materialised_rows: materialisedRows,
      indexes,
      status: errors.length === 0 ? "ok" : "error",
      errors,
    };

    if (isJsonMode()) {
      emitSuccess({ command: "inspect", ...result });
    } else {
      process.stdout.write(renderText(result, args.collection));
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
