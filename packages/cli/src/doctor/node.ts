/**
 * `baerly doctor --target=node` — walk the Node deploy invariants
 * and report findings using the same {@link DoctorFinding} shape
 * the Cloudflare branch emits.
 *
 * Checks (each emitting one {@link DoctorFinding}):
 *   1. `apps/server/Dockerfile` exists.
 *   2. `apps/server/.dockerignore` exists.
 *   3. Dockerfile matches the emitted shape (token-level: warn when
 *      the distroless base is absent).
 *   4. `.env.example` documents each `requiredSecrets` entry.
 *   5. If `JWKS_URL` is set in `.env.example`, attempt to fetch it
 *      with a 3 s budget; warn on failure.
 *   6. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `BUCKET` are
 *      documented in `.env.example`.
 *   7. `systemd/baerly.service` (when present) is well-formed —
 *      contains `[Service]` and `ExecStart=`.
 *
 * Read-only: no `--fix` here. To re-emit a hand-edited artifact,
 * run `baerly deploy --target=node --force`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "../config.ts";
import type { DoctorFinding, DoctorReport } from "./cloudflare.ts";

const rollupStatus = (findings: readonly DoctorFinding[]): DoctorReport["status"] => {
  let worst: DoctorReport["status"] = "ok";
  for (const f of findings) {
    if (f.severity === "error") return "error";
    if (f.severity === "warning") worst = "warning";
  }
  return worst;
};

/**
 * Walk the Node deploy invariants. Returns a structured
 * {@link DoctorReport} the dispatcher renders as text or JSON.
 */
export const doctorNode = async (
  config: AppConfig,
  opts: { readonly cwd?: string } = {},
): Promise<DoctorReport> => {
  const repoRoot = opts.cwd ?? config.repoRoot;
  const serverDir = resolve(repoRoot, "apps", "server");
  const findings: DoctorFinding[] = [];
  const ok = (check: string, message: string): void => {
    findings.push({ severity: "ok", check, message });
  };
  const warn = (check: string, message: string, fix?: string): void => {
    findings.push({
      severity: "warning",
      check,
      message,
      ...(fix !== undefined && { fix }),
    });
  };
  const err = (check: string, message: string, fix?: string): void => {
    findings.push({
      severity: "error",
      check,
      message,
      ...(fix !== undefined && { fix }),
    });
  };

  // 1. apps/server/Dockerfile exists.
  const dfPath = join(serverDir, "Dockerfile");
  if (!existsSync(dfPath)) {
    err("Dockerfile present", `${dfPath} missing`, "baerly deploy --target=node");
  } else {
    ok("Dockerfile present", dfPath);
    // 3. Matches the emitted shape — token-level check. The
    //    canonical shape uses the distroless base; a hand-edited
    //    Dockerfile that picks a different base is a warning, not
    //    an error (users may have intentional reasons).
    const actual = readFileSync(dfPath, "utf8");
    if (!actual.includes("FROM gcr.io/distroless/nodejs24-debian12")) {
      warn(
        "Dockerfile matches emitted shape",
        "Dockerfile does not use the distroless base; ensure your image hardening is intentional",
        "baerly deploy --target=node --force",
      );
    } else {
      ok("Dockerfile matches emitted shape", "distroless final stage detected");
    }
  }

  // 2. apps/server/.dockerignore exists.
  if (!existsSync(join(serverDir, ".dockerignore"))) {
    warn(
      ".dockerignore present",
      "no .dockerignore — image size will be inflated",
      "baerly deploy --target=node",
    );
  } else {
    ok(".dockerignore present", join(serverDir, ".dockerignore"));
  }

  // 4. .env.example documents each requiredSecret.
  const envExamplePath = join(serverDir, ".env.example");
  const envText = existsSync(envExamplePath) ? readFileSync(envExamplePath, "utf8") : "";
  if (!existsSync(envExamplePath)) {
    warn(".env.example present", `${envExamplePath} missing`, "baerly deploy --target=node");
  } else {
    for (const name of config.requiredSecrets ?? ["SHARED_SECRET"]) {
      if (!envText.includes(`${name}=`) && !envText.includes(`# ${name}=`)) {
        warn(`secret ${name} documented`, `.env.example does not mention ${name}`);
      } else {
        ok(`secret ${name} documented`, `present in .env.example`);
      }
    }
  }

  // 5. JWKS reachability (best-effort, optional).
  const jwksMatch = /^\s*JWKS_URL\s*=\s*(\S+)/m.exec(envText);
  if (jwksMatch !== null) {
    const url = jwksMatch[1]!;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        ok("JWKS URL reachable", `${url} -> ${r.status}`);
      } else {
        warn("JWKS URL reachable", `${url} -> ${r.status}`);
      }
    } catch (e) {
      warn("JWKS URL reachable", `${url} unreachable: ${(e as Error).message}`);
    }
  }

  // 6. AWS / BUCKET vars documented (only when .env.example exists).
  if (existsSync(envExamplePath)) {
    for (const v of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "BUCKET"]) {
      if (!envText.includes(`${v}=`)) {
        warn(`env var ${v} documented`, `.env.example does not mention ${v}`);
      } else {
        ok(`env var ${v} documented`, "present in .env.example");
      }
    }
  }

  // 7. systemd unit well-formed (when present).
  const unitPath = join(serverDir, "systemd", "baerly.service");
  if (existsSync(unitPath)) {
    const txt = readFileSync(unitPath, "utf8");
    if (!txt.includes("[Service]") || !txt.includes("ExecStart=")) {
      err("systemd unit well-formed", `${unitPath} missing [Service] or ExecStart=`);
    } else {
      ok("systemd unit well-formed", unitPath);
    }
  }

  return { findings, status: rollupStatus(findings) };
};
