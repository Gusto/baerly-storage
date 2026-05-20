/**
 * `baerly doctor` — citty dispatcher.
 *
 * Reads `baerly.config.ts:target` and routes to
 * {@link doctorCloudflare}. The Node target self-validates at
 * scaffold time — the example IS the contract — so it has no
 * doctor backend. The dispatcher
 * also accepts two cross-target sub-checks — `--check=index-filter-drift`
 * (read-only drift scan) and `--rebuild-drift` (drift scan + auto-rebuild)
 * — whose findings splice into whichever backend report it dispatches to.
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

import { defineCommand, type ArgsDef, type ParsedArgs } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { loadAppConfig, loadAppConfigWithCollections } from "./config.ts";
import { doctorCloudflare, type DoctorFinding, type DoctorReport } from "./doctor/cloudflare.ts";
import { checkIndexFilterDrift } from "./doctor/index-filter-drift.ts";
import { defaultRunner } from "./runner.ts";
import { color, emitError, isJsonMode, setJsonMode } from "./output.ts";

const DOCTOR_ARGS = {
  target: {
    type: "string",
    description:
      'Override `baerly.config.ts:target`. Only "cloudflare" supported (Node variants self-validate at scaffold time).',
    valueHint: "cloudflare",
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
  usage: {
    type: "boolean",
    description:
      "Scan recent log entries per collection and emit a graduation hint when writes/min approaches the M-size ceiling (CF target emits a follow-up breadcrumb).",
  },
  check: {
    type: "string",
    description: "Run a single named check (today: 'index-filter-drift').",
    valueHint: "name",
  },
  "rebuild-drift": {
    type: "boolean",
    description:
      "When index-filter-drift detects orphans / missing keys, call rebuildIndex to fix them. Implies --check=index-filter-drift.",
  },
} as const satisfies ArgsDef;

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "target",
  "fix",
  "json",
  "usage",
  "check",
  "rebuild-drift",
  "_",
]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") {
    return 1;
  }
  if (code === "Conflict" || code === "Internal" || code === "InvalidResponse") {
    return 3;
  }
  return 2;
};

const SEVERITY_GLYPH: Record<string, string> = {
  ok: "✓",
  info: "•",
  warning: "⚠",
  error: "✗",
};

const colorize = (severity: string, glyph: string): string => {
  if (severity === "error") {
    return color.red(glyph);
  }
  if (severity === "warning") {
    return color.yellow(glyph);
  }
  if (severity === "info") {
    return color.dim(glyph);
  }
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
    if (f.severity === "ok") {
      okCount += 1;
    } else if (f.severity === "warning") {
      warningCount += 1;
    } else if (f.severity === "error") {
      errorCount += 1;
    }
  }
  process.stdout.write(
    `\nStatus: ${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}, ${okCount} ok.\n`,
  );
};

const handleDoctor = async (args: ParsedArgs<typeof DOCTOR_ARGS>): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly doctor: unknown flag --${k}`);
      }
    }
    // `--check` is the named-check dispatcher; today the only known
    // value is `index-filter-drift`. Reject unknown values early so
    // the operator gets an actionable error rather than a silent
    // skip.
    if (args.check !== undefined && args.check !== "index-filter-drift") {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly doctor: unknown --check value ${JSON.stringify(args.check)} (supported: "index-filter-drift")`,
      );
    }
    // The drift check is dispatcher-level — it runs once and its
    // findings splice into whichever backend the target dispatches
    // to. `--rebuild-drift` implies the check, so either flag
    // triggers the scan. Only the drift path needs `collections[*]`
    // reflection, so non-drift invocations skip the
    // collections-aware re-parse and use the narrow loader.
    const runDrift = args.check === "index-filter-drift" || args["rebuild-drift"] === true;
    const { config, collections } = runDrift
      ? await loadAppConfigWithCollections()
      : { config: await loadAppConfig(), collections: undefined };
    const target = args.target ?? config.target;
    const extraFindings: DoctorFinding[] = runDrift
      ? await checkIndexFilterDrift(config, collections, {
          ...(args["rebuild-drift"] === true && { rebuild: true }),
        })
      : [];
    if (target === "cloudflare") {
      const report = await doctorCloudflare(config, {
        runner: defaultRunner(),
        ...(args.fix === true && { fix: true }),
        ...(args.usage === true && { usage: true }),
        ...(extraFindings.length > 0 && { extraFindings }),
      });
      renderReport(target, report);
      return report.status === "error" ? 2 : 0;
    }
    throw new BaerlyError(
      "InvalidConfig",
      `baerly doctor: target ${JSON.stringify(target)} has no doctor backend. ` +
        `(Node variants self-validate at scaffold time; the example IS the contract.)`,
    );
  } catch (error) {
    if (error instanceof BaerlyError) {
      emitError("doctor", error.code, error.message);
      return errorToExitCode(error.code);
    }
    emitError("doctor", "Unknown", (error as Error).message);
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
export const runDoctor = async (argv: readonly string[]): Promise<number> => {
  const { parseArgs } = await import("citty");
  let parsed: ParsedArgs<typeof DOCTOR_ARGS>;
  try {
    parsed = parseArgs<typeof DOCTOR_ARGS>(argv as string[], DOCTOR_ARGS);
  } catch (error) {
    setJsonMode(argv.includes("--json"));
    emitError("doctor", "InvalidConfig", (error as Error).message);
    return 1;
  }
  return handleDoctor(parsed);
};
