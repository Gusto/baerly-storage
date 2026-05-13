/**
 * R2-contention bench — decision-criteria interpreter.
 *
 * Reads a `bench/results/r2-matrix-<stamp>/all.csv` (emitted by the
 * matrix runner in `bench/r2-contention-matrix.ts`) and prints a
 * markdown report applying the methodology's locked-in thresholds:
 *
 * - **D1** (CAS scope) — closed by ADR 0018. Reported as a
 *   regression-guard throughput number; never gates by default.
 * - **D2** (retry policy default) — decorrelated p999 vs. full-jitter
 *   p999 at S1, c=16, network=direct. Reporting only, never fails.
 * - **D3** (orphan production rate) — from S3-sigkill `notes`. Sizes
 *   the GC grace window; reporting only.
 * - **D4** (idle polling cost) — the hard regression gate. Any
 *   S2-idle cell with `class_a_per_writer_per_hour >= 1` fails the
 *   interpreter (exit 1).
 * - **D5** (fence throughput value) — S1' fenced-CAS variant is
 *   deferred (see ticket 60 §1.3); reported as "not applicable"
 *   until S1' lands.
 *
 * Exit codes:
 *  - 0 — every threshold passes.
 *  - 1 — at least one hard threshold fails (D4), or `--strict` was
 *        passed and any gate is "insufficient data".
 *  - 2 — input CSV is missing or unreadable.
 *
 * CLI:
 *   pnpm bench:r2:interpret
 *   pnpm bench:r2:interpret --input=bench/results/r2-matrix-<stamp>/all.csv
 *   pnpm bench:r2:interpret --input=bench/results/r2-matrix-<stamp>/
 *   pnpm bench:r2:interpret --strict
 *
 * No new runtime deps. Hand-rolled CSV splitter (RFC-4180-ish escape).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

interface Row {
  cell_id: string;
  scenario: string;
  concurrency: number;
  poller_count: number;
  retry_policy: string;
  network: string;
  duration_ms: number;
  wallclock_ms: number;
  commit_count: number;
  effective_throughput_per_sec: number;
  cas_412_rate: number;
  rate_limit_429_rate: number;
  class_a_op_count: number;
  class_b_op_count: number;
  class_a_per_writer_per_hour: number;
  latency_p50_ms: number;
  latency_p99_ms: number;
  latency_p999_ms: number;
  retry_tail_max: number;
  cost_model_bound_holds: boolean;
  notes: string;
}

interface GateResult {
  markdown: string;
  failed: boolean;
}

async function findLatestMatrix(): Promise<string> {
  const root = "bench/results";
  const entries = await readdir(root);
  const matrices = entries.filter((e) => e.startsWith("r2-matrix-"));
  if (matrices.length === 0) {
    throw new Error(`no r2-matrix-* subdirectory under ${root}/`);
  }
  const withMtime = await Promise.all(
    matrices.map(async (m) => {
      const dir = join(root, m);
      const stats = await stat(dir);
      return { dir, mtime: stats.mtimeMs };
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return join(withMtime[0]!.dir, "all.csv");
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        buf += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        buf += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ",") {
      fields.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  fields.push(buf);
  return fields;
}

function parseCsv(text: string): readonly Row[] {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length < 1) return [];
  const header = splitCsvLine(lines[0]!);
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]!);
    if (fields.length !== header.length) continue;
    const get = (name: string): string => fields[header.indexOf(name)]!;
    rows.push({
      cell_id: get("cell_id"),
      scenario: get("scenario"),
      concurrency: Number(get("concurrency")) || 0,
      poller_count: Number(get("poller_count")) || 0,
      retry_policy: get("retry_policy"),
      network: get("network"),
      duration_ms: Number(get("duration_ms")) || 0,
      wallclock_ms: Number(get("wallclock_ms")) || 0,
      commit_count: Number(get("commit_count")) || 0,
      effective_throughput_per_sec: Number(get("effective_throughput_per_sec")) || 0,
      cas_412_rate: Number(get("cas_412_rate")) || 0,
      rate_limit_429_rate: Number(get("rate_limit_429_rate")) || 0,
      class_a_op_count: Number(get("class_a_op_count")) || 0,
      class_b_op_count: Number(get("class_b_op_count")) || 0,
      class_a_per_writer_per_hour: Number(get("class_a_per_writer_per_hour")) || 0,
      latency_p50_ms: Number(get("latency_p50_ms")) || 0,
      latency_p99_ms: Number(get("latency_p99_ms")) || 0,
      latency_p999_ms: Number(get("latency_p999_ms")) || 0,
      retry_tail_max: Number(get("retry_tail_max")) || 0,
      cost_model_bound_holds: get("cost_model_bound_holds") === "true",
      notes: get("notes"),
    });
  }
  return rows;
}

/**
 * D1 — CAS scope (regression guard).
 *
 * ADR 0018 closed per-collection scope. The interpreter prints the
 * observed S1 c=16 throughput as a tracked-but-non-gating number.
 */
function applyD1(rows: readonly Row[]): GateResult {
  const target = rows.find(
    (r) =>
      r.scenario === "S1" &&
      r.concurrency === 16 &&
      r.retry_policy === "decorrelated" &&
      r.network === "direct",
  );
  if (target === undefined) {
    return {
      markdown:
        `### D1 — CAS scope (regression guard)\n\n` +
        `**Status: no baseline cell.** Run \`S1\` at c=16, retry=decorrelated, ` +
        `network=direct to track throughput against ADR 0018's per-collection ` +
        `scope.\n`,
      failed: false,
    };
  }
  return {
    markdown:
      `### D1 — CAS scope (regression guard)\n\n` +
      `**Status: ADR-closed; tracking only.** Per-collection CAS scope is ` +
      `the locked-in default (\`packages/protocol/src/coordination/current-json.ts:43\`, ` +
      `\`docs/adr/0018-tenant-cas-isolation.md\`). The bench is no longer in the ` +
      `loop for that decision.\n\n` +
      `Observed S1 c=16 throughput (decorrelated, direct):\n` +
      `- effective_throughput: **${target.effective_throughput_per_sec.toFixed(1)} writes/sec**\n` +
      `- 412 rate: **${(target.cas_412_rate * 100).toFixed(1)}%**\n` +
      `- 429 rate: **${(target.rate_limit_429_rate * 100).toFixed(1)}%**\n` +
      `- retry_tail_max: **${target.retry_tail_max}**\n\n` +
      `These are tracked numbers. A drastic drop vs. historical baselines is ` +
      `cause for investigation, not automatic re-decision — supersede ADR 0018 ` +
      `if the per-collection scope needs to change.\n`,
    failed: false,
  };
}

/**
 * D2 — retry policy default.
 *
 * If decorrelated p999 >= 2× full-jitter p999 at S1, c=16, direct,
 * default is full-jitter. Else decorrelated. Reporting only.
 */
function applyD2(rows: readonly Row[]): GateResult & { verdict: "decorrelated" | "full-jitter" } {
  const target = rows.filter(
    (r) => r.scenario === "S1" && r.concurrency === 16 && r.network === "direct",
  );
  const decor = target.find((r) => r.retry_policy === "decorrelated");
  const full = target.find((r) => r.retry_policy === "full-jitter");
  if (decor === undefined || full === undefined) {
    return {
      verdict: "decorrelated",
      markdown:
        `### D2 — retry policy default\n\n` +
        `**Status: insufficient data.** Missing S1 c=16 cells for both ` +
        `decorrelated (${decor === undefined ? "missing" : "present"}) and full-jitter ` +
        `(${full === undefined ? "missing" : "present"}) retry policies. Default ` +
        `recommendation: **decorrelated** (per AWS architecture-blog guidance ` +
        `and the in-tree \`s3-client-lite.ts\` default). Re-run the matrix with ` +
        `both retry-policy cells included.\n`,
      failed: false,
    };
  }
  const ratio =
    full.latency_p999_ms === 0 ? Infinity : decor.latency_p999_ms / full.latency_p999_ms;
  const verdict: "decorrelated" | "full-jitter" = ratio >= 2 ? "full-jitter" : "decorrelated";
  return {
    verdict,
    markdown:
      `### D2 — retry policy default\n\n` +
      `- decorrelated p999: **${decor.latency_p999_ms.toFixed(1)}ms** ` +
      `(cell \`${decor.cell_id}\`)\n` +
      `- full-jitter p999: **${full.latency_p999_ms.toFixed(1)}ms** ` +
      `(cell \`${full.cell_id}\`)\n` +
      `- ratio (decor / full): **${ratio.toFixed(2)}×**\n\n` +
      `**Verdict: ${verdict}** (threshold: decorrelated wins when ratio < 2×; ` +
      `full-jitter when ≥ 2×). Cap retries at 10 per the methodology.\n`,
    failed: false,
  };
}

/**
 * D3 — orphan production rate.
 *
 * Parses `orphan_rate=N` from the S3-sigkill cell's `notes`. If >= 5%,
 * recommend 7-day GC grace + intent/. Else 1-day grace + manifest-first.
 * Reporting only.
 */
function applyD3(rows: readonly Row[]): GateResult {
  const target = rows.find((r) => r.scenario === "S3-sigkill");
  if (target === undefined) {
    return {
      markdown:
        `### D3 — orphan production rate\n\n` +
        `**Status: not measured.** No S3-sigkill cell in CSV. Run ` +
        `\`pnpm bench:r2 --scenario=S3-sigkill --trials=100\`. ` +
        `Default disposition: 7-day GC grace (per ` +
        `\`packages/protocol/src/constants.ts:GC_GRACE_PERIOD_MILLIS\` ` +
        `and ADR 0020).\n`,
      failed: false,
    };
  }
  const match = /orphan_rate=([0-9.]+)/.exec(target.notes);
  if (match === null) {
    return {
      markdown:
        `### D3 — orphan production rate\n\n` +
        `**Status: notes parse failure.** Cell \`${target.cell_id}\` ran but ` +
        `\`notes\` did not contain \`orphan_rate=N\`. Notes: \`${target.notes}\`. ` +
        `Check ticket 62's \`notes\` format.\n`,
      failed: true,
    };
  }
  const orphanRate = Number(match[1]!);
  const sizingVerdict =
    orphanRate >= 0.05 ? "7-day grace + intent/" : "1-day grace, manifest-first";
  return {
    markdown:
      `### D3 — orphan production rate\n\n` +
      `- orphan_rate: **${(orphanRate * 100).toFixed(1)}%** ` +
      `(cell \`${target.cell_id}\`)\n` +
      `- threshold: 5%\n` +
      `- **Verdict: ${sizingVerdict}**\n\n` +
      `Current production grace (per \`GC_GRACE_PERIOD_MILLIS\`): 7 days. ` +
      `${orphanRate < 0.05 ? "A 1-day grace would be safe per this measurement; an ADR supersession is the path to relax." : "7-day grace is required; do not relax."}\n`,
    failed: false,
  };
}

/**
 * D4 — idle polling cost (the regression gate).
 *
 * Any S2-idle cell with `class_a_per_writer_per_hour >= 1` fails the
 * script (exit 1). This is the wire-level analogue of the in-process
 * bound enforced by `tests/integration/phase5-end-to-end.test.ts`.
 */
function applyD4(rows: readonly Row[]): GateResult {
  const target = rows.filter((r) => r.scenario === "S2-idle");
  if (target.length === 0) {
    return {
      markdown:
        `### D4 — idle polling cost\n\n` +
        `**Status: not measured.** No S2-idle cells. Run the matrix ` +
        `including the canonical \`S2-idle-p100-direct\` cell.\n`,
      failed: false,
    };
  }
  const violations = target.filter((r) => r.class_a_per_writer_per_hour >= 1);
  const summary = target
    .map(
      (r) =>
        `  - \`${r.cell_id}\` (pollers=${r.poller_count}): ` +
        `**${r.class_a_per_writer_per_hour.toFixed(3)}** Class A / poller / hour ` +
        `(${r.cost_model_bound_holds ? "ok" : "VIOLATION"})`,
    )
    .join("\n");
  const failed = violations.length > 0;
  return {
    markdown:
      `### D4 — idle polling cost\n\n` +
      `${summary}\n\n` +
      `**Threshold:** < 1 Class A op / poller / hour (the documented bound from ` +
      `\`tests/integration/phase5-end-to-end.test.ts\`).\n\n` +
      `**Verdict: ${failed ? "FAILED" : "passed"}.** ` +
      `${failed ? "The idle reader is issuing Class A operations. This is a cost-model leak. Page the operator; do not relax the bound." : "Cost-model assumption verified on the wire."}\n`,
    failed,
  };
}

/**
 * D5 — fence throughput value (reported, not gated).
 *
 * S1' fenced-CAS variant is deferred (ticket 60 §1.3). When/if S1'
 * rows appear, compare fenced p999 vs. naive p999 at c=32.
 */
function applyD5(rows: readonly Row[]): GateResult {
  const naive = rows.find(
    (r) => r.scenario === "S1" && r.concurrency === 32 && r.network === "direct",
  );
  const fenced = rows.find(
    (r) => r.scenario === "S1-prime" && r.concurrency === 32 && r.network === "direct",
  );
  if (fenced === undefined) {
    return {
      markdown:
        `### D5 — fence throughput value\n\n` +
        `**Status: not applicable.** The S1' fenced-CAS variant is deferred ` +
        `(see ticket 60 §1.3). The \`WriterFence\` primitive at ` +
        `\`packages/protocol/src/coordination/current-json.ts:300\` is already ` +
        `used as a correctness primitive. Re-run this interpreter with an S1' ` +
        `cell in the CSV to populate D5.\n`,
      failed: false,
    };
  }
  if (naive === undefined) {
    return {
      markdown: `### D5 — fence throughput value\n\n**Status: missing naive baseline.**\n`,
      failed: false,
    };
  }
  const ratio =
    naive.latency_p999_ms === 0 ? Infinity : fenced.latency_p999_ms / naive.latency_p999_ms;
  const verdict = ratio <= 0.7 ? "throughput primitive" : "correctness-only";
  return {
    markdown:
      `### D5 — fence throughput value\n\n` +
      `- naive S1 p999 at c=32: **${naive.latency_p999_ms.toFixed(1)}ms**\n` +
      `- fenced S1' p999 at c=32: **${fenced.latency_p999_ms.toFixed(1)}ms**\n` +
      `- ratio (fenced / naive): **${ratio.toFixed(2)}**\n\n` +
      `**Verdict: ${verdict}** (threshold: ≤ 0.7 ⇒ throughput primitive).\n`,
    failed: false,
  };
}

async function main(): Promise<number> {
  const args = new Map<string, string>(
    process.argv.slice(2).flatMap((a): Array<[string, string]> => {
      const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
      return m ? [[m[1]!, m[2] ?? ""]] : [];
    }),
  );
  const strict = args.has("strict");

  let inputPath = args.get("input") ?? "";
  if (inputPath === "") {
    try {
      inputPath = await findLatestMatrix();
    } catch (e) {
      process.stderr.write(`bench:r2:interpret: ${(e as Error).message}\n`);
      return 2;
    }
  } else if (!inputPath.endsWith(".csv")) {
    inputPath = join(inputPath, "all.csv");
  }
  let text: string;
  try {
    text = await readFile(inputPath, "utf8");
  } catch (e) {
    process.stderr.write(`bench:r2:interpret: cannot read ${inputPath}: ${(e as Error).message}\n`);
    return 2;
  }
  const rows = parseCsv(text);

  const d1 = applyD1(rows);
  const d2 = applyD2(rows);
  const d3 = applyD3(rows);
  const d4 = applyD4(rows);
  const d5 = applyD5(rows);

  process.stdout.write(
    `# R2 Contention Bench — Decision Report\n\n` +
      `Input: \`${inputPath}\`\n` +
      `Rows: ${rows.length}\n` +
      `Strict mode: ${strict ? "yes" : "no"}\n\n` +
      `${d1.markdown}\n${d2.markdown}\n${d3.markdown}\n${d4.markdown}\n${d5.markdown}\n`,
  );

  const anyFailure = d1.failed || d2.failed || d3.failed || d4.failed || d5.failed;
  if (anyFailure) return 1;
  // In strict mode, an "insufficient data" / "not measured" / "not
  // applicable" outcome on any gate also fails — so CI catches
  // incomplete matrices.
  if (strict) {
    const insufficient = [d1, d2, d3, d4, d5].some((d) => d.markdown.includes("**Status: "));
    if (insufficient) return 1;
  }
  return 0;
}

process.exit(await main());
