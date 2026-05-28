/**
 * `baerly admin usage` — all-collection writes/min health check.
 *
 * Reads the most recent `SAMPLE_SIZE` log entries for every collection
 * under `app/<app>/tenant/<tenant>/manifests/`, compares the spread of
 * their embedded `commit_ts` timestamps against the M-size operating
 * ceiling (~30 writes/min/collection — see
 * `docs/about/thesis.md:50-68`), and prints one finding per collection
 * — `info` when well under the ceiling, `warning` when approaching or
 * exceeding it.
 *
 * Distinct from `baerly cost` (the per-table, $/month projection):
 * `cost` is a developer-facing trajectory for one table, `usage` is an
 * operator-facing M-size graduation health check across all
 * collections.
 *
 * The pure-storage half — {@link estimateWritesPerMin},
 * {@link discoverCollections}, {@link runUsageScan} — takes a
 * `Storage` handle from the caller and never reads `process.env`.
 * The CLI wrapper at the bottom of the file constructs that
 * `Storage` from `--bucket=<uri>` via `parseBucketUri`. The
 * Cloudflare target short-circuits with an info-level "not yet
 * wired" finding pending the follow-up work in
 * `docs/followups/agent-friendliness.md` entry 10.
 *
 * Why GET each entry instead of relying on list-time
 * `Last-Modified`: `MemoryStorage` (the test backend) intentionally
 * does NOT surface `lastModified` on `list()`, and the
 * cross-backend story stays uniform if we always read `commit_ts`
 * from the `LogEntry` body. Sample size is bounded (`SAMPLE_SIZE`
 * GETs per collection), so the cost is acceptable for an opt-in
 * operator command.
 *
 * @see docs/about/thesis.md — M-size ceiling rationale.
 * @see docs/spec/log-entry-shape.md — `LogEntry.commit_ts` contract.
 * @see packages/server/src/compactor.ts:224-225 — `collectionPrefix` /
 *      `collectionName` derivation pattern reused here.
 */

import { type ArgsDef } from "citty";
import { BaerlyError, decodeJsonBytes, type LogEntry, type Storage } from "@baerly/protocol";
import { parseBucketUri } from "../bucket-uri.ts";
import { loadAppConfig } from "../config.ts";
import { emitSuccess, isJsonMode } from "../output.ts";
import { defineBaerlySubcommand } from "../subcommand.ts";

/**
 * Verdict-shaped finding the scan emits. Mirrors the
 * `severity / check / message / fix?` shape that `baerly doctor` uses,
 * but doesn't depend on `doctor/cloudflare.ts` — `admin usage` runs
 * outside the doctor surface.
 */
export interface UsageFinding {
  readonly severity: "ok" | "info" | "warning" | "error";
  readonly check: string;
  readonly message: string;
  readonly fix?: string;
}

/**
 * M-size writes-per-minute-per-collection ceiling from
 * `docs/about/thesis.md`. Crossing this with sustained traffic
 * means operators should consider graduating the workload to a
 * graduated store via `baerly export --target=postgres|sqlite|d1`.
 */
export const M_SIZE_WRITES_PER_MIN_PER_COLLECTION = 30;

/** Number of trailing log entries the estimator reads per collection. */
const SAMPLE_SIZE = 120;

/** Per-collection verdict surfaced by {@link estimateWritesPerMin}. */
export interface UsageVerdict {
  /** Collection name (matches `LogEntry.collection`). */
  readonly collection: string;
  /**
   * Writes per minute estimated over the sample window. `NaN` when
   * fewer than 2 entries were observed (no defensible rate).
   */
  readonly writesPerMin: number;
  /** Percent of {@link M_SIZE_WRITES_PER_MIN_PER_COLLECTION}; `NaN` propagates. */
  readonly percentOfCeiling: number;
  /**
   * Severity scaled by distance to ceiling:
   *   - `< 50%`  → `"info"`
   *   - `50–99%` → `"warning"` ("approaching ceiling")
   *   - `≥ 100%` → `"warning"` ("exceeds ceiling — consider export")
   *
   * Severity `warning` never bumps the doctor's exit code above 0
   * (operators can still deploy / continue while approaching the
   * ceiling).
   */
  readonly severity: "info" | "warning";
  /** Human-readable one-liner suitable for a {@link UsageFinding}. */
  readonly message: string;
  /** Empty when no remediation is meaningful (under 50%). */
  readonly fix: string;
}

/** Build the canonical `current.json` key for one collection. */
export const currentJsonKeyFor = (app: string, tenant: string, collection: string): string =>
  `app/${app}/tenant/${tenant}/manifests/${collection}/current.json`;

/** Derive the `collectionPrefix` (everything before `/current.json`). */
export const collectionPrefixOf = (currentJsonKey: string): string =>
  currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));

/**
 * List every log key under `${collectionPrefix}/log/` for one collection.
 * Returns the keys in **chronological order** (oldest seq first).
 *
 * The on-bucket key shape is `<collectionPrefix>/log/<seq>.json` where
 * `<seq>` is a base-10 integer minted by `Writer`. Lex-ascending
 * key order disagrees with numeric seq order past seq=9 (`log/10.json`
 * sorts before `log/2.json`), so we parse the trailing integer out of
 * each key and sort numerically.
 *
 * Caller is expected to slice the trailing N entries — the writes/min
 * estimator only needs the most recent sample.
 */
// Parse the `<seq>` integer from a `<logPrefix>/<seq>.json` key. Returns
// `NaN` when the basename isn't a finite integer (the caller filters
// those out before sorting). Hoisted out of {@link listLogKeysSortedBySeq}
// so a function instance isn't allocated per list entry.
const seqOfLogKey = (key: string): number => {
  const slash = key.lastIndexOf("/");
  const dot = key.lastIndexOf(".json");
  if (slash === -1 || dot === -1 || dot <= slash) {
    return Number.NaN;
  }
  const seqStr = key.slice(slash + 1, dot);
  const n = Number.parseInt(seqStr, 10);
  return Number.isFinite(n) ? n : Number.NaN;
};

const listLogKeysSortedBySeq = async (
  storage: Storage,
  logPrefix: string,
): Promise<readonly string[]> => {
  const keys: string[] = [];
  for await (const entry of storage.list(logPrefix)) {
    keys.push(entry.key);
  }
  return keys
    .filter((k) => Number.isFinite(seqOfLogKey(k)))
    .toSorted((a, b) => seqOfLogKey(a) - seqOfLogKey(b));
};

/**
 * Fetch a `LogEntry` body at `key`, returning its `commit_ts` parsed
 * to epoch-ms. Returns `null` when the object is missing (a peer may
 * have GC'd it between list and get); throws `BaerlyError` on a
 * malformed body so the caller can downgrade the whole collection's
 * scan to an error-level finding.
 */
const readCommitTsMs = async (storage: Storage, key: string): Promise<number | null> => {
  const got = await storage.get(key);
  if (got === null) {
    return null;
  }
  let parsed: LogEntry;
  try {
    parsed = decodeJsonBytes<LogEntry>(got.body);
  } catch (error) {
    throw new BaerlyError(
      "InvalidResponse",
      `usage scan: log entry at ${key} is not valid JSON`,
      error,
    );
  }
  if (typeof parsed.commit_ts !== "string") {
    throw new BaerlyError("InvalidResponse", `usage scan: log entry at ${key} missing commit_ts`);
  }
  const ms = Date.parse(parsed.commit_ts);
  if (!Number.isFinite(ms)) {
    throw new BaerlyError(
      "InvalidResponse",
      `usage scan: log entry at ${key} has unparseable commit_ts ${JSON.stringify(parsed.commit_ts)}`,
    );
  }
  return ms;
};

/**
 * Read each key with bounded concurrency. Mirrors the pattern in
 * `packages/server/src/log-walk.ts` — we cap parallelism to keep a
 * single doctor pass from blowing through the storage backend's
 * connection budget. Keeps a small constant rather than reaching for
 * `MAX_PARALLEL_LOG_READS` (8) so the doctor command is gentle by
 * default.
 */
const PARALLEL_READS = 8;

const readCommitTsBatched = async (
  storage: Storage,
  keys: readonly string[],
): Promise<readonly (number | null)[]> => {
  const out: (number | null)[] = Array.from({ length: keys.length });
  for (let i = 0; i < keys.length; i += PARALLEL_READS) {
    const chunk = keys.slice(i, i + PARALLEL_READS);
    const results = await Promise.all(chunk.map((k) => readCommitTsMs(storage, k)));
    for (let j = 0; j < results.length; j++) {
      out[i + j] = results[j] ?? null;
    }
  }
  return out;
};

/**
 * Estimate writes/min for one collection.
 *
 * Reads the last `sampleSize` log entries (default `SAMPLE_SIZE`)
 * for `<app>/<tenant>/<collection>`, computes
 *   `(observedEntries - 1) / ((maxTs - minTs) / 60_000)`
 * minutes, compares against {@link M_SIZE_WRITES_PER_MIN_PER_COLLECTION},
 * and returns a {@link UsageVerdict}.
 *
 * Edge cases:
 *   - Fewer than 2 entries observable → `writesPerMin = NaN`,
 *     severity `info`, no fix. Operators see "not enough log
 *     entries to estimate."
 *   - All entries share the same `commit_ts` (e.g. a tight batch) →
 *     the denominator is clamped to 1 second so the rate degrades
 *     gracefully instead of dividing by zero.
 *
 * @throws BaerlyError code="NetworkError" — wrapped storage failure
 *   while listing. The caller (Node doctor backend) catches and
 *   converts to a warning-severity finding so one bad collection
 *   doesn't fail the whole scan.
 * @throws BaerlyError code="InvalidResponse" — a sampled log entry
 *   body is malformed; same caller treatment.
 * @param opts.keyPrefix - When the bucket has a non-empty key prefix
 *   (e.g. `s3://my-bucket/some/prefix`), pass it here (ending in
 *   `/`). Defaults to `""`. Necessary for prefixed-bucket
 *   correctness; ignored by `runUsageScan` (Node doctor scans the
 *   root). Threaded through by `baerly inspect`.
 */
export const estimateWritesPerMin = async (
  storage: Storage,
  app: string,
  tenant: string,
  collection: string,
  opts: { readonly sampleSize?: number; readonly keyPrefix?: string } = {},
): Promise<UsageVerdict> => {
  const sampleSize = opts.sampleSize ?? SAMPLE_SIZE;
  const keyPrefix = opts.keyPrefix ?? "";
  const collectionPrefix = `${keyPrefix}${collectionPrefixOf(currentJsonKeyFor(app, tenant, collection))}`;
  const logPrefix = `${collectionPrefix}/log/`;

  let allKeys: readonly string[];
  try {
    allKeys = await listLogKeysSortedBySeq(storage, logPrefix);
  } catch (error) {
    if (error instanceof BaerlyError) {
      throw error;
    }
    throw new BaerlyError(
      "NetworkError",
      `usage scan: list ${logPrefix} failed: ${(error as Error).message}`,
      error,
    );
  }
  const sample = allKeys.slice(Math.max(0, allKeys.length - sampleSize));
  if (sample.length < 2) {
    return {
      collection,
      writesPerMin: Number.NaN,
      percentOfCeiling: Number.NaN,
      severity: "info",
      message: `collection ${collection}: not enough log entries to estimate (saw ${sample.length}, need >= 2)`,
      fix: "",
    };
  }
  const commitTs = await readCommitTsBatched(storage, sample);
  const timestamps = commitTs.filter((v): v is number => v !== null);
  if (timestamps.length < 2) {
    return {
      collection,
      writesPerMin: Number.NaN,
      percentOfCeiling: Number.NaN,
      severity: "info",
      message: `collection ${collection}: not enough readable log entries to estimate (resolved ${timestamps.length}, need >= 2)`,
      fix: "",
    };
  }
  let minTs = timestamps[0]!;
  let maxTs = timestamps[0]!;
  for (const t of timestamps) {
    if (t < minTs) {
      minTs = t;
    }
    if (t > maxTs) {
      maxTs = t;
    }
  }
  // Guard the denominator: a tight batch may produce identical
  // commit_ts values; degrade to a one-second window so we never
  // divide by zero.
  const minutes = Math.max(1 / 60, (maxTs - minTs) / 60_000);
  const writesPerMin = (timestamps.length - 1) / minutes;
  const pct = (writesPerMin / M_SIZE_WRITES_PER_MIN_PER_COLLECTION) * 100;

  let severity: "info" | "warning" = "info";
  let message = `collection ${collection}: ${writesPerMin.toFixed(1)} writes/min (~${pct.toFixed(0)}% of M-size ceiling, sampled ${timestamps.length} entries)`;
  let fix = "";
  if (pct >= 100) {
    severity = "warning";
    message += " — exceeds the M-size ceiling.";
    fix = `consider graduating: \`baerly export --target=postgres|sqlite|d1 --bucket=<bucket> --app=${app} --tenant=${tenant} --collection=${collection}\``;
  } else if (pct >= 50) {
    severity = "warning";
    message += " — approaching the M-size ceiling.";
    fix = "monitor; plan graduation via `baerly export --target=postgres|sqlite|d1`";
  }
  return { collection, writesPerMin, percentOfCeiling: pct, severity, message, fix };
};

/**
 * Discover the set of collections under `<app>/<tenant>/manifests/`
 * by listing the bucket. Each collection is the immediate
 * subdirectory name (the segment after `manifests/` and before the
 * next `/`).
 *
 * Returns a deduped, lex-sorted list. An empty list means there are
 * no committed collections under this app/tenant yet — the caller
 * surfaces a single info finding rather than scanning per-collection.
 *
 * @throws BaerlyError code="NetworkError" — wrapped list failure.
 */
export const discoverCollections = async (
  storage: Storage,
  app: string,
  tenant: string,
): Promise<readonly string[]> => {
  const prefix = `app/${app}/tenant/${tenant}/manifests/`;
  const names = new Set<string>();
  try {
    for await (const entry of storage.list(prefix)) {
      const rest = entry.key.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (name.length > 0) {
        names.add(name);
      }
    }
  } catch (error) {
    if (error instanceof BaerlyError) {
      throw error;
    }
    throw new BaerlyError(
      "NetworkError",
      `usage scan: list ${prefix} failed: ${(error as Error).message}`,
      error,
    );
  }
  return [...names].toSorted();
};

/**
 * Orchestrate the usage scan against a caller-supplied
 * {@link Storage}. The CLI wrapper handles bucket-URI construction;
 * this helper runs the shared discover → per-collection-estimate →
 * finding-push loop.
 *
 * Mutates `findings` in place. Returns when the scan completes
 * (success or per-collection failure all surface as findings). The
 * outer CLI exit code is driven by the rollup over all findings.
 *
 * Errors land as warnings (not errors) so one bad collection doesn't
 * abort the whole scan and so the operator stays deployable while a
 * single object is being investigated.
 */
export const runUsageScan = async (
  context: { readonly app: string; readonly tenant: string },
  storage: Storage,
  findings: UsageFinding[],
): Promise<void> => {
  let collections: readonly string[];
  try {
    collections = await discoverCollections(storage, context.app, context.tenant);
  } catch (error) {
    findings.push({
      severity: "warning",
      check: "usage-discover",
      message: `could not enumerate collections under app/${context.app}/tenant/${context.tenant}/manifests/: ${error instanceof BaerlyError ? error.message : (error as Error).message}`,
    });
    return;
  }
  if (collections.length === 0) {
    findings.push({
      severity: "info",
      check: "usage-empty",
      message: `no collections found under app/${context.app}/tenant/${context.tenant}/manifests/; nothing to scan.`,
    });
    return;
  }
  for (const c of collections) {
    try {
      const verdict = await estimateWritesPerMin(storage, context.app, context.tenant, c);
      findings.push({
        severity: verdict.severity,
        check: `usage-${c}`,
        message: verdict.message,
        ...(verdict.fix !== "" && { fix: verdict.fix }),
      });
    } catch (error) {
      findings.push({
        severity: "warning",
        check: `usage-${c}`,
        message: `failed to estimate writes/min for ${c}: ${error instanceof BaerlyError ? error.message : (error as Error).message}`,
      });
    }
  }
};

// ---------------------------------------------------------------------------
// CLI surface — `baerly admin usage`
// ---------------------------------------------------------------------------

const USAGE_ARGS = {
  bucket: {
    type: "string",
    required: false,
    description:
      "Bucket URI (s3://<bucket>[/<prefix>], file:///<abs>, memory://<bucket>). Required for --target=node.",
    valueHint: "bucket-uri",
  },
  target: {
    type: "string",
    required: false,
    description: 'Override `baerly.config.ts:target`. One of "cloudflare" | "node".',
    valueHint: "target",
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
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

const SEVERITY_GLYPH: Record<UsageFinding["severity"], string> = {
  ok: "✓",
  info: "•",
  warning: "⚠",
  error: "✗",
};

const renderText = (target: string, findings: readonly UsageFinding[]): string => {
  const lines: string[] = [];
  lines.push(`baerly admin usage --target=${target}`);
  lines.push("");
  for (const f of findings) {
    lines.push(`  ${SEVERITY_GLYPH[f.severity]} ${f.message}`);
    if (f.fix !== undefined && f.fix !== "") {
      lines.push(`     fix: ${f.fix}`);
    }
  }
  let warnings = 0;
  let errors = 0;
  for (const f of findings) {
    if (f.severity === "warning") {
      warnings++;
    } else if (f.severity === "error") {
      errors++;
    }
  }
  lines.push("");
  lines.push(
    `Status: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`,
  );
  return lines.join("\n") + "\n";
};

const bundle = defineBaerlySubcommand({
  name: "admin.usage",
  meta: {
    description:
      "All-collection writes/min health check; flags collections approaching the M-size ceiling.",
  },
  args: USAGE_ARGS,
  handler: async (args, ctx) => {
    // Avoid loading the config when --target is explicit — the CLI
    // should still work outside an app directory if the operator
    // pins target + app + tenant on the flags.
    const target = args.target ?? (await loadAppConfig().then((c) => c.target));
    if (target !== "cloudflare" && target !== "node") {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly admin usage: unsupported --target ${JSON.stringify(target)} (one of "cloudflare" | "node")`,
      );
    }
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });

    const findings: UsageFinding[] = [];

    if (target === "cloudflare") {
      // The CLI runs in Node and can't reach a Workerd-side R2 binding
      // from `--bucket=<uri>`; full CF wiring is a follow-up — see
      // `docs/followups/agent-friendliness.md` entry 10.
      findings.push({
        severity: "info",
        check: "usage.cloudflare",
        message:
          "baerly admin usage is not yet wired for --target=cloudflare. See docs/followups/agent-friendliness.md entry 10.",
      });
    } else {
      if (args.bucket === undefined || args.bucket.length === 0) {
        throw new BaerlyError(
          "InvalidConfig",
          "baerly admin usage: --bucket=<uri> is required for --target=node",
        );
      }
      const parsed = await parseBucketUri(args.bucket);
      await runUsageScan({ app, tenant }, parsed.storage, findings);
    }

    if (isJsonMode()) {
      emitSuccess({
        command: "admin.usage",
        status: "ok",
        target,
        findings: findings.map((f) => ({
          severity: f.severity,
          check: f.check,
          message: f.message,
          ...(f.fix !== undefined && f.fix !== "" && { fix: f.fix }),
        })),
      });
    } else {
      process.stdout.write(renderText(target, findings));
    }
    return 0;
  },
});

/** citty `defineCommand` block for `baerly admin usage`. */
export const usageCmd = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runUsage = bundle.run;
