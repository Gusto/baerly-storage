/**
 * `baerly doctor` — citty dispatcher for deploy-invariant checks.
 *
 * Two modes:
 *   - `--bucket <uri>` — connect to a live bucket and probe its CAS
 *     support (the protocol's load-bearing backend prerequisite). This
 *     mode WRITES + deletes one throwaway sentinel; see
 *     {@link doctorCas}. Independent of `baerly.config.ts` / `--target`.
 *   - otherwise — reads `baerly.config.ts:target` and routes to
 *     {@link doctorCloudflare} (read-only deploy-invariant checks). The
 *     Node target self-validates at scaffold time — the example IS the
 *     contract — so it has no doctor backend.
 *
 * Drift detection, index rebuilds, and writes/min health are separate
 * verbs:
 *   - `baerly admin fsck --indexes [--fix]` — index drift.
 *   - `baerly admin usage` — writes/min M-size graduation.
 *   - `baerly admin rebuild-index` — single-index reconciliation.
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

import { type ArgsDef } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { parseBucketUri } from "./bucket-uri.ts";
import { loadAppConfig } from "./config.ts";
import { doctorCas } from "./doctor/cas.ts";
import { doctorCloudflare, type DoctorReport } from "./doctor/cloudflare.ts";
import { defaultRunner } from "./runner.ts";
import { color, isJsonMode } from "./output.ts";
import { defineBaerlySubcommand } from "./subcommand.ts";

const DOCTOR_ARGS = {
  target: {
    type: "string",
    description:
      'Override `baerly.config.ts:target`. Only "cloudflare" supported (Node variants self-validate at scaffold time).',
    valueHint: "cloudflare",
  },
  bucket: {
    type: "string",
    description:
      "Live-probe a bucket's CAS support (writes + deletes one sentinel; verifies If-Match / If-None-Match are honoured). s3://, file:///, or memory:// URI. Independent of --target.",
    valueHint: "s3://bucket/prefix",
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

const renderReport = (
  label: { kind: "target" | "bucket"; value: string },
  report: DoctorReport,
): void => {
  if (isJsonMode()) {
    process.stdout.write(
      `${JSON.stringify({ result: { command: "doctor", [label.kind]: label.value, ...report } })}\n`,
    );
    return;
  }
  process.stdout.write(`baerly doctor --${label.kind}=${label.value}\n\n`);
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

const bundle = defineBaerlySubcommand({
  name: "doctor",
  meta: {
    description:
      "Walk the deploy invariants and report findings. Dispatches by baerly.config.ts:target.",
  },
  args: DOCTOR_ARGS,
  handler: async (args) => {
    // --bucket is a standalone live-probe mode: it connects to a real
    // bucket and checks CAS, independent of baerly.config.ts / --target.
    if (args.bucket !== undefined) {
      const { storage, keyPrefix } = await parseBucketUri(args.bucket);
      const report = await doctorCas(storage, keyPrefix);
      renderReport({ kind: "bucket", value: args.bucket }, report);
      return report.status === "error" ? 2 : 0;
    }
    const config = await loadAppConfig();
    const target = args.target ?? config.target;
    if (target === "cloudflare") {
      const report = await doctorCloudflare(config, {
        runner: defaultRunner(),
        ...(args.fix === true && { fix: true }),
      });
      renderReport({ kind: "target", value: target }, report);
      return report.status === "error" ? 2 : 0;
    }
    throw new BaerlyError(
      "InvalidConfig",
      `baerly doctor: target ${JSON.stringify(target)} has no doctor backend. ` +
        `(Node variants self-validate at scaffold time; the example IS the contract.)`,
    );
  },
});

/** citty `defineCommand` block for `baerly doctor`. */
export const doctor = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runDoctor = bundle.run;
