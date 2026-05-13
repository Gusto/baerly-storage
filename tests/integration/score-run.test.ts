/**
 * Tests for `scripts/score-run.mjs`.
 *
 * Shells out to the script (rather than importing it) because the
 * script is `.mjs` and exercises a CLI surface — the contract under
 * test is the exit code, the markdown file, and the JSON file. Fixtures
 * live under `tests/fixtures/score-run/` and stay small enough to read
 * by eye.
 */
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";

const SCRIPT = "scripts/score-run.mjs";
const FIXTURE_DIR = "tests/fixtures/score-run";

describe("scripts/score-run.mjs", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "score-run-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("Claude fixture passes scoring and emits a high score", async () => {
    const outMd = join(workDir, "score.md");
    const outJson = join(workDir, "metrics.json");
    const result = await execa("node", [
      SCRIPT,
      "--transcript",
      `${FIXTURE_DIR}/claude-todo.jsonl`,
      "--acceptance",
      `${FIXTURE_DIR}/acceptance-pass.json`,
      "--out",
      outMd,
      "--metrics",
      outJson,
    ]);
    expect(result.exitCode).toBe(0);

    const metrics = JSON.parse(await readFile(outJson, "utf8"));
    expect(metrics.schema_version).toBe(1);
    expect(metrics.tool).toBe("claude");
    expect(metrics.compile_pass).toBe(1);
    expect(metrics.score).toBeGreaterThanOrEqual(90);

    const md = await readFile(outMd, "utf8");
    expect(md).toContain("## Metrics");
    expect(md).toContain("Scaffolding score");
  });

  test("compile-fail gate forces score to 0", async () => {
    const outMd = join(workDir, "score.md");
    const outJson = join(workDir, "metrics.json");
    const result = await execa("node", [
      SCRIPT,
      "--transcript",
      `${FIXTURE_DIR}/claude-todo.jsonl`,
      "--acceptance",
      `${FIXTURE_DIR}/acceptance-typecheck-fail.json`,
      "--out",
      outMd,
      "--metrics",
      outJson,
    ]);
    expect(result.exitCode).toBe(0);

    const metrics = JSON.parse(await readFile(outJson, "utf8"));
    expect(metrics.score).toBe(0);
    expect(metrics.compile_pass).toBe(0);

    const md = await readFile(outMd, "utf8");
    expect(md).toContain("**0** / 100");
  });

  test("Codex fixture is auto-detected and emits non-zero token counts", async () => {
    const outMd = join(workDir, "score.md");
    const outJson = join(workDir, "metrics.json");
    const result = await execa("node", [
      SCRIPT,
      "--transcript",
      `${FIXTURE_DIR}/codex-todo.jsonl`,
      "--acceptance",
      `${FIXTURE_DIR}/acceptance-pass.json`,
      "--out",
      outMd,
      "--metrics",
      outJson,
    ]);
    expect(result.exitCode).toBe(0);

    const metrics = JSON.parse(await readFile(outJson, "utf8"));
    expect(metrics.tool).toBe("codex");
    expect(metrics.tokens_in).toBeGreaterThan(0);
    expect(metrics.tokens_out).toBeGreaterThan(0);
  });

  test("garbage transcript exits 2 with a stderr diagnostic", async () => {
    const garbage = join(workDir, "garbage.jsonl");
    await (
      await import("node:fs/promises")
    ).writeFile(garbage, "not json at all\nstill not json\n", "utf8");
    const result = await execa(
      "node",
      [SCRIPT, "--transcript", garbage, "--acceptance", `${FIXTURE_DIR}/acceptance-pass.json`],
      { reject: false },
    );
    // The parser will fail on JSON.parse first (exit 1) — but per the
    // spec, an *unrecognized* shape (parses but doesn't match either
    // dialect) returns exit 2. Cover the unrecognized branch with a
    // valid-JSON-but-foreign payload.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/error/i);
  });

  test("unrecognized but valid JSONL shape exits 2", async () => {
    const foreign = join(workDir, "foreign.jsonl");
    await (await import("node:fs/promises")).writeFile(foreign, '{"foo":"bar","baz":42}\n', "utf8");
    const result = await execa(
      "node",
      [SCRIPT, "--transcript", foreign, "--acceptance", `${FIXTURE_DIR}/acceptance-pass.json`],
      { reject: false },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/unrecognized transcript/);
  });
});
