/**
 * R2 contention bench — sweep-matrix orchestrator. Sequential sweep
 * over (scenario × concurrency × pollers × collections × retry ×
 * network), one `bench/r2-contention.ts` invocation per cell. Per-cell
 * `RunResult` JSON lands in `bench/results/r2-matrix-<stamp>/`; after
 * every cell completes, a denormalised `all.csv` is emitted under the
 * same subdirectory. The D1-D5 interpreter (ticket 64) reads that CSV.
 *
 * Sequential because the cells share Minio + a single `current.json`
 * keyspace and a single `:9104` toxic install — parallel cells would
 * race. See `bench/load-harness/matrix.ts:3` for the same rationale.
 *
 * Exit codes:
 *   - 0: every cell exited 0 AND every cell's `RunResult.notes`
 *     field is undefined (no cost-model violation observed).
 *   - 1: at least one cell failed OR at least one cell flagged a
 *     cost-model violation. Operator inspects `all.csv`.
 *
 * Cells targeting scenarios that aren't landed yet fail fast with a
 * clear stderr message; the orchestrator counts them under `failures`
 * and proceeds. At ticket-60 land time all four supplemental scenarios
 * (S2-multi, S3-sigkill, S5-compaction) are wired into
 * `r2-contention.ts`, so the default 21-cell sweep is runnable
 * end-to-end against `pnpm dev:storage`.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult, Scenario } from "./types.ts";

interface Cell {
  readonly scenario: Scenario;
  readonly concurrency?: number;
  readonly pollers?: number;
  readonly collections?: number; // S2-multi only
  readonly retry?: "no-jitter" | "full-jitter" | "decorrelated";
  readonly network?: "direct" | "wan-50ms" | "loss-5";
  readonly durationS?: number;
  readonly trials?: number; // S3-sigkill only
  /** Stable per-cell id baked into the per-cell JSON filename. */
  readonly id: string;
}

const DEFAULT_CELLS: readonly Cell[] = [
  // S1 baseline — concurrency sweep at decorrelated, direct.
  {
    id: "S1-c1-decor-direct",
    scenario: "S1",
    concurrency: 1,
    retry: "decorrelated",
    network: "direct",
    durationS: 60,
  },
  {
    id: "S1-c4-decor-direct",
    scenario: "S1",
    concurrency: 4,
    retry: "decorrelated",
    network: "direct",
    durationS: 60,
  },
  {
    id: "S1-c8-decor-direct",
    scenario: "S1",
    concurrency: 8,
    retry: "decorrelated",
    network: "direct",
    durationS: 60,
  },
  {
    id: "S1-c16-decor-direct",
    scenario: "S1",
    concurrency: 16,
    retry: "decorrelated",
    network: "direct",
    durationS: 60,
  },
  {
    id: "S1-c32-decor-direct",
    scenario: "S1",
    concurrency: 32,
    retry: "decorrelated",
    network: "direct",
    durationS: 60,
  },
  // S1 retry-policy comparison at concurrency 16, direct.
  {
    id: "S1-c16-nojit-direct",
    scenario: "S1",
    concurrency: 16,
    retry: "no-jitter",
    network: "direct",
    durationS: 60,
  },
  {
    id: "S1-c16-fulljit-direct",
    scenario: "S1",
    concurrency: 16,
    retry: "full-jitter",
    network: "direct",
    durationS: 60,
  },
  // S3-toxic at network turbulence, concurrency 16.
  {
    id: "S3-toxic-c16-wan",
    scenario: "S3-toxic",
    concurrency: 16,
    retry: "decorrelated",
    network: "wan-50ms",
    durationS: 60,
  },
  {
    id: "S3-toxic-c16-loss",
    scenario: "S3-toxic",
    concurrency: 16,
    retry: "decorrelated",
    network: "loss-5",
    durationS: 60,
  },
  // S2-idle pollers sweep at direct, 6 min.
  { id: "S2-idle-p10-direct", scenario: "S2-idle", pollers: 10, network: "direct", durationS: 360 },
  { id: "S2-idle-p50-direct", scenario: "S2-idle", pollers: 50, network: "direct", durationS: 360 },
  {
    id: "S2-idle-p100-direct",
    scenario: "S2-idle",
    pollers: 100,
    network: "direct",
    durationS: 360,
  },
  // Methodology S2 — multi-collection prefix saturation (ticket 61).
  {
    id: "S2-multi-m10",
    scenario: "S2-multi",
    collections: 10,
    retry: "decorrelated",
    network: "direct",
    durationS: 60,
  },
  {
    id: "S2-multi-m100",
    scenario: "S2-multi",
    collections: 100,
    retry: "decorrelated",
    network: "direct",
    durationS: 60,
  },
  {
    id: "S2-multi-m1000",
    scenario: "S2-multi",
    collections: 1000,
    retry: "decorrelated",
    network: "direct",
    durationS: 60,
  },
  // Methodology S3 — SIGKILL orphan rate (ticket 62).
  { id: "S3-sigkill-100", scenario: "S3-sigkill", trials: 100, network: "direct" },
  // Methodology S5 — compactor-vs-writer race (ticket 63).
  {
    id: "S5-compaction-5m",
    scenario: "S5-compaction",
    concurrency: 1,
    retry: "decorrelated",
    network: "direct",
    durationS: 300,
  },
];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outBase = join("bench/results", `r2-matrix-${stamp}`);
await mkdir(outBase, { recursive: true });

let failures = 0;
let violations = 0;
for (const cell of DEFAULT_CELLS) {
  const args = ["--import", "./bench/register-hooks.mjs", "bench/r2-contention.ts"];
  args.push(`--scenario=${cell.scenario}`);
  if (cell.concurrency !== undefined) args.push(`--concurrency=${cell.concurrency}`);
  if (cell.pollers !== undefined) args.push(`--pollers=${cell.pollers}`);
  if (cell.collections !== undefined) args.push(`--collections=${cell.collections}`);
  if (cell.retry !== undefined) args.push(`--retry=${cell.retry}`);
  if (cell.network !== undefined) args.push(`--network=${cell.network}`);
  if (cell.durationS !== undefined) args.push(`--duration-s=${cell.durationS}`);
  if (cell.trials !== undefined) args.push(`--trials=${cell.trials}`);
  // Pin per-cell output to the matrix subdirectory so we can read it
  // back without scanning the whole results/ directory.
  args.push(`--out-dir=${outBase}`);
  args.push(`--cell-id=${cell.id}`);
  const code = await run(args);
  if (code !== 0) {
    failures++;
    process.stderr.write(`matrix: cell ${cell.id} exited ${code}\n`);
  } else {
    // Read back the per-cell RunResult to track cost-model violations.
    try {
      const text = await readFile(join(outBase, `${cell.id}.json`), "utf8");
      const result = JSON.parse(text) as RunResult;
      if (result.notes !== undefined) violations++;
    } catch (e) {
      process.stderr.write(`matrix: cell ${cell.id} JSON read failed: ${(e as Error).message}\n`);
      failures++;
    }
  }
}

await emitCsv(outBase);

const exitCode = failures === 0 && violations === 0 ? 0 : 1;
process.exit(exitCode);

function run(args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("node", [...args], { stdio: "inherit" });
    proc.on("exit", (code) => resolve(code ?? 1));
  });
}

async function emitCsv(dir: string): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const rows: string[] = [
    [
      "cell_id",
      "scenario",
      "concurrency",
      "poller_count",
      "retry_policy",
      "network",
      "duration_ms",
      "wallclock_ms",
      "commit_count",
      "effective_throughput_per_sec",
      "cas_412_rate",
      "rate_limit_429_rate",
      "class_a_op_count",
      "class_b_op_count",
      "class_a_per_writer_per_hour",
      "latency_p50_ms",
      "latency_p99_ms",
      "latency_p999_ms",
      "retry_tail_max",
      "cost_model_bound_holds",
      "notes",
    ].join(","),
  ];
  for (const f of files) {
    const text = await readFile(join(dir, f), "utf8");
    const r = JSON.parse(text) as RunResult;
    rows.push(
      [
        f.replace(/\.json$/, ""),
        r.cell.scenario,
        r.cell.concurrency,
        r.cell.pollerCount,
        r.cell.retryPolicy,
        r.cell.network,
        r.cell.durationMs,
        r.wallclock_ms,
        // `commit_count` is not on RunResult directly; effective_throughput_per_sec
        // × (wallclock_ms / 1000) recovers it within rounding. The
        // interpreter (ticket 64) reads the per-cell JSON for the exact
        // metric when needed; the CSV is a denormalised projection.
        Math.round(r.effective_throughput_per_sec * (r.wallclock_ms / 1000)),
        r.effective_throughput_per_sec,
        r.cas_412_rate,
        r.rate_limit_429_rate,
        r.class_a_op_count,
        r.class_b_op_count,
        r.class_a_per_writer_per_hour,
        r.latency_p50_ms,
        r.latency_p99_ms,
        r.latency_p999_ms,
        r.retry_tail_max,
        r.cost_model_bound_holds,
        escapeNotes(r.notes),
      ]
        .map(String)
        .join(","),
    );
  }
  await writeFile(join(dir, "all.csv"), rows.join("\n") + "\n");
}

function escapeNotes(notes: string | undefined): string {
  if (notes === undefined) return "";
  // Notes are short; minimal RFC-4180-ish escape (double-quote-wrap
  // anything with a comma, double internal quotes).
  if (!notes.includes(",") && !notes.includes('"')) return notes;
  return `"${notes.replace(/"/g, '""')}"`;
}
