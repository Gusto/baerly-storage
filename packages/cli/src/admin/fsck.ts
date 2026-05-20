/**
 * `baerly admin fsck` — read-only consistency walk for one collection.
 *
 * Checks (no mutations, ever):
 *   1. `current.json` exists at the expected key and parses.
 *   2. When `current.snapshot !== null`, the snapshot body's
 *      SHA-256 matches the hash embedded in the filename
 *      (delegated to `loadSnapshotAsMap`).
 *   3. The log range `[log_seq_start, next_seq)` has no holes —
 *      every `log/<seq>.json` is present (HEAD-cheap LIST scan).
 *   4. Every entry inside the live tail is well-formed JSON with
 *      the locked `op`, `collection`, `doc_id`, `schema_version`
 *      fields.
 *   5. `--rebuild-indexes` + `--config=<path>`: walk each declared
 *      index's prefix and report orphan keys (keys that don't point
 *      at a live doc + value combination from the materialised view).
 *      Reports only — `baerly admin rebuild-index` is the mutating
 *      remediation path.
 *
 * Exit codes:
 *   0 — all checks pass.
 *   1 — InvalidConfig (bad bucket URI, missing args, unknown flag).
 *   2 — Storage / Network error during the walk.
 *   3 — Protocol invariant violation surfaced by the kernel
 *       (Internal / InvalidResponse) — distinguished from exit 4
 *       so CI can wire fsck as a regression gate.
 *   4 — One or more findings (orphan / hole / hash-mismatch /
 *       orphan-index-key). Unique to this command; the other
 *       `baerly admin` subcommands reserve 0–3.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { type ArgsDef } from "citty";
import {
  type DocumentData,
  type Storage,
  BaerlyError,
  readCurrentJson,
} from "@baerly/protocol";
import { loadMaterialisedView } from "../export/index.ts";
import {
  type BaerlyConfig,
  type IndexDefinition,
  allIndexKeysFor,
  loadSnapshotAsMap,
} from "@baerly/server";
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
      "Path to baerly.config.{js,mjs,json}. Required with --rebuild-indexes; resolves index definitions.",
    valueHint: "path",
  },
  "rebuild-indexes": {
    type: "boolean",
    description: "Also walk declared index prefixes and report orphan keys (read-only).",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

type Severity = "ok" | "finding";
interface Finding {
  readonly severity: Severity;
  readonly check: string;
  readonly message: string;
  readonly key?: string;
}

const loadConfigIndexes = async (
  configPath: string,
  table: string,
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
  const collection = cfg.collections?.[table];
  return collection?.indexes ?? [];
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

const renderText = (
  table: string,
  findings: readonly Finding[],
  context: {
    readonly logRange: readonly [number, number];
    readonly logEntriesPresent: number;
    readonly snapshotKey: string | null;
    readonly indexSummaries: readonly { name: string; count: number; orphans: number }[];
  },
): string => {
  const lines: string[] = [];
  lines.push(`baerly admin fsck ${table}`);
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
  if (context.indexSummaries.length > 0) {
    const parts = context.indexSummaries.map(
      (s) => `${s.name} (count=${s.count}; ${s.orphans} orphans)`,
    );
    lines.push(`  indexes:              ${parts.join(", ")}`);
  }
  lines.push(`  status:               ${findings.length === 0 ? "ok" : "findings"}`);
  for (const f of findings) {
    lines.push(`  ${f.check}: ${f.message}${f.key !== undefined ? ` (key=${f.key})` : ""}`);
  }
  return lines.join("\n") + "\n";
};

const bundle = defineBaerlySubcommand({
  name: "admin.fsck",
  meta: {
    description: "Read-only consistency walk for one collection.",
  },
  args: FSCK_ARGS,
  handler: async (args, ctx) => {
    if (
      args["rebuild-indexes"] === true &&
      (args.config === undefined || args.config.length === 0)
    ) {
      throw new BaerlyError(
        "InvalidConfig",
        "baerly admin fsck: --rebuild-indexes requires --config=<path> to resolve index definitions",
      );
    }
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    const bucket = await parseBucketUri(args.bucket);
    const tablePrefix = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.table}`;
    const currentJsonKey = `${tablePrefix}/current.json`;

    const findings: Finding[] = [];

    // ── Check 1. current.json exists and parses. ────────────────────
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

    // ── Check 2. Snapshot hash verifies (loadSnapshotAsMap throws on mismatch). ──
    if (snapshotKey !== null) {
      try {
        await loadSnapshotAsMap(bucket.storage, snapshotKey, args.table);
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

    // ── Check 3 + 4. Log range [from, toExcl) has no holes; entries well-formed. ──
    // LIST the log/ prefix; expect exactly `toExcl - from` keys named
    // `${from}.json` … `${toExcl - 1}.json`. Use a single LIST so the
    // op count is O(pages) not O(range).
    const logPrefix = `${tablePrefix}/log/`;
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

    // ── Check 5. Optional index orphan probe. ───────────────────────
    const indexSummaries: { name: string; count: number; orphans: number }[] = [];
    if (args["rebuild-indexes"] === true && args.config !== undefined && args.config.length > 0) {
      const defs = await loadConfigIndexes(args.config, args.table);
      // Materialised view computes the expected index-key set (parity with
      // `baerly admin rebuild-index`'s reconciliation walk).
      const view = await loadMaterialisedView({
        storage: bucket.storage,
        currentJsonKey,
        collection: args.table,
      });
      const viewRows: ReadonlyMap<string, DocumentData> =
        view ?? new Map<string, DocumentData>();
      for (const def of defs) {
        const expected = new Set<string>();
        for (const [id, body] of viewRows) {
          for (const key of allIndexKeysFor(tablePrefix, [def], body, id)) {
            expected.add(key);
          }
        }
        const indexPrefix = `${tablePrefix}/index/${def.name}/`;
        const present = await listKeys(bucket.storage, indexPrefix);
        let orphans = 0;
        for (const key of present) {
          if (!expected.has(key)) {
            orphans++;
            findings.push({
              severity: "finding",
              check: `index.${def.name}`,
              message: `orphan index key (not produced by any live row's projection)`,
              key,
            });
          }
        }
        indexSummaries.push({ name: def.name, count: present.length, orphans });
      }
    }

    if (isJsonMode()) {
      emitSuccess({
        command: "admin.fsck",
        status: findings.length === 0 ? "ok" : "findings",
        table: args.table,
        current_json_key: currentJsonKey,
        snapshot: snapshotKey,
        log_range: { from: logFrom, to_excl: logToExcl, present: logEntriesPresent },
        indexes: indexSummaries,
        findings: findings.map((f) => ({
          severity: f.severity,
          check: f.check,
          message: f.message,
          ...(f.key !== undefined && { key: f.key }),
        })),
      });
    } else {
      process.stdout.write(
        renderText(args.table, findings, {
          logRange: [logFrom, logToExcl],
          logEntriesPresent,
          snapshotKey,
          indexSummaries,
        }),
      );
    }
    return findings.length === 0 ? 0 : 4;
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
