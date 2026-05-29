/**
 * `baerly admin fsck` — consistency walk for one collection.
 *
 * Default mode (no `--indexes`): read-only checks against the
 * snapshot + log tail.
 *   1. `current.json` exists at the expected key and parses.
 *   2. When `current.snapshot !== null`, the snapshot body's
 *      SHA-256 matches the hash embedded in the filename
 *      (delegated to `loadSnapshotAsMap`).
 *   3. The log range `[log_seq_start, next_seq)` has no holes —
 *      every `log/<seq>.json` is present (HEAD-cheap LIST scan).
 *   4. Every entry inside the live tail is well-formed JSON with
 *      the locked `op`, `collection`, and `doc_id` fields.
 *
 * `--indexes` + `--config=<path>` mode: SKIP the snapshot + log
 * walks and ONLY check each declared index for drift via
 * `rebuildIndex(..., { dryRun: true })`. Drift is `(added > 0)`
 * (rows that should be projected but have no key on storage) or
 * `(removed > 0)` (orphan keys for rows that no longer match).
 * Read-only.
 *
 * `--indexes --fix`: same drift walk but with `dryRun: false`, so
 * `rebuildIndex` PUTs missing keys and DELETEs orphans. The findings
 * downgrade from `warning` to `info` (drift was found AND fixed in
 * one pass). `--fix` without `--indexes` is rejected — fsck has no
 * auto-fix outside the index check.
 *
 * Exit codes:
 *   0 — all checks pass.
 *   1 — InvalidConfig (bad bucket URI, missing args, unknown flag,
 *       `--fix` without `--indexes`).
 *   2 — Storage / Network error during the walk.
 *   3 — Protocol invariant violation surfaced by the kernel
 *       (Internal / InvalidResponse) — distinguished from exit 4
 *       so CI can wire fsck as a regression gate.
 *   4 — One or more findings (orphan / hole / hash-mismatch /
 *       index drift). Unique to this command; the other
 *       `baerly admin` subcommands reserve 0–3.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { type ArgsDef } from "citty";
import {
  type BaerlyConfig,
  BaerlyError,
  type IndexDefinition,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { loadSnapshotAsMap } from "@baerly/server";
import { rebuildIndex } from "@baerly/server/maintenance";
import { parseBucketUri } from "../bucket-uri.ts";
import { emitSuccess, isJsonMode } from "../output.ts";
import { defineBaerlySubcommand } from "../subcommand.ts";

const FSCK_ARGS = {
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
  collection: {
    type: "string",
    required: true,
    description: "Collection name.",
    valueHint: "name",
  },
  config: {
    type: "string",
    required: false,
    description:
      "Path to baerly.config.{js,mjs,json}. Required with --indexes; resolves index definitions.",
    valueHint: "path",
  },
  indexes: {
    type: "boolean",
    description:
      "Skip snapshot + log walks; check declared indexes for drift via rebuildIndex (read-only by default).",
  },
  fix: {
    type: "boolean",
    description:
      "With --indexes, rebuild drifted indexes (PUT missing keys, DELETE orphans). Rejected without --indexes.",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

type Severity = "ok" | "info" | "warning" | "finding";
interface Finding {
  readonly severity: Severity;
  readonly check: string;
  readonly message: string;
  readonly key?: string;
}

/** Severities that count toward the exit-4 "findings present" status. */
const isFindingSeverity = (s: Severity): boolean => s === "finding" || s === "warning";

const loadConfigIndexes = async (
  configPath: string,
  collection: string,
): Promise<readonly IndexDefinition[]> => {
  if (configPath.endsWith(".ts")) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly admin fsck: --config must point at compiled JS / JSON (got .ts: ${JSON.stringify(configPath)})`,
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
        `baerly admin fsck: --config JSON parse error in ${JSON.stringify(configPath)}: ${(error as Error).message}`,
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
        `baerly admin fsck: --config ${JSON.stringify(configPath)} has no default export`,
      );
    }
    cfg = mod.default;
  }
  const def = cfg.collections?.[collection];
  return def?.indexes ?? [];
};

const listKeys = async (storage: Storage, prefix: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of storage.list(prefix)) {
    out.push(entry.key);
  }
  return out.toSorted();
};

const statusLine = (label: string, ok: boolean, detail: string): string =>
  `  ${label.padEnd(22)}${ok ? "ok" : "error"} ${detail}`.trimEnd();

interface IndexSummary {
  readonly name: string;
  readonly added: number;
  readonly removed: number;
  readonly kept: number;
  readonly rebuilt: boolean;
}

const renderSnapshotLog = (
  collection: string,
  findings: readonly Finding[],
  context: {
    readonly logRange: readonly [number, number];
    readonly logEntriesPresent: number;
    readonly snapshotKey: string | null;
  },
): string => {
  const lines: string[] = [];
  lines.push(`baerly admin fsck ${collection}`);
  const [from, toExcl] = context.logRange;
  const byCheck = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byCheck.get(f.check) ?? [];
    arr.push(f);
    byCheck.set(f.check, arr);
  }
  lines.push(statusLine("current.json:", (byCheck.get("current.json") ?? []).length === 0, ""));
  lines.push(
    statusLine(
      "snapshot hash:",
      (byCheck.get("snapshot") ?? []).length === 0,
      context.snapshotKey === null ? "(no snapshot yet)" : `(sha256 verified)`,
    ),
  );
  lines.push(
    statusLine(
      `log range [${from},${toExcl}):`,
      (byCheck.get("log") ?? []).length === 0,
      `(${context.logEntriesPresent}/${toExcl - from} entries present)`,
    ),
  );
  lines.push(`  status:               ${findings.some(isFindingFinding) ? "findings" : "ok"}`);
  for (const f of findings) {
    lines.push(`  ${f.check}: ${f.message}${f.key !== undefined ? ` (key=${f.key})` : ""}`);
  }
  return lines.join("\n") + "\n";
};

const renderIndexes = (
  collection: string,
  findings: readonly Finding[],
  summaries: readonly IndexSummary[],
  fix: boolean,
): string => {
  const lines: string[] = [];
  lines.push(`baerly admin fsck ${collection} --indexes${fix ? " --fix" : ""}`);
  for (const s of summaries) {
    const verb = s.rebuilt ? "rebuilt" : "would rebuild";
    if (s.added === 0 && s.removed === 0) {
      lines.push(`  ${s.name}: in sync (${s.kept} keys)`);
    } else {
      lines.push(`  ${s.name}: ${verb} — added ${s.added}, removed ${s.removed}, kept ${s.kept}`);
    }
  }
  lines.push(`  status:               ${findings.some(isFindingFinding) ? "findings" : "ok"}`);
  for (const f of findings) {
    if (f.check === "log" || f.check === "snapshot" || f.check === "current.json") {
      continue;
    }
    lines.push(`  ${f.check}: ${f.message}${f.key !== undefined ? ` (key=${f.key})` : ""}`);
  }
  return lines.join("\n") + "\n";
};

const isFindingFinding = (f: Finding): boolean => isFindingSeverity(f.severity);

const bundle = defineBaerlySubcommand({
  name: "admin.fsck",
  meta: {
    description: "Read-only consistency walk for one collection.",
  },
  args: FSCK_ARGS,
  handler: async (args, ctx) => {
    const indexMode = args.indexes === true;
    const fixMode = args.fix === true;
    if (fixMode && !indexMode) {
      throw new BaerlyError(
        "InvalidConfig",
        "baerly admin fsck: --fix is only valid with --indexes (fsck has no auto-fix outside the index check)",
      );
    }
    if (indexMode && (args.config === undefined || args.config.length === 0)) {
      throw new BaerlyError(
        "InvalidConfig",
        "baerly admin fsck: --indexes requires --config=<path> to resolve index definitions",
      );
    }
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    const bucket = await parseBucketUri(args.bucket);
    const collectionPrefix = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.collection}`;
    const currentJsonKey = `${collectionPrefix}/current.json`;

    const findings: Finding[] = [];

    if (indexMode) {
      // ── Index drift mode. ──────────────────────────────────────────
      // Skip snapshot + log walks. For each declared index, call
      // `rebuildIndex(..., { dryRun: !fix })` — it returns the
      // `(added, removed, kept)` triple we need to call drift.
      const defs = await loadConfigIndexes(args.config!, args.collection);
      const summaries: IndexSummary[] = [];
      for (const def of defs) {
        const check = `index.${def.name}`;
        let result;
        try {
          result = await rebuildIndex(bucket.storage, currentJsonKey, def, {
            dryRun: !fixMode,
          });
        } catch (error) {
          findings.push({
            severity: "finding",
            check,
            message: `${def.name}: drift check failed: ${(error as Error).message}`,
          });
          continue;
        }
        const summary: IndexSummary = {
          name: def.name,
          added: result.added,
          removed: result.removed,
          kept: result.kept,
          rebuilt: fixMode,
        };
        summaries.push(summary);
        const drifted = result.added > 0 || result.removed > 0;
        if (!drifted) {
          findings.push({
            severity: "ok",
            check,
            message: `${def.name}: in sync (${result.kept} keys).`,
          });
        } else if (fixMode) {
          findings.push({
            severity: "info",
            check,
            message: `${def.name}: rebuilt — added ${result.added}, removed ${result.removed}, kept ${result.kept}.`,
          });
        } else {
          findings.push({
            severity: "warning",
            check,
            message: `${def.name}: drift detected — ${result.added} missing, ${result.removed} orphaned (${result.kept} in sync).`,
          });
        }
      }

      if (isJsonMode()) {
        emitSuccess({
          command: "admin.fsck",
          status: findings.some(isFindingFinding) ? "findings" : "ok",
          collection: args.collection,
          mode: fixMode ? "indexes-fix" : "indexes",
          indexes: summaries,
          findings: findings.map((f) => ({
            severity: f.severity,
            check: f.check,
            message: f.message,
            ...(f.key !== undefined && { key: f.key }),
          })),
        });
      } else {
        process.stdout.write(renderIndexes(args.collection, findings, summaries, fixMode));
      }
      return findings.some(isFindingFinding) ? 4 : 0;
    }

    // ── Default mode. current.json + snapshot + log walks. ─────────
    const read = await readCurrentJson(bucket.storage, currentJsonKey);
    if (read === null) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly admin fsck: current.json not found at ${currentJsonKey}`,
      );
    }
    const cur = read.json;
    const logFrom = cur.log_seq_start ?? 0;
    const logToExcl = cur.next_seq;
    const snapshotKey = cur.snapshot;

    // ── Snapshot hash verifies (loadSnapshotAsMap throws on mismatch). ──
    if (snapshotKey !== null) {
      try {
        await loadSnapshotAsMap(bucket.storage, snapshotKey, args.collection);
      } catch (error) {
        if (
          error instanceof BaerlyError &&
          (error.code === "Internal" || error.code === "InvalidResponse")
        ) {
          findings.push({
            severity: "finding",
            check: "snapshot",
            message: error.message,
            key: snapshotKey,
          });
        } else {
          throw error;
        }
      }
    }

    // ── Log range [from, toExcl) has no holes; entries well-formed. ──
    // LIST the log/ prefix; expect exactly `toExcl - from` keys named
    // `${from}.json` … `${toExcl - 1}.json`. Use a single LIST so the
    // op count is O(pages) not O(range).
    const logPrefix = `${collectionPrefix}/log/`;
    const presentKeys = await listKeys(bucket.storage, logPrefix);
    const presentSeqs = new Set<number>();
    for (const key of presentKeys) {
      const tail = key.slice(logPrefix.length);
      const match = /^(\d+)\.json$/.exec(tail);
      if (match === null) {
        continue;
      }
      const seq = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(seq)) {
        presentSeqs.add(seq);
      }
    }
    let logEntriesPresent = 0;
    for (let s = logFrom; s < logToExcl; s++) {
      if (presentSeqs.has(s)) {
        logEntriesPresent++;
      } else {
        findings.push({
          severity: "finding",
          check: "log",
          message: `missing log entry at seq ${s} inside [log_seq_start, next_seq)`,
          key: `${logPrefix}${s}.json`,
        });
      }
    }

    if (isJsonMode()) {
      emitSuccess({
        command: "admin.fsck",
        status: findings.some(isFindingFinding) ? "findings" : "ok",
        collection: args.collection,
        current_json_key: currentJsonKey,
        snapshot: snapshotKey,
        log_range: { from: logFrom, to_excl: logToExcl, present: logEntriesPresent },
        findings: findings.map((f) => ({
          severity: f.severity,
          check: f.check,
          message: f.message,
          ...(f.key !== undefined && { key: f.key }),
        })),
      });
    } else {
      process.stdout.write(
        renderSnapshotLog(args.collection, findings, {
          logRange: [logFrom, logToExcl],
          logEntriesPresent,
          snapshotKey,
        }),
      );
    }
    return findings.some(isFindingFinding) ? 4 : 0;
  },
});

/** citty `defineCommand` block for `baerly admin fsck`. */
export const fsckCmd = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runFsck = bundle.run;
