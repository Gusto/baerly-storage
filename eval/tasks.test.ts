import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkSolution, typecheckAll } from "./check.ts";
import type { Verdict } from "./types.ts";
import { createSandboxDir } from "./sandbox.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tasksDir = join(here, "tasks");

const taskNames = readdirSync(tasksDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

// Each golden runs through the same path a real agent solution takes: copied
// into a fresh in-repo sandbox (see eval/sandbox.ts), so dependency resolution
// (e.g. `zod`) is the one a real solution gets. All goldens share one tsc
// pass; the runtime checks then run concurrently.
const sandboxes = new Map<string, string>();
let typecheckPass: Promise<Map<string, Verdict>>;

beforeAll(() => {
  for (const name of taskNames) {
    const sandbox = createSandboxDir(repoRoot, `golden-${name}`);
    copyFileSync(join(tasksDir, name, "golden.ts"), join(sandbox, "solution.ts"));
    sandboxes.set(name, join(sandbox, "solution.ts"));
  }
  typecheckPass = typecheckAll(repoRoot, [...sandboxes.values()]);
});

afterAll(() => {
  for (const solutionPath of sandboxes.values()) {
    rmSync(dirname(solutionPath), { recursive: true, force: true });
  }
});

describe("each task's golden.ts is passable (deterministic gate)", () => {
  test("there is at least one task", () => expect(taskNames.length).toBeGreaterThan(0));
  for (const name of taskNames) {
    test.concurrent(`${name}: golden passes`, async () => {
      const solutionPath = sandboxes.get(name)!;
      const failures = await typecheckPass;
      const tcFail = failures.get(solutionPath);
      if (tcFail) {
        throw new Error(tcFail.reason);
      }
      const v = await checkSolution({
        taskDir: join(tasksDir, name),
        solutionPath,
        repoRoot,
        typechecked: true,
      });
      if (!v.pass) {
        throw new Error(v.reason);
      }
      expect(v.pass).toBe(true);
    });
    test(`${name}: golden answer is NOT present in the prompt`, () => {
      // The fed prompt must never leak the golden solution.
      const prompt = readFileSync(join(tasksDir, name, "prompt.md"), "utf8");
      const golden = readFileSync(join(tasksDir, name, "golden.ts"), "utf8");
      const bodyLines = golden.split("\n").filter((l) => l.includes("db.collection"));
      for (const l of bodyLines) {
        expect(prompt).not.toContain(l.trim());
      }
    });
  }
});
