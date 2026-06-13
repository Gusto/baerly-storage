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
 *   5. Report `triggers.crons` as optional. In-band write-triggered
 *      maintenance is the default; cron only drives an explicit
 *      `runScheduledMaintenance` sweep when the operator opts in.
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
import { BaerlyError, SHARED_SECRET_MISSING_MESSAGE } from "@baerly/protocol";
import type { AppConfig } from "../config.ts";
import { ensureBindings, parseR2Bindings, type ProcessRunner } from "../deploy/cloudflare.ts";

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
    if (f.severity === "error") {
      return "error";
    }
    if (f.severity === "warning") {
      worst = "warning";
    }
  }
  return worst;
};

/**
 * Read the declared cron schedule from `wrangler.jsonc`. Returns
 * `[]` when missing — caller treats empty as ok; in-band
 * write-triggered maintenance is the default and needs no cron.
 */
const readDeclaredCrons = (wranglerPath: string): readonly string[] => {
  const text = readFileSync(wranglerPath, "utf8");
  const errors: ParseError[] = [];
  const obj = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as
    | { triggers?: { crons?: unknown } }
    | undefined;
  if (errors.length > 0 || obj === undefined) {
    return [];
  }
  const crons = obj.triggers?.crons;
  if (!Array.isArray(crons)) {
    return [];
  }
  return crons.filter((c): c is string => typeof c === "string");
};

/** Read declared `routes[].pattern` array from `wrangler.jsonc`. */
const readDeclaredRoutePatterns = (wranglerPath: string): readonly string[] => {
  const text = readFileSync(wranglerPath, "utf8");
  const errors: ParseError[] = [];
  const obj = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as
    | { routes?: unknown }
    | undefined;
  if (errors.length > 0 || obj === undefined) {
    return [];
  }
  const routes = obj.routes;
  if (!Array.isArray(routes)) {
    return [];
  }
  return routes
    .map((r) =>
      r !== null && typeof r === "object" ? (r as { pattern?: unknown }).pattern : undefined,
    )
    .filter((p): p is string => typeof p === "string");
};

/** Read declared `vars` keys from `wrangler.jsonc`. */
const readDeclaredVarKeys = (wranglerPath: string): readonly string[] => {
  const text = readFileSync(wranglerPath, "utf8");
  const errors: ParseError[] = [];
  const obj = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as
    | { vars?: Record<string, unknown> }
    | undefined;
  if (errors.length > 0 || obj === undefined || obj.vars === undefined) {
    return [];
  }
  return Object.keys(obj.vars);
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
  } = {},
): Promise<DoctorReport> => {
  const repoRoot = opts.cwd ?? config.repoRoot;
  const wranglerPath = resolve(repoRoot, "wrangler.jsonc");
  const findings: DoctorFinding[] = [];

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
  } catch (error) {
    if (error instanceof BaerlyError && error.code === "InvalidConfig") {
      findings.push({
        severity: "error",
        check: "wrangler.jsonc.parse",
        message: error.message,
      });
      return { findings, status: rollupStatus(findings) };
    }
    throw error;
  }

  if (opts.fix === true && opts.runner !== undefined) {
    // Run the same provisioning path the deploy fallback uses.
    // Any failure here surfaces as an error finding rather than
    // throwing — doctor's job is to report.
    try {
      await ensureBindings(opts.runner, repoRoot, wranglerPath);
    } catch (error) {
      findings.push({
        severity: "error",
        check: "r2.fix",
        message: error instanceof Error ? error.message : "unknown error during ensureBindings",
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
  //
  //    `configured` is lifted to the outer scope so the auth-posture
  //    block below can read the deployed secret set without re-running
  //    `wrangler secret list`. Empty when the runner is absent or the
  //    listing call failed.
  const required = config.requiredSecrets ?? ["SHARED_SECRET"];
  let configured: readonly string[] = [];
  if (opts.runner !== undefined && required.length > 0) {
    const r = await opts.runner.run("wrangler", ["secret", "list"], repoRoot);
    if (r.code !== 0) {
      findings.push({
        severity: "warning",
        check: "secrets",
        message: "could not list secrets (wrangler exit non-zero); skipping check.",
      });
    } else {
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

  // 7. config.auth — graduated-auth posture. Walks the typed `auth`
  //    field added in `packages/protocol/src/app-config.ts`.
  //    FAIL: shared-secret without SHARED_SECRET set on the worker.
  //    WARN: auth: "none" + deploy target (operator may have a
  //          network gate in front; surface it so they confirm).
  //    INFO: CF Access vars present + adapter uses config.auth (auth
  //          is using config.auth, CF Access env is inert).
  //
  //    The presence of the typed field is guaranteed by the loader
  //    (config.ts throws on omission), so we walk every loaded config
  //    without an existence guard.
  if (config.auth === "none") {
    // Deploy-target check: "cloudflare" / "node" are the only valid
    // values, and both ship to a network-reachable runtime. We warn
    // unconditionally — the doctor's job is to surface the choice,
    // not to second-guess whether the operator's network seam (CF
    // Access, intranet ACL, Tunnel) is upstream.
    findings.push({
      severity: "warning",
      check: "auth.none-on-deploy",
      message:
        `baerly.config.ts has auth: "none" and ships to target=${JSON.stringify(config.target)}. ` +
        "Every request will resolve to config.tenant with no header check. " +
        "Put a network gate in front (CF Access, an upstream JWT, Cloudflare Tunnel, intranet ACL, …) " +
        'or change `auth` to "shared-secret" or pass a custom `verifier:` on the adapter factory.',
      fix:
        'Edit baerly.config.ts: set `auth: "shared-secret"` and run `wrangler secret put SHARED_SECRET`; ' +
        'or keep `auth: "none"` and wire CF Access in `wrangler.jsonc:vars` + pass a `verifier:` override in `src/server/index.ts`.',
    });
  }

  if (config.auth === "shared-secret" && opts.runner !== undefined) {
    // Mirror the FAIL message wording from the adapter's runtime
    // throw. Locked via `SHARED_SECRET_MISSING_MESSAGE` so doctor +
    // adapter stay in sync.
    //
    // If `configured` is still empty here, the `wrangler secret list`
    // invocation either failed (we already warned with the "secrets"
    // finding above) or really lists no secrets. Either way the
    // operator-facing remediation is the same.
    const requiredSecret = "SHARED_SECRET";
    if (!configured.includes(requiredSecret)) {
      findings.push({
        severity: "error",
        check: "auth.shared-secret-missing",
        message: SHARED_SECRET_MISSING_MESSAGE,
        fix:
          "wrangler secret put SHARED_SECRET (for production) " +
          "or add SHARED_SECRET=<value> to .dev.vars (for `wrangler dev`).",
      });
    }
  }

  // INFO: CF Access env vars in wrangler.jsonc:vars but the adapter
  // is using `config.auth` for the verifier (so the env values are
  // inert). We can't statically parse the user's worker source —
  // surface the heuristic.
  const varKeys = new Set(readDeclaredVarKeys(wranglerPath));
  if (varKeys.has("CF_ACCESS_TEAM_DOMAIN") && varKeys.has("CF_ACCESS_AUDIENCE_TAG")) {
    findings.push({
      severity: "info",
      check: "auth.cf-access-inert",
      message:
        `CF Access env vars (CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUDIENCE_TAG) are set in ${wranglerPath} ` +
        `but the adapter uses config.auth=${JSON.stringify(config.auth)}. ` +
        `To wire CF Access, pass \`verifier: cloudflareAccess({ teamDomain, audienceTag })\` on the baerlyWorker factory.`,
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

  // 5. Cron triggers — optional. In-band write-tick maintenance is
  //    the default; cron only exists for an explicit out-of-band sweep.
  const crons = readDeclaredCrons(wranglerPath);
  if (crons.length === 0) {
    findings.push({
      severity: "ok",
      check: "triggers.crons",
      message: "no cron triggers declared; in-band write-triggered maintenance is the default.",
    });
  } else {
    findings.push({
      severity: "info",
      check: "triggers.crons",
      message:
        `cron trigger${crons.length === 1 ? "" : "s"} ${crons.map((c) => JSON.stringify(c)).join(", ")} declared ` +
        "for opt-in scheduled maintenance; write-triggered maintenance still runs by default.",
    });
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
