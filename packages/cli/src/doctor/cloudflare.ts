/**
 * `baerly doctor --target=cloudflare` — walks the Cloudflare
 * deploy invariants and reports. With `--fix`, remediates what
 * can be safely auto-fixed (R2 bucket creation; secret prompts
 * are still user-driven because `wrangler secret put` reads
 * stdin interactively).
 *
 * Checks (each emitting one {@link DoctorFinding}):
 *   1. `wrangler.jsonc` exists at the package root.
 *   2. Each declared R2 binding exists in CF
 *      (`wrangler r2 bucket info`).
 *   3. Each `requiredSecrets` entry is in `wrangler secret list`.
 *   4. If `cloudflareAccess` is set in `baerly.config.ts`,
 *      `audienceTag` is 64 lowercase-hex chars and `teamDomain`
 *      is non-empty.
 *   5. If `triggers.crons` is empty, warn that the maintenance
 *      loop won't run.
 *   6. If `baerly.config.ts:domain` is set but `wrangler.jsonc`
 *      doesn't declare a matching `routes` entry, warn.
 *
 * Output is a structured {@link DoctorReport} that
 * `packages/cli/src/doctor.ts` renders as either a checklist
 * (text mode) or a JSON envelope (`--json` mode).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { minioStorage, r2Storage } from "@baerly/adapter-node";
import { BaerlyError, type Storage } from "@baerly/protocol";
import type { AppConfig } from "../config.ts";
import { ensureBindings, parseR2Bindings, type ProcessRunner } from "../deploy/cloudflare.ts";
import { runUsageScan } from "./usage.ts";

/** One finding from a `baerly doctor` walk. */
export interface DoctorFinding {
  /** Severity. `ok` / `info` don't move the overall status. */
  readonly severity: "ok" | "info" | "warning" | "error";
  /** Short check name — stable, machine-readable. */
  readonly check: string;
  /** Human-friendly description. */
  readonly message: string;
  /** Optional remediation hint. */
  readonly fix?: string;
}

/** Result of a `baerly doctor` walk. */
export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
  /**
   * Overall: `ok` only when every finding has severity `ok` or
   * `info`. `warning` when the worst finding is a warning. `error`
   * when any finding is an error.
   */
  readonly status: "ok" | "warning" | "error";
}

const rollupStatus = (findings: readonly DoctorFinding[]): DoctorReport["status"] => {
  let worst: DoctorReport["status"] = "ok";
  for (const f of findings) {
    if (f.severity === "error") return "error";
    if (f.severity === "warning") worst = "warning";
  }
  return worst;
};

/**
 * Read the declared cron schedule from `wrangler.jsonc`. Returns
 * `[]` when missing — caller treats empty as a warning.
 */
const readDeclaredCrons = (wranglerPath: string): readonly string[] => {
  const text = readFileSync(wranglerPath, "utf8");
  const errors: ParseError[] = [];
  const obj = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as
    | { triggers?: { crons?: unknown } }
    | undefined;
  if (errors.length > 0 || obj === undefined) return [];
  const crons = obj.triggers?.crons;
  if (!Array.isArray(crons)) return [];
  return crons.filter((c): c is string => typeof c === "string");
};

/** Read declared `routes[].pattern` array from `wrangler.jsonc`. */
const readDeclaredRoutePatterns = (wranglerPath: string): readonly string[] => {
  const text = readFileSync(wranglerPath, "utf8");
  const errors: ParseError[] = [];
  const obj = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as
    | { routes?: unknown }
    | undefined;
  if (errors.length > 0 || obj === undefined) return [];
  const routes = obj.routes;
  if (!Array.isArray(routes)) return [];
  return routes
    .map((r) =>
      r !== null && typeof r === "object" ? (r as { pattern?: unknown }).pattern : undefined,
    )
    .filter((p): p is string => typeof p === "string");
};

/**
 * Walk the Cloudflare deploy invariants. With `opts.fix === true`,
 * remediate the auto-fixable issues (bucket creation). Secret
 * prompts stay user-driven.
 */
export const doctorCloudflare = async (
  config: AppConfig,
  opts: {
    readonly runner?: ProcessRunner;
    readonly fix?: boolean;
    readonly cwd?: string;
    /**
     * Opt-in usage-scan flag mirrored from the Node target. Wires
     * the `r2Storage` factory from `@baerly/adapter-node` against the
     * R2 S3-compat endpoint (derived from `CF_ACCOUNT_ID`) using an
     * account-scoped R2 API token (`R2_ACCESS_KEY_ID` +
     * `R2_SECRET_ACCESS_KEY`), then runs the same writes/min
     * estimator the Node target uses. Bucket name is read from the
     * parsed R2 bindings (the `BUCKET` binding by default). An
     * explicit `R2_ENDPOINT` env var routes through `minioStorage`
     * for callers fronting R2 with a custom proxy.
     */
    readonly usage?: boolean;
    /**
     * Findings produced by dispatcher-level checks (today:
     * `--check=index-filter-drift`). Spliced into the local
     * findings list before rollup so the named check's findings
     * influence the report's overall status without forcing every
     * dispatcher-level check to live inside this backend.
     */
    readonly extraFindings?: readonly DoctorFinding[];
  } = {},
): Promise<DoctorReport> => {
  const repoRoot = opts.cwd ?? config.repoRoot;
  const wranglerPath = resolve(repoRoot, "wrangler.jsonc");
  // Seed the findings list with any dispatcher-level results
  // (today: `--check=index-filter-drift`). These influence rollup
  // status the same way local findings do, and they appear at the
  // top of the rendered output so the operator sees them before
  // the wrangler / R2 / secret checks.
  const findings: DoctorFinding[] = opts.extraFindings ? [...opts.extraFindings] : [];

  // 1. wrangler.jsonc presence.
  if (!existsSync(wranglerPath)) {
    findings.push({
      severity: "error",
      check: "wrangler.jsonc",
      message: `Expected wrangler.jsonc at the package root: ${wranglerPath}.`,
      fix: "Re-scaffold (npm create baerly@latest) or restore the file from git.",
    });
    return { findings, status: rollupStatus(findings) };
  }
  findings.push({
    severity: "ok",
    check: "wrangler.jsonc",
    message: `${wranglerPath} found.`,
  });

  // 2. R2 bindings — parse first, then probe each.
  let declared: readonly { binding: string; bucket_name: string }[];
  try {
    declared = parseR2Bindings(wranglerPath);
  } catch (e) {
    if (e instanceof BaerlyError && e.code === "InvalidConfig") {
      findings.push({
        severity: "error",
        check: "wrangler.jsonc.parse",
        message: e.message,
      });
      return { findings, status: rollupStatus(findings) };
    }
    throw e;
  }

  if (opts.fix === true && opts.runner !== undefined) {
    // Run the same provisioning path the deploy fallback uses.
    // Any failure here surfaces as an error finding rather than
    // throwing — doctor's job is to report.
    try {
      await ensureBindings(opts.runner, repoRoot, wranglerPath);
    } catch (e) {
      findings.push({
        severity: "error",
        check: "r2.fix",
        message: e instanceof Error ? e.message : "unknown error during ensureBindings",
      });
    }
  }

  if (opts.runner !== undefined) {
    for (const { bucket_name } of declared) {
      const info = await opts.runner.run(
        "wrangler",
        ["r2", "bucket", "info", bucket_name],
        repoRoot,
      );
      if (info.code === 0) {
        findings.push({
          severity: "ok",
          check: `r2.${bucket_name}`,
          message: `R2 bucket "${bucket_name}" exists.`,
        });
      } else {
        findings.push({
          severity: "error",
          check: `r2.${bucket_name}`,
          message: `R2 bucket "${bucket_name}" not found.`,
          fix: `wrangler r2 bucket create ${bucket_name} (or re-run with --fix)`,
        });
      }
    }
  } else {
    findings.push({
      severity: "info",
      check: "r2.skip",
      message: "no runner supplied; skipped R2 bucket probes.",
    });
  }

  // 3. requiredSecrets — best-effort.
  const required = config.requiredSecrets ?? ["SHARED_SECRET"];
  if (opts.runner !== undefined && required.length > 0) {
    const r = await opts.runner.run("wrangler", ["secret", "list"], repoRoot);
    if (r.code !== 0) {
      findings.push({
        severity: "warning",
        check: "secrets",
        message: "could not list secrets (wrangler exit non-zero); skipping check.",
      });
    } else {
      let configured: readonly string[] = [];
      try {
        const parsed = JSON.parse(r.stdout) as unknown;
        if (Array.isArray(parsed)) {
          configured = parsed
            .map((s) =>
              s !== null && typeof s === "object" ? (s as { name?: unknown }).name : undefined,
            )
            .filter((n): n is string => typeof n === "string");
        }
      } catch {
        // fall through with empty configured set
      }
      for (const name of required) {
        if (configured.includes(name)) {
          findings.push({
            severity: "ok",
            check: `secret.${name}`,
            message: `secret ${name} is set.`,
          });
        } else {
          findings.push({
            severity: "warning",
            check: `secret.${name}`,
            message: `secret ${name} is required but unset.`,
            fix: `wrangler secret put ${name}`,
          });
        }
      }
    }
  } else if (required.length > 0) {
    findings.push({
      severity: "info",
      check: "secrets.skip",
      message: "no runner supplied; skipped secret checks.",
    });
  }

  // 4. cloudflareAccess — when configured, audience tag must be
  //    64 lowercase-hex chars.
  if (config.cloudflareAccess !== undefined) {
    const { teamDomain, audienceTag } = config.cloudflareAccess;
    if (teamDomain.length === 0) {
      findings.push({
        severity: "error",
        check: "cloudflareAccess.teamDomain",
        message: "cloudflareAccess.teamDomain in baerly.config.ts is empty.",
      });
    }
    if (!/^[0-9a-f]{64}$/.test(audienceTag)) {
      findings.push({
        severity: "error",
        check: "cloudflareAccess.audienceTag",
        message: `cloudflareAccess.audienceTag must be 64 lowercase-hex chars (got ${JSON.stringify(audienceTag)}).`,
        fix: "Copy the AUD tag from the Cloudflare Access app's configuration tab.",
      });
    } else if (teamDomain.length > 0) {
      findings.push({
        severity: "ok",
        check: "cloudflareAccess",
        message: `cloudflareAccess audience tag is well-formed; team domain "${teamDomain}".`,
      });
    }
  }

  // 5. Cron triggers — empty list means the maintenance loop won't
  //    run.
  const crons = readDeclaredCrons(wranglerPath);
  if (crons.length === 0) {
    findings.push({
      severity: "warning",
      check: "triggers.crons",
      message: "no cron triggers declared; the maintenance loop will not run automatically.",
      fix: `Add "triggers": { "crons": ["* * * * *"] } to ${wranglerPath}.`,
    });
  } else {
    findings.push({
      severity: "ok",
      check: "triggers.crons",
      message: `cron trigger${crons.length === 1 ? "" : "s"} ${crons.map((c) => JSON.stringify(c)).join(", ")} declared.`,
    });
  }

  // 7. --usage scan (opt-in). Reads R2 credentials + account id from
  //    process.env and lists recent log entries per collection
  //    against the R2 S3-compat endpoint. Independent of the
  //    invariant checks above — a missing wrangler binding doesn't
  //    suppress usage findings provided one declared binding exists.
  if (opts.usage === true) {
    await runUsageCheck(config, declared, findings);
  }

  // 6. domain ↔ routes coherence.
  if (config.domain !== undefined && config.domain.length > 0) {
    const patterns = readDeclaredRoutePatterns(wranglerPath);
    const expectedPrefix = `${config.domain}/`;
    const hasMatch = patterns.some(
      (p) => p === config.domain || p === expectedPrefix || p.startsWith(expectedPrefix),
    );
    if (!hasMatch) {
      findings.push({
        severity: "warning",
        check: "routes.domain",
        message: `baerly.config.ts declares domain ${JSON.stringify(config.domain)} but ${wranglerPath} has no matching routes[].pattern.`,
        fix: `Add { "pattern": "${config.domain}/*", "custom_domain": true } to wrangler.jsonc:routes.`,
      });
    } else {
      findings.push({
        severity: "ok",
        check: "routes.domain",
        message: `routes[].pattern matches domain ${JSON.stringify(config.domain)}.`,
      });
    }
  }

  return { findings, status: rollupStatus(findings) };
};

/**
 * Append usage findings to `findings` for the Cloudflare target.
 * Reads `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
 * (and optionally `R2_ENDPOINT` for a custom S3-compat URL) from
 * `process.env`, picks the R2 binding to scan (the `BUCKET` binding
 * by convention, else the first declared), and runs the
 * pure-storage estimator via `runUsageScan`.
 *
 * Missing env vars emit a single `usage-env-vars` error finding
 * (exit 2 per the dispatcher contract) and short-circuit the scan.
 * No declared R2 bindings emits a warning and skips. Per-collection
 * failures degrade to warning-severity findings inside
 * `runUsageScan` so one bad collection doesn't abort the whole
 * scan.
 */
const runUsageCheck = async (
  config: AppConfig,
  declared: readonly { binding: string; bucket_name: string }[],
  findings: DoctorFinding[],
): Promise<void> => {
  const missing: string[] = [];
  for (const k of ["CF_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
    const v = process.env[k];
    if (v === undefined || v === "") missing.push(k);
  }
  if (missing.length > 0) {
    findings.push({
      severity: "error",
      check: "usage-env-vars",
      message: `--usage needs ${missing.join(", ")} on the environment; skipped bucket scan.`,
      fix: "Mint an R2 API token in the Cloudflare dashboard (R2 → Manage R2 API Tokens) and export `CF_ACCOUNT_ID=<account id>`, `R2_ACCESS_KEY_ID=...`, `R2_SECRET_ACCESS_KEY=...` before running `baerly doctor --target=cloudflare --usage`.",
    });
    return;
  }

  // Pick a bucket. Prefer the `BUCKET` binding (the convention from
  // `@baerly/adapter-cloudflare`'s `Env`); fall back to the first
  // declared binding for unusual setups.
  const bucketBinding = declared.find((d) => d.binding === "BUCKET") ?? declared[0];
  if (bucketBinding === undefined) {
    findings.push({
      severity: "warning",
      check: "usage-no-binding",
      message: `--usage: no R2 bindings declared in wrangler.jsonc; nothing to scan.`,
    });
    return;
  }

  // Prefer the R2 factory (derives the endpoint from `accountId`); fall
  // back to `minioStorage` when the operator pins a custom `R2_ENDPOINT`
  // (e.g. a private S3-compat proxy in front of R2).
  const accessKeyId = process.env["R2_ACCESS_KEY_ID"]!;
  const secretAccessKey = process.env["R2_SECRET_ACCESS_KEY"]!;
  const bucket = bucketBinding.bucket_name;
  const customEndpoint = process.env["R2_ENDPOINT"];
  const storage: Storage =
    customEndpoint !== undefined && customEndpoint !== ""
      ? minioStorage({ endpoint: customEndpoint, bucket, accessKeyId, secretAccessKey })
      : r2Storage({
          accountId: process.env["CF_ACCOUNT_ID"]!,
          bucket,
          accessKeyId,
          secretAccessKey,
        });

  await runUsageScan({ app: config.app, tenant: config.tenant }, storage, findings);
};
