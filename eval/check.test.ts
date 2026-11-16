import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSandboxDir } from "./sandbox.ts";
import { checkSolution } from "./check.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const taskDir = `${here}__fixtures__/task-roundtrip`;

describe("checkSolution (needs built dist/)", () => {
  test("known-good solution passes typecheck + runtime", async () => {
    const v = await checkSolution({
      taskDir,
      solutionPath: `${here}__fixtures__/good-solution.ts`,
      repoRoot,
    });
    expect(v.pass).toBe(true);
  });

  test("known-bad solution (.findOneById) fails on typecheck", async () => {
    const v = await checkSolution({
      taskDir,
      solutionPath: `${here}__fixtures__/bad-solution.ts`,
      repoRoot,
    });
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/^typecheck failed:[\s\S]*findOneById/);
  });
});

describe("insert-get grades the stored row, not a hardcoded answer", () => {
  test("a solution that returns the literal answer fails", async () => {
    const v = await checkSolution({
      taskDir: `${here}tasks/insert-get`,
      solutionPath: `${here}__fixtures__/hardcoded-solution.ts`,
      repoRoot,
    });
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/no string _id/);
  });
});

describe("checkSolution isolates the parent environment", () => {
  beforeAll(() => {
    process.env["EVAL_SENTINEL_SECRET"] = "leak-me";
  });
  afterAll(() => {
    delete process.env["EVAL_SENTINEL_SECRET"];
  });

  test("a sentinel env var does not reach the solution runner", async () => {
    const v = await checkSolution({
      taskDir: `${here}__fixtures__/task-env`,
      solutionPath: `${here}__fixtures__/env-solution.ts`,
      repoRoot,
    });
    expect(v.reason).toBe("sentinel env var did not reach the runner");
    expect(v.pass).toBe(true);
  });
});

describe("retry-helper rejects incorrect retry policies", () => {
  const golden = readFileSync(`${here}tasks/retry-helper/golden.ts`, "utf8");
  test.each([
    {
      name: "never retries NetworkError",
      from: "!error.retriable",
      to: '!(error.code === "WriteConflict" || error.code === "MaintenancePending")',
    },
    { name: "retries terminal library errors", from: "!error.retriable", to: "false" },
    { name: "takes four attempts", from: "attempt === 3", to: "attempt === 4" },
    {
      name: "treats retryAfter zero as absent",
      from: "error.retryAfter !== undefined",
      to: "error.retryAfter",
    },
    {
      name: "does not convert seconds to milliseconds",
      from: "error.retryAfter * 1000",
      to: "error.retryAfter",
    },
    { name: "uses the wrong default delay", from: ": 100)", to: ": 1)" },
    { name: "wraps the final error", from: "throw error;", to: 'throw new Error("wrapped");' },
  ])("$name", async ({ from, to }) => {
    expect(golden).toContain(from);
    const sandbox = createSandboxDir(repoRoot, "incorrect-retry");
    try {
      const solutionPath = join(sandbox, "solution.ts");
      writeFileSync(solutionPath, golden.replace(from, to));
      const verdict = await checkSolution({
        repoRoot,
        taskDir: `${here}tasks/retry-helper`,
        solutionPath,
      });
      expect(verdict.pass).toBe(false);
      // Only the task checker rejecting the policy proves this regression.
      expect(verdict.reason).toMatch(/must (?:recover|rethrow|be rethrown)/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
