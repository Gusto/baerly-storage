/**
 * Tests for `eval/run.mjs`.
 *
 * Shells out to the script (rather than importing it) — the contract
 * under test is the CLI surface: exit codes, the help text including
 * the eight methodology decisions verbatim, the missing-tool diagnostic,
 * and the end-to-end mocked-agent path that produces `score.md`,
 * `metrics.json`, and `report.md`.
 *
 * Fixtures live under `tests/fixtures/run-eval/`. The mocked-agent
 * test uses `CLAUDE_CLI_OVERRIDE` (a pre-canned transcript shim) and
 * `EVAL_SCAFFOLD_OVERRIDE` (a pre-built minimal scaffold tree) so the
 * test never spawns real `claude` or runs `create-baerly` + `pnpm
 * install`.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execa } from "execa";

const SCRIPT = "eval/run.mjs";
const FIXTURE_DIR = "tests/fixtures/run-eval";

// A PATH that contains node but not `claude` / `codex`. Falls back to
// the system PATH stripped of any user-installed CLI dirs only when
// necessary; on this dev box we resolve node's own directory off
// `process.execPath`.
function nodeOnlyPath(): string {
  const nodeDir = resolvePath(process.execPath, "..");
  return `${nodeDir}:/usr/bin:/bin`;
}

describe("eval/run.mjs", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "run-eval-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("--app missing or invalid: exit 1 with diagnostic listing valid apps", async () => {
    const missing = await execa("node", [SCRIPT], { reject: false });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toMatch(/--app is required/);

    const bad = await execa("node", [SCRIPT, "--app", "garbage"], { reject: false });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toMatch(/unknown app/);
    for (const app of ["todo", "notes", "rsvp", "chat", "shortlink", "kanban", "bookmarks"]) {
      expect(bad.stderr).toContain(app);
    }
  });

  test("missing tool on PATH: exit 1 with a 'not found' diagnostic", async () => {
    const result = await execa("node", [SCRIPT, "--tool", "claude", "--app", "todo"], {
      reject: false,
      env: { PATH: nodeOnlyPath() },
      extendEnv: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/claude not found/);
  });

  test("--help text includes all eight decision strings verbatim", async () => {
    const result = await execa("node", [SCRIPT, "--help"]);
    expect(result.exitCode).toBe(0);
    for (const needle of [
      "Approval mode",
      "Model selection per tool",
      "Commit the scaffolded output",
      "Human-gold baseline",
      "Failure-mode taxonomy",
      "AGENTS.md",
      "Cache-hit-rate",
      "N=3",
    ]) {
      expect(result.stdout).toContain(needle);
    }
  });

  test("end-to-end with mocked agent produces score.md, metrics.json, and report.md", async () => {
    const runsDir = join(workDir, "runs");
    const scaffoldOverride = resolvePath(`${FIXTURE_DIR}/mini-scaffold`);
    const fakeClaude = resolvePath(`${FIXTURE_DIR}/fake-claude.mjs`);
    const reportPath = join(workDir, "report.md");

    const result = await execa(
      "node",
      [
        SCRIPT,
        "--app",
        "todo",
        "--tool",
        "claude",
        "--trials",
        "1",
        "--workdir",
        join(workDir, "scaffolds"),
        "--runs-dir",
        runsDir,
        "--report",
        reportPath,
      ],
      {
        reject: false,
        env: {
          CLAUDE_CLI_OVERRIDE: fakeClaude,
          EVAL_SCAFFOLD_OVERRIDE: scaffoldOverride,
        },
      },
    );

    expect(result.exitCode, `runner stderr:\n${result.stderr}`).toBe(0);
    expect(existsSync(reportPath)).toBe(true);

    const report = await readFile(reportPath, "utf8");
    expect(report).toContain("# Scaffolding eval — todo");
    expect(report).toContain("## Scores");
    expect(report).toContain("## Decisions applied");
    // The scores table should have exactly one data row for the one
    // claude trial we ran. Count rows by matching "| claude | 1 |".
    expect(report).toMatch(/\|\s*claude\s*\|\s*1\s*\|/);

    // Find the per-trial run directory under runsDir. There should be
    // exactly one subdirectory.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(runsDir, { withFileTypes: true });
    const trialDirs = entries.filter((e) => e.isDirectory());
    expect(trialDirs.length).toBe(1);

    const firstTrial = trialDirs[0];
    if (!firstTrial) {
      throw new Error("no trial directory found");
    }
    const trialDir = join(runsDir, firstTrial.name);
    expect(existsSync(join(trialDir, "score.md"))).toBe(true);
    expect(existsSync(join(trialDir, "metrics.json"))).toBe(true);
    expect(existsSync(join(trialDir, "transcript.jsonl"))).toBe(true);
    expect(existsSync(join(trialDir, "acceptance.json"))).toBe(true);
    expect(existsSync(join(trialDir, "env.txt"))).toBe(true);

    const metrics = JSON.parse(await readFile(join(trialDir, "metrics.json"), "utf8"));
    expect(metrics.tool).toBe("claude");
  });
});
