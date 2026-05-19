#!/usr/bin/env node
/**
 * Scaffolding eval orchestrator.
 *
 * Drives one or more (app, tool, trial) cells: scaffolds a fresh app,
 * spawns Claude Code or Codex CLI against the matching prompt, invokes
 * the acceptance checker (`eval/check-acceptance.mjs`) and the
 * scorer (`eval/score.mjs`), and emits a comparative report.
 *
 * Zero runtime deps — pure Node 24+ APIs (`node:child_process` +
 * `node:fs/promises` + `node:fs` + `node:path` + `node:events` +
 * `node:os`).
 *
 * Usage:
 *   node eval/run.mjs \
 *     --app todo \
 *     --tool claude|codex|both \
 *     --trials 3 \
 *     [--target cloudflare|node] \
 *     [--workdir <path>] \
 *     [--runs-dir <path>] \
 *     [--report <path>]
 *
 * Exit codes:
 *   0 — all trials ran (regardless of pass/fail score).
 *   1 — invalid CLI args, or a required tool not on $PATH.
 *   2 — internal harness error (template missing, transcript not
 *       created, etc.).
 *
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = resolvePath(SCRIPT_DIR, "..");

const VALID_APPS = ["todo", "notes", "rsvp", "chat", "shortlink", "kanban", "bookmarks"];
const VALID_TOOLS = ["claude", "codex", "both"];
const VALID_TARGETS = ["cloudflare", "node"];

const STDERR_CAP = 4096;
const TRIAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min per §4
const PROBE_TIMEOUT_MS = 10_000;

const MODELS = {
  claude: "claude-opus-4-7",
  codex: "gpt-5",
};

// ──────────────────────────────────────────────────────────────────────
// CLI parsing + help
// ──────────────────────────────────────────────────────────────────────

const DECISIONS_TEXT = [
  "Decisions applied (the eight methodology choices baked into this runner):",
  "",
  "  1. Approval mode — `--dangerously-skip-permissions` for Claude; default",
  "     auto-approval for Codex `exec`. Both run inside a throwaway tmpdir.",
  "  2. Model selection per tool — pin top-tier: claude-opus-4-7 for Claude",
  "     Code, gpt-5 for Codex. No cross-tier matching across CLIs.",
  "  3. Commit the scaffolded output to git — yes, on a local per-trial",
  "     branch inside $WORKDIR/<app>. Eval-level `eval/runs/` keeps score.md",
  "     + metrics.json only.",
  "  4. Human-gold baseline — skipped for v1. Revisit when a blind",
  "     coworker run is available.",
  "  5. Failure-mode taxonomy — deferred. `score.md`'s freeform stderr is",
  "     the only signal; codify after 20+ runs.",
  "  6. AGENTS.md / CLAUDE.md parity — dual-write enforced by the",
  "     scaffolder (ticket 83). Missing CLAUDE.md → harness exit 2.",
  "  7. Cache-hit-rate asymmetry — reported separately, excluded from the",
  "     composite score (ticket 80). Footnoted in report.md.",
  "  8. N=3 → N=5 escalation rule — N=3 default. Escalate only if the",
  "     composite-score IQR exceeds 20 points on > half the (app, tool)",
  "     cells. The runner does not auto-escalate.",
].join("\n");

function helpText() {
  return [
    "Usage:",
    "  node eval/run.mjs \\",
    "    --app <app> \\",
    "    --tool claude|codex|both \\",
    "    --trials <N> \\",
    "    [--target cloudflare|node] \\",
    "    [--workdir <path>] \\",
    "    [--runs-dir <path>] \\",
    "    [--report <path>]",
    "",
    `Valid apps: ${VALID_APPS.join(", ")}`,
    `Valid tools: ${VALID_TOOLS.join(", ")}`,
    `Valid targets: ${VALID_TARGETS.join(", ")}`,
    "",
    "Defaults:",
    "  --tool    both",
    "  --trials  3",
    "  --target  cloudflare",
    "  --workdir mktemp -d under $TMPDIR (not auto-deleted)",
    "  --runs-dir <repo-root>/eval/runs/",
    "  --report  <runs-dir>/<date>-<app>-report.md",
    "",
    "Environment overrides (test/CI):",
    "  CLAUDE_CLI_OVERRIDE      path to an executable to use in place of `claude`",
    "  CODEX_CLI_OVERRIDE       path to an executable to use in place of `codex`",
    "  EVAL_SCAFFOLD_OVERRIDE   directory copied in place of running create-baerly",
    "",
    DECISIONS_TEXT,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {
    tool: "both",
    trials: 3,
    target: "cloudflare",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--app") {
      out.app = argv[++i];
    } else if (a === "--tool") {
      out.tool = argv[++i];
    } else if (a === "--trials") {
      out.trials = Number(argv[++i]);
    } else if (a === "--target") {
      out.target = argv[++i];
    } else if (a === "--workdir") {
      out.workdir = argv[++i];
    } else if (a === "--runs-dir") {
      out.runsDir = argv[++i];
    } else if (a === "--report") {
      out.report = argv[++i];
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return out;
}

function validateArgs(args) {
  const errors = [];
  if (!args.app) {
    errors.push("--app is required");
  } else if (!VALID_APPS.includes(args.app)) {
    errors.push(`unknown app "${args.app}" — valid apps: ${VALID_APPS.join(", ")}`);
  }
  if (!VALID_TOOLS.includes(args.tool)) {
    errors.push(`unknown tool "${args.tool}" — valid tools: ${VALID_TOOLS.join(", ")}`);
  }
  if (!Number.isFinite(args.trials) || args.trials < 1) {
    errors.push(`--trials must be a positive integer (got ${args.trials})`);
  }
  if (!VALID_TARGETS.includes(args.target)) {
    errors.push(`unknown target "${args.target}" — valid targets: ${VALID_TARGETS.join(", ")}`);
  }
  return errors;
}

// ──────────────────────────────────────────────────────────────────────
// Process helpers — inlined per the ticket (no shared module with
// check-acceptance.mjs / score.mjs).
// ──────────────────────────────────────────────────────────────────────

async function run(cmd, args, options = {}) {
  const { cwd, env, timeoutMs, stdoutPath, stderrPath } = options;
  const ac = new AbortController();
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutMs)
    : null;

  let proc;
  try {
    proc = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: ac.signal,
    });
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
    }
    return { code: 127, stdout: "", stderr: String(error).slice(0, STDERR_CAP), timedOut };
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  // Always buffer in-memory; if a file path is requested, dump the
  // buffered bytes after the process closes. This avoids the
  // pipe()/close-event race in `child_process.spawn`.
  proc.stdout?.on("data", (d) => stdoutChunks.push(d));
  proc.stderr?.on("data", (d) => stderrChunks.push(d));

  let exitCode = 1;
  try {
    const [code] = await once(proc, "close");
    exitCode = code ?? 1;
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
    }
    return {
      code: 1,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: (timedOut ? `timed out after ${timeoutMs}ms` : String(error)).slice(0, STDERR_CAP),
      timedOut,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  const stdoutBuf = Buffer.concat(stdoutChunks);
  const stderrBuf = Buffer.concat(stderrChunks);
  if (stdoutPath) {
    await writeFile(stdoutPath, stdoutBuf);
  }
  if (stderrPath) {
    await writeFile(stderrPath, stderrBuf);
  }

  return {
    code: exitCode,
    stdout: stdoutBuf.toString("utf8"),
    stderr: stderrBuf.toString("utf8").slice(0, STDERR_CAP),
    timedOut,
  };
}

// PATH-existence check with version probe — accepts exit 0 only.
// Respects CLAUDE_CLI_OVERRIDE / CODEX_CLI_OVERRIDE.
function resolveTool(toolName) {
  const overrideVar = toolName === "claude" ? "CLAUDE_CLI_OVERRIDE" : "CODEX_CLI_OVERRIDE";
  const override = process.env[overrideVar];
  if (override) {
    if (!existsSync(override)) {
      return { ok: false, reason: `${overrideVar}=${override} does not exist` };
    }
    return { ok: true, path: override, override: true };
  }
  // Walk $PATH ourselves (no `which`/`where` shell-out).
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, toolName);
    if (existsSync(candidate)) {
      // Probe with --version; require exit 0.
      const probe = spawnSync(candidate, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PROBE_TIMEOUT_MS,
      });
      if (probe.status === 0) {
        return { ok: true, path: candidate, override: false };
      }
    }
  }
  return { ok: false, reason: `${toolName} not found on $PATH` };
}

async function toolVersion(toolPath) {
  const probe = spawnSync(toolPath, ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROBE_TIMEOUT_MS,
  });
  if (probe.status !== 0) {
    return "unknown";
  }
  const out = (probe.stdout?.toString() ?? "").split(/\r?\n/)[0] ?? "";
  return out.trim() || "unknown";
}

// ──────────────────────────────────────────────────────────────────────
// Per-trial sequence (§3.2)
// ──────────────────────────────────────────────────────────────────────

function timestampSlug() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${dd}-${hh}${mm}${ss}`;
}

function dateSlug() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function gitRevParse(repoPath, ref) {
  const result = await run("git", ["rev-parse", ref], { cwd: repoPath });
  return result.code === 0 ? result.stdout.trim() : "unknown";
}

async function gitCommit(scaffoldRoot, message) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "eval",
    GIT_AUTHOR_EMAIL: "eval@local",
    GIT_COMMITTER_NAME: "eval",
    GIT_COMMITTER_EMAIL: "eval@local",
  };
  await run("git", ["add", "-A"], { cwd: scaffoldRoot, env });
  await run("git", ["commit", "-q", "--allow-empty", "-m", message], {
    cwd: scaffoldRoot,
    env,
  });
}

async function scaffoldApp(workdir, app, target) {
  const scaffoldRoot = join(workdir, app);

  // Test escape hatch: if EVAL_SCAFFOLD_OVERRIDE is set, treat it as a
  // template directory and seed scaffoldRoot from it (skipping the
  // real `pnpm exec create-baerly` + `pnpm install` round-trip). The
  // override directory must already contain a working scaffold tree
  // including CLAUDE.md. Used only by the runner's own integration
  // test — the live first-pass invocation hits the real scaffolder.
  if (process.env.EVAL_SCAFFOLD_OVERRIDE) {
    const src = resolvePath(process.env.EVAL_SCAFFOLD_OVERRIDE);
    if (!existsSync(src)) {
      return { ok: false, reason: `EVAL_SCAFFOLD_OVERRIDE=${src} does not exist` };
    }
    const { cp } = await import("node:fs/promises");
    await cp(src, scaffoldRoot, { recursive: true });
  } else {
    // pnpm exec create-baerly <app> --target=<target>
    const scaffoldResult = await run("pnpm", ["exec", "create-baerly", app, `--target=${target}`], {
      cwd: workdir,
      timeoutMs: 5 * 60 * 1000,
    });
    if (scaffoldResult.code !== 0) {
      return {
        ok: false,
        reason: `pnpm exec create-baerly exit ${scaffoldResult.code}: ${scaffoldResult.stderr.slice(0, 512)}`,
      };
    }
    if (!existsSync(scaffoldRoot)) {
      return { ok: false, reason: `scaffold root ${scaffoldRoot} was not created` };
    }
    // pnpm install
    const installResult = await run("pnpm", ["install", "--silent"], {
      cwd: scaffoldRoot,
      timeoutMs: 10 * 60 * 1000,
    });
    if (installResult.code !== 0) {
      return {
        ok: false,
        reason: `pnpm install exit ${installResult.code}: ${installResult.stderr.slice(0, 512)}`,
      };
    }
  }

  // Hard prerequisite per decision #6: CLAUDE.md must exist after scaffolding.
  if (!existsSync(join(scaffoldRoot, "CLAUDE.md"))) {
    return {
      ok: false,
      reason: `CLAUDE.md missing from scaffolded tree at ${scaffoldRoot} — ticket 83 dual-write regression?`,
    };
  }
  // git init + baseline commit
  await run("git", ["init", "-q"], { cwd: scaffoldRoot });
  await gitCommit(scaffoldRoot, "post-scaffold baseline");
  const baselineSha = await gitRevParse(scaffoldRoot, "HEAD");
  return { ok: true, scaffoldRoot, baselineSha };
}

async function writeEnvHeader(envPath, info) {
  const lines = [];
  for (const [k, v] of Object.entries(info)) {
    lines.push(`${k}: ${v}`);
  }
  await writeFile(envPath, lines.join("\n") + "\n", "utf8");
}

function buildClaudeArgs(promptText) {
  return [
    "--print",
    promptText,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    MODELS.claude,
    "--allowedTools",
    "Read,Write,Edit,Bash,Glob,Grep",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ];
}

function buildCodexArgs(promptText) {
  return ["exec", promptText, "--json", "--model", MODELS.codex, "--skip-git-repo-check"];
}

async function runAgent({ tool, toolPath, promptText, scaffoldRoot, runDir }) {
  const transcriptPath = join(runDir, "transcript.jsonl");
  const stderrPath = join(runDir, "stderr.log");
  const args = tool === "claude" ? buildClaudeArgs(promptText) : buildCodexArgs(promptText);
  const startedAt = Date.now();
  const result = await run(toolPath, args, {
    cwd: scaffoldRoot,
    timeoutMs: TRIAL_TIMEOUT_MS,
    stdoutPath: transcriptPath,
    stderrPath,
  });
  return {
    code: result.code,
    timedOut: result.timedOut,
    transcriptPath,
    stderrPath,
    durationMs: Date.now() - startedAt,
  };
}

async function runOneTrial({
  app,
  tool,
  toolPath,
  trial,
  workdirBase,
  runsDir,
  target,
  promptText,
  promptSha,
  runnerSha,
}) {
  const cellName = `${app}-${tool}-${trial}`;
  const workdir = join(workdirBase, cellName);
  await mkdir(workdir, { recursive: true });
  const runDir = join(runsDir, `${timestampSlug()}-${app}-${tool}-${trial}`);
  await mkdir(runDir, { recursive: true });

  // 1. Scaffold
  const scaffold = await scaffoldApp(workdir, app, target);
  if (!scaffold.ok) {
    return {
      ok: false,
      runDir,
      reason: scaffold.reason,
      tool,
      trial,
    };
  }
  const { scaffoldRoot, baselineSha } = scaffold;

  // 2. Env header
  const version = await toolVersion(toolPath);
  await writeEnvHeader(join(runDir, "env.txt"), {
    tool,
    tool_version: version,
    model: MODELS[tool],
    date: new Date().toISOString(),
    host: `${process.platform} ${process.arch}`,
    app,
    target,
    baseline_sha: baselineSha,
    prompt_sha: promptSha,
    runner_sha: runnerSha,
  });

  // 3. Run the agent
  const agentResult = await runAgent({
    tool,
    toolPath,
    promptText,
    scaffoldRoot,
    runDir,
  });

  // 4. Snapshot final state
  await gitCommit(scaffoldRoot, `after ${tool} run`);
  const finalSha = await gitRevParse(scaffoldRoot, "HEAD");
  const diffResult = await run("git", ["diff", baselineSha, finalSha], {
    cwd: scaffoldRoot,
  });
  await writeFile(join(runDir, "final-state.diff"), diffResult.stdout, "utf8");

  // 5. Acceptance checker
  const acceptancePath = join(runDir, "acceptance.json");
  const acceptanceResult = await run(
    process.execPath,
    [join(REPO_ROOT, "eval/check-acceptance.mjs"), app, scaffoldRoot],
    { stdoutPath: acceptancePath },
  );
  if (acceptanceResult.code !== 0) {
    await writeFile(
      acceptancePath,
      JSON.stringify({ schema_version: 1, app, scaffold_root: scaffoldRoot, bullets: [] }, null, 2),
      "utf8",
    );
  }

  // 6. Score
  const scorePath = join(runDir, "score.md");
  const metricsPath = join(runDir, "metrics.json");
  const scoreArgs = [
    join(REPO_ROOT, "eval/score.mjs"),
    "--transcript",
    join(runDir, "transcript.jsonl"),
    "--acceptance",
    acceptancePath,
    "--env",
    join(runDir, "env.txt"),
    "--diff",
    join(runDir, "final-state.diff"),
    "--out",
    scorePath,
    "--metrics",
    metricsPath,
    "--tool",
    tool,
  ];
  const scoreResult = await run(process.execPath, scoreArgs);

  return {
    ok: true,
    runDir,
    tool,
    trial,
    agentExitCode: agentResult.code,
    agentTimedOut: agentResult.timedOut,
    agentDurationMs: agentResult.durationMs,
    scoreExitCode: scoreResult.code,
    scorePath,
    metricsPath,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Comparative report (§3.7)
// ──────────────────────────────────────────────────────────────────────

async function readMetricsOrZero(metricsPath) {
  try {
    const raw = await readFile(metricsPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function median(nums) {
  if (nums.length === 0) {
    return 0;
  }
  const sorted = [...nums].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function quartile(nums, q) {
  if (nums.length === 0) {
    return 0;
  }
  const sorted = [...nums].toSorted((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function formatCost(usd) {
  if (typeof usd !== "number" || Number.isNaN(usd)) {
    return "—";
  }
  return `$${usd.toFixed(2)}`;
}

function metricRow(tool, trial, m) {
  if (!m) {
    return `| ${tool} | ${trial} | 0 | 0/0 | ✗ | ✗ | ✗ | — | 0 | 0 | 0 | 0 |`;
  }
  const score = m.score ?? 0;
  const bulletsPassed = m.bullets_passed ?? "—";
  const bulletsTotal = m.bullets_total ?? "—";
  const compile = m.compile_pass ? "✓" : "✗";
  const lint = m.lint_pass ? "✓" : "✗";
  const test = m.test_pass ? "✓" : "✗";
  const cost = formatCost(m.cost_usd);
  const turns = m.turns ?? 0;
  const files = m.files_touched_count ?? 0;
  const fric = m.human_questions ?? 0;
  const edits = m.tool_calls_total ?? 0;
  return `| ${tool} | ${trial} | ${score} | ${bulletsPassed}/${bulletsTotal} | ${compile} | ${lint} | ${test} | ${cost} | ${turns} | ${files} | ${fric} | ${edits} |`;
}

async function emitReport({
  app,
  target,
  args,
  perTool,
  workdirBase,
  runsDir: _runsDir,
  reportPath,
}) {
  const lines = [];
  const today = dateSlug();
  lines.push(`# Scaffolding eval — ${app} (${target}) — ${today}`);
  lines.push("");
  lines.push("## Configuration");
  lines.push("");
  lines.push(`- Prompt: \`eval/prompts/${app}.md\``);
  lines.push("- Runner: `eval/run.mjs`");
  lines.push(`- Trials per tool: ${args.trials}`);
  const versionsCells = [];
  if (perTool.claude) {
    versionsCells.push(`claude ${perTool.claude.version}`);
  }
  if (perTool.codex) {
    versionsCells.push(`codex ${perTool.codex.version}`);
  }
  lines.push(`- Tools: ${versionsCells.join(", ") || "—"}`);
  const modelsCells = [];
  if (perTool.claude) {
    modelsCells.push(MODELS.claude);
  }
  if (perTool.codex) {
    modelsCells.push(MODELS.codex);
  }
  lines.push(`- Models: ${modelsCells.join(", ") || "—"}`);
  lines.push(`- Workdir: ${workdirBase}`);
  lines.push("");

  lines.push("## Scores");
  lines.push("");
  lines.push(
    "| Tool | Trial | Score | Pass | Comp | Lint | Test | Cost | Turns | Files | Fric | Edits |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");

  const allRows = [];
  for (const tool of ["claude", "codex"]) {
    const data = perTool[tool];
    if (!data) {
      continue;
    }
    for (const trial of data.trials) {
      const m = await readMetricsOrZero(trial.metricsPath);
      allRows.push({ tool, trial: trial.trial, metrics: m, runDir: trial.runDir });
      lines.push(metricRow(tool, trial.trial, m));
    }
  }
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| Tool | Median | Min | Max | IQR | Median Cost |");
  lines.push("|---|---|---|---|---|---|");

  const summary = {};
  for (const tool of ["claude", "codex"]) {
    const rows = allRows.filter((r) => r.tool === tool);
    if (rows.length === 0) {
      continue;
    }
    const scores = rows.map((r) => r.metrics?.score ?? 0);
    const costs = rows.map((r) => r.metrics?.cost_usd ?? 0);
    const med = median(scores);
    const iqr = quartile(scores, 0.75) - quartile(scores, 0.25);
    const medCost = median(costs);
    summary[tool] = { median: med, iqr, medianCost: medCost };
    lines.push(
      `| ${tool} | ${med} | ${Math.min(...scores)} | ${Math.max(...scores)} | ${iqr.toFixed(1)} | ${formatCost(medCost)} |`,
    );
  }
  lines.push("");

  if (summary.claude && summary.codex) {
    const delta = summary.claude.median - summary.codex.median;
    lines.push(`- Median delta: claude − codex = ${delta >= 0 ? "+" : ""}${delta} points.`);
    const escalate =
      summary.claude.iqr > 20 || summary.codex.iqr > 20
        ? "consider escalating to N=5"
        : "**do not** escalate to N=5";
    lines.push(
      `- IQR(claude) = ${summary.claude.iqr.toFixed(1)}, IQR(codex) = ${summary.codex.iqr.toFixed(1)} — ${escalate}.`,
    );
    if (summary.codex.medianCost > 0) {
      const ratio = summary.claude.medianCost / summary.codex.medianCost;
      lines.push(`- Cost ratio: claude / codex = ${ratio.toFixed(2)}x.`);
    }
  } else {
    const only = summary.claude ? "claude" : "codex";
    if (summary[only]) {
      lines.push(`- Single-tool run (${only}); skip the comparative deltas.`);
      const escalate = summary[only].iqr > 20 ? "consider N=5" : "do not escalate";
      lines.push(`- IQR(${only}) = ${summary[only].iqr.toFixed(1)} — ${escalate}.`);
    }
  }
  lines.push("");

  lines.push("## Decisions applied");
  lines.push("");
  lines.push(
    "1. Approval mode — `--dangerously-skip-permissions` (claude) / default auto-approval (codex).",
  );
  lines.push(`2. Model — ${MODELS.claude} / ${MODELS.codex} (top tier of each).`);
  lines.push("3. Commit scaffolded output — yes, on local per-trial branches.");
  lines.push("4. Human-gold baseline — skipped for v1.");
  lines.push("5. Failure-mode taxonomy — freeform notes only.");
  lines.push("6. AGENTS.md/CLAUDE.md parity — dual-write enforced by scaffolder.");
  lines.push("7. Cache-hit-rate asymmetry — reported separately, excluded from composite score.");
  lines.push("8. N=3, escalate to N=5 only if IQR > 20.");
  lines.push("");

  lines.push("## Cache-hit-rate (Claude only)");
  lines.push("");
  if (perTool.claude) {
    lines.push("| Trial | cache_hit_rate |");
    lines.push("|---|---|");
    for (const row of allRows.filter((r) => r.tool === "claude")) {
      const chr = row.metrics?.cache_hit_rate ?? "—";
      lines.push(`| ${row.trial} | ${chr} |`);
    }
    lines.push("");
    lines.push(
      "Codex transcripts don't expose enough to compute this. The Cache-hit-rate column for Codex is —; the rollout doesn't expose it.",
    );
  } else {
    lines.push("No Claude trials in this run.");
  }
  lines.push("");

  lines.push("## Per-trial scorecards");
  lines.push("");
  for (const row of allRows) {
    lines.push(`- \`${row.runDir}/score.md\``);
  }
  lines.push("");

  lines.push("## Failure modes (freeform)");
  lines.push("");
  lines.push(
    '_To be filled in by the human after reviewing the per-trial score.md files. Tag patterns (e.g. "schema-drift", "wrong-edge-function-handler") here once they recur._',
  );
  lines.push("");

  lines.push("## Lessons learned (for the methodology)");
  lines.push("");
  lines.push(
    "_To be filled in after the run. Note anything the harness or scorer mishandled, methodology gaps, or surprising agent behaviour._",
  );
  lines.push("");

  await writeFile(reportPath, lines.join("\n"), "utf8");
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${helpText()}\n`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(helpText() + "\n");
    return 0;
  }

  const errors = validateArgs(args);
  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`error: ${e}\n`);
    }
    process.stderr.write(`\n${helpText()}\n`);
    return 1;
  }

  // Tool resolution + PATH check (decision #6 + §3.3/§3.4).
  const tools = args.tool === "both" ? ["claude", "codex"] : [args.tool];
  const resolved = {};
  for (const tool of tools) {
    const r = resolveTool(tool);
    if (!r.ok) {
      const installHint =
        tool === "claude"
          ? "install Claude Code: https://code.claude.com/docs/en/headless"
          : "install Codex CLI: https://developers.openai.com/codex/cli/reference";
      process.stderr.write(`error: ${r.reason} — ${installHint}\n`);
      return 1;
    }
    resolved[tool] = r;
  }

  // Locate prompt.
  const promptPath = join(REPO_ROOT, "eval/prompts", `${args.app}.md`);
  if (!existsSync(promptPath)) {
    process.stderr.write(`error: prompt not found at ${promptPath}\n`);
    return 2;
  }
  let promptText;
  try {
    promptText = readFileSync(promptPath, "utf8");
  } catch (error) {
    process.stderr.write(`error: failed to read prompt: ${error.message}\n`);
    return 2;
  }

  // Resolve workdir / runs-dir / report.
  const workdirBase = args.workdir
    ? resolvePath(args.workdir)
    : await mkdtemp(join(tmpdir(), "baerly-eval-"));
  mkdirSync(workdirBase, { recursive: true });
  const runsDir = resolvePath(args.runsDir ?? join(REPO_ROOT, "eval/runs"));
  mkdirSync(runsDir, { recursive: true });
  const reportPath = resolvePath(
    args.report ?? join(runsDir, `${dateSlug()}-${args.app}-report.md`),
  );

  // Capture prompt + runner SHAs (best-effort; the eval tree may be a
  // worktree without git rev-parse on these paths, so default to
  // "unknown" if it fails).
  const promptSha = await gitRevParse(REPO_ROOT, `HEAD:eval/prompts/${args.app}.md`);
  const runnerSha = await gitRevParse(REPO_ROOT, "HEAD:eval/run.mjs");

  // Capture tool versions up-front.
  const perTool = {};
  for (const tool of tools) {
    perTool[tool] = {
      version: await toolVersion(resolved[tool].path),
      trials: [],
    };
  }

  // §4: no parallelism across trials. Tools run sequentially; trials
  // within a tool run sequentially.
  for (const tool of tools) {
    for (let trial = 1; trial <= args.trials; trial++) {
      const result = await runOneTrial({
        app: args.app,
        tool,
        toolPath: resolved[tool].path,
        trial,
        workdirBase,
        runsDir,
        target: args.target,
        promptText,
        promptSha,
        runnerSha,
      });
      perTool[tool].trials.push(result);
      if (!result.ok) {
        process.stderr.write(
          `warning: trial ${tool}-${trial} produced no metrics (${result.reason ?? "unknown"})\n`,
        );
      }
    }
  }

  await emitReport({
    app: args.app,
    target: args.target,
    args,
    perTool,
    workdirBase,
    runsDir,
    reportPath,
  });

  process.stdout.write(`\nReport written to: ${reportPath}\n`);
  return 0;
}

const code = await main(process.argv.slice(2));
process.exit(code);
