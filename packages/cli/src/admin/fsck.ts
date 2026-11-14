/**
 * `baerly admin fsck` — consistency walk for one collection.
 *
 * Read-only checks against the snapshot + log tail.
 *   1. `current.json` exists at the expected key and parses.
 *   2. When `current.snapshot !== null`, the snapshot body's
 *      SHA-256 matches the hash embedded in the filename
 *      (delegated to `loadSnapshotAsMap`).
 *   3. The live log range has no holes. The upper bound is derived
 *      from a single LIST of `log/` plus `current.json.tail_hint`
 *      (max(highest present seq + 1, tail_hint)), and every seq from
 *      `log_seq_start` up to that tail must be present.
 *      This is a presence/hole check by key, NOT a per-entry decode:
 *      fsck does not GET and parse each `log/<seq>.json`, so it does
 *      not assert every entry is well-formed JSON or carries the locked
 *      `op`/`collection`/`doc_id` fields. A full decode walk is
 *      intentionally omitted to keep the op count O(LIST pages); the
 *      read path validates entry shape at fold time.
 *
 * fsck never reads or writes the legacy `index/` prefix: writers before
 * 0.7 left index markers there, but no read consults them, so they cannot
 * drift into a wrong answer. It also has no repair mode.
 *
 * Exit codes:
 *   0 — all checks pass.
 *   1 — InvalidConfig (bad bucket URI, missing args, unknown flag).
 *   2 — Storage / Network error during the walk.
 *   3 — Protocol invariant violation surfaced by the kernel
 *       (Internal / InvalidResponse) — distinguished from exit 4
 *       so CI can wire fsck as a regression gate.
 *   4 — One or more findings (orphan / hole / hash-mismatch /
 *       a non-NFC app, tenant, or collection name). Unique to this command; the other
 *       `baerly admin` subcommands reserve 0–3.
 */

import { type ArgsDef } from "citty";
import { BaerlyError, readCurrentJson, type Storage } from "@baerly/protocol";
import { loadSnapshotAsMap } from "@baerly/server/_internal/kernel";
import { parseBucketUri } from "../bucket-uri.ts";
import { LEGACY_NAME_MIGRATION, nonNfcNames } from "../legacy-names.ts";
import { emitSuccess, isJsonMode } from "../output.ts";
import {
  APP_ARG,
  assertCollectionArg,
  BUCKET_ARG,
  COLLECTION_ARG,
  defineBaerlySubcommand,
  JSON_ARG,
  TENANT_ARG,
} from "../subcommand.ts";

const FSCK_ARGS = {
  bucket: BUCKET_ARG,
  app: APP_ARG,
  tenant: TENANT_ARG,
  collection: COLLECTION_ARG,
  json: JSON_ARG,
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

const listKeys = async (storage: Storage, prefix: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of storage.list(prefix)) {
    out.push(entry.key);
  }
  return out.toSorted();
};

const statusLine = (label: string, ok: boolean, detail: string): string =>
  `  ${label.padEnd(22)}${ok ? "ok" : "error"} ${detail}`.trimEnd();

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

const isFindingFinding = (f: Finding): boolean => isFindingSeverity(f.severity);

const bundle = defineBaerlySubcommand({
  name: "admin.fsck",
  meta: {
    description: "Read-only consistency walk for one collection.",
  },
  args: FSCK_ARGS,
  handler: async (args, ctx) => {
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    assertCollectionArg(args.collection, "baerly admin fsck");
    const names = { app, tenant, collection: args.collection };
    const bucket = await parseBucketUri(args.bucket);
    const collectionPrefix = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.collection}`;
    const currentJsonKey = `${collectionPrefix}/current.json`;

    // Migration preflight: a legacy non-NFC name is readable here but
    // refused by the SDK and by every writing verb.
    const findings: Finding[] = nonNfcNames(names).map((role) => ({
      severity: "warning",
      check: "names",
      message: `${role} name ${JSON.stringify(names[role])} is not NFC: ${LEGACY_NAME_MIGRATION}`,
    }));

    // ── current.json + snapshot + log walks. ───────────────────────
    const read = await readCurrentJson(bucket.storage, currentJsonKey);
    if (read === null) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly admin fsck: current.json not found at ${currentJsonKey}`,
      );
    }
    const cur = read.json;
    const logFrom = cur.log_seq_start ?? 0;
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

    // ── Log range [from, tail) has no holes (presence check only). ──
    // LIST the log/ prefix and derive the upper bound from both listed
    // keys and `tail_hint`: under single-write commit `tail_hint` is
    // normally a lower bound, but fsck must also catch an over-claimed
    // hint whose `[log_seq_start, tail_hint)` range is not actually
    // present. Use a single LIST so the op count is O(pages).
    const logPrefix = `${collectionPrefix}/log/`;
    const presentKeys = await listKeys(bucket.storage, logPrefix);
    const presentSeqs = new Set<number>();
    let maxSeq = logFrom - 1;
    for (const key of presentKeys) {
      const tail = key.slice(logPrefix.length);
      const match = /^(\d+)\.json$/.exec(tail);
      if (match === null) {
        continue;
      }
      const seq = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(seq)) {
        presentSeqs.add(seq);
        if (seq > maxSeq) {
          maxSeq = seq;
        }
      }
    }
    const logToExcl = Math.max(cur.tail_hint, maxSeq + 1);
    let logEntriesPresent = 0;
    for (let s = logFrom; s < logToExcl; s++) {
      if (presentSeqs.has(s)) {
        logEntriesPresent++;
      } else {
        findings.push({
          severity: "finding",
          check: "log",
          message: `missing log entry at seq ${s} inside [log_seq_start, tail)`,
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
