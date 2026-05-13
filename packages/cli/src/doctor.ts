/**
 * `baerly doctor` — citty dispatcher.
 *
 * Reads `baerly.config.ts:target` and routes to the matching
 * doctor backend. Today: `cloudflare`. The `node` branch is
 * stubbed via dynamic import so ticket 40 can drop the module in
 * without touching the dispatcher.
 *
 * Renders the returned {@link DoctorReport} into either a
 * stdout checklist (text mode) or a JSON envelope (`--json`
 * mode).
 *
 * Exit-code contract (mirrors `baerly deploy`):
 *   - 0 success — report status is `ok` or `warning`.
 *   - 1 user error (InvalidConfig, unknown target, missing config).
 *   - 2 storage / external error.
 *   - 3 protocol invariant.
 *
 * A `warning` status returns exit 0 (the user can deploy; we just
 * flagged a maintenance / coherence issue). An `error` status
 * returns exit 2 unless the underlying cause was an InvalidConfig
 * (which already returned 1 via a thrown BaerlyError).
 */

import { spawn } from "node:child_process";
import { defineCommand, type ArgsDef, type ParsedArgs } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { loadAppConfig, type AppConfig } from "./config.ts";
import { doctorCloudflare, type DoctorReport } from "./doctor/cloudflare.ts";
import type { ProcessRunner } from "./deploy/cloudflare.ts";
import { color, emitError, isJsonMode, setJsonMode } from "./output.ts";

const DOCTOR_ARGS = {
  target: {
    type: "string",
    description: 'Override `baerly.config.ts:target`. "cloudflare" or "node".',
    valueHint: "cloudflare|node",
  },
  fix: {
    type: "boolean",
    description:
      "Remediate auto-fixable findings (R2 bucket creation; secret prompts stay manual).",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

const KNOWN_KEYS: ReadonlySet<string> = new Set(["target", "fix", "json", "_"]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") return 1;
  if (code === "Conflict" || code === "Internal" || code === "InvalidResponse") return 3;
  return 2;
};

const SEVERITY_GLYPH: Record<string, string> = {
  ok: "✓",
  info: "•",
  warning: "⚠",
  error: "✗",
};

const colorize = (severity: string, glyph: string): string => {
  if (severity === "error") return color.red(glyph);
  if (severity === "warning") return color.yellow(glyph);
  if (severity === "info") return color.dim(glyph);
  return glyph;
};

const renderReport = (target: string, report: DoctorReport): void => {
  if (isJsonMode()) {
    process.stdout.write(
      `${JSON.stringify({ result: { command: "doctor", target, ...report } })}\n`,
    );
    return;
  }
  process.stdout.write(`baerly doctor --target=${target}\n\n`);
  let okCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  for (const f of report.findings) {
    const glyph = SEVERITY_GLYPH[f.severity] ?? "•";
    process.stdout.write(`  ${colorize(f.severity, glyph)} ${f.message}\n`);
    if (f.fix !== undefined) {
      process.stdout.write(`     fix: ${f.fix}\n`);
    }
    if (f.severity === "ok") okCount += 1;
    else if (f.severity === "warning") warningCount += 1;
    else if (f.severity === "error") errorCount += 1;
  }
  process.stdout.write(
    `\nStatus: ${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}, ${okCount} ok.\n`,
  );
};

const defaultRunner: ProcessRunner = {
  run: (cmd, args, cwd) =>
    new Promise((res, rej) => {
      const child = spawn(cmd, args as string[], {
        cwd,
        stdio: ["inherit", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
      });
      child.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });
      child.on("error", rej);
      child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
    }),
};

const handleDoctor = async (args: ParsedArgs<typeof DOCTOR_ARGS>): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly doctor: unknown flag --${k}`);
      }
    }
    const config = await loadAppConfig();
    const target = args.target ?? config.target;
    if (target === "cloudflare") {
      const report = await doctorCloudflare(config, {
        runner: defaultRunner,
        ...(args.fix === true && { fix: true }),
      });
      renderReport(target, report);
      return report.status === "error" ? 2 : 0;
    }
    if (target === "node") {
      // The Node doctor is pure-read: no `runner` or `--fix` (the
      // remediation path lives in `baerly deploy --target=node
      // --force`). The dynamic import path is constructed at
      // runtime so the typechecker doesn't require the module to
      // be loaded at dispatcher build time.
      const nodeModuleSpecifier = "./doctor/node";
      const mod = (await import(nodeModuleSpecifier)) as {
        doctorNode: (config: AppConfig, opts?: { cwd?: string }) => Promise<DoctorReport>;
      };
      const report = await mod.doctorNode(config);
      renderReport(target, report);
      return report.status === "error" ? 2 : 0;
    }
    throw new BaerlyError(
      "InvalidConfig",
      `baerly doctor: unknown target ${JSON.stringify(target)}`,
    );
  } catch (err) {
    if (err instanceof BaerlyError) {
      emitError("doctor", err.code, err.message);
      return errorToExitCode(err.code);
    }
    emitError("doctor", "Unknown", (err as Error).message);
    return 2;
  }
};

/** citty `defineCommand` block for `baerly doctor`. */
export const doctor = defineCommand({
  meta: {
    name: "doctor",
    description:
      "Walk the deploy invariants and report findings. Dispatches by baerly.config.ts:target.",
  },
  args: DOCTOR_ARGS,
  run: async ({ args }) => {
    const code = await handleDoctor(args);
    if (code !== 0) process.exit(code);
  },
});

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runDoctor = async (argv: readonly string[]): Promise<number> => {
  const { parseArgs } = await import("citty");
  let parsed: ParsedArgs<typeof DOCTOR_ARGS>;
  try {
    parsed = parseArgs<typeof DOCTOR_ARGS>(argv as string[], DOCTOR_ARGS);
  } catch (err) {
    setJsonMode(argv.includes("--json"));
    emitError("doctor", "InvalidConfig", (err as Error).message);
    return 1;
  }
  return handleDoctor(parsed);
};
