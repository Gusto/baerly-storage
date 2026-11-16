import { describe, test, expect, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSolution, minimalEnv } from "./check.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("eval published runtime resolution", () => {
  test("the real runner resolves every published subpath to dist", async () => {
    const verdict = await checkSolution({
      repoRoot,
      taskDir: join(repoRoot, "eval/__fixtures__/task-runtime-surface"),
      solutionPath: join(repoRoot, "eval/__fixtures__/good-solution.ts"),
    });
    expect(verdict).toEqual({
      pass: true,
      reason: "every published subpath resolves to its built runtime",
    });
  });

  test("a missing bundle fails instead of falling back to workspace source", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-missing-dist-"));
    try {
      mkdirSync(join(root, "eval"));
      copyFileSync(
        join(repoRoot, "eval/resolve-package.mjs"),
        join(root, "eval/resolve-package.mjs"),
      );
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "@gusto/baerly-storage",
          type: "module",
          exports: { ".": "./source.js" },
          publishConfig: {
            exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
          },
        }),
      );
      writeFileSync(join(root, "source.js"), 'export const sentinel = "workspace";');
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          join(root, "eval/resolve-package.mjs"),
          "--input-type=module",
          "-e",
          'await import("@gusto/baerly-storage");',
        ],
        { cwd: root, encoding: "utf8", env: minimalEnv(), timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/ERR_MODULE_NOT_FOUND|ENOENT/);
      expect(result.stderr).toContain("dist/index.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
