import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { checkSolution } from "./check.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
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
