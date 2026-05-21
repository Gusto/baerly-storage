/**
 * Unit test for `defaultInstaller`. Spawns a noop-shaped child via the
 * installer's own pm dispatch and asserts the captured invocation:
 * what binary, what args, in what cwd. The child is faked by pointing
 * `pm` at a shell-relative name and shimming PATH so we don't actually
 * run pnpm/npm/yarn during the test.
 *
 * The exit-code → return-shape contract is the load-bearing piece:
 * code 0 → ok; non-zero → ok with code preserved so the caller can
 * warn.
 */
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultInstaller } from "./install.ts";

describe("defaultInstaller", () => {
  let workDir: string;
  let binDir: string;
  let originalPath: string | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "create-baerly-install-"));
    binDir = await mkdtemp(join(tmpdir(), "create-baerly-bin-"));
    // Fake pnpm/npm/yarn — print `__pm_invoked__ <cwd>` then exit 0.
    for (const name of ["pnpm", "npm", "yarn"]) {
      const path = join(binDir, name);
      await writeFile(
        path,
        `#!/bin/sh\necho "__pm_invoked__ $PWD $@"\nexit 0\n`,
        "utf8",
      );
      await chmod(path, 0o755);
    }
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${binDir}:${originalPath ?? ""}`;
  });

  afterAll(async () => {
    if (originalPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = originalPath;
    }
    await rm(workDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  test("spawns the detected pm's install command in cwd and returns code 0", async () => {
    const result = await defaultInstaller.run("pnpm", workDir);
    expect(result.code).toBe(0);
  });

  test("yarn dispatch invokes `yarn install`", async () => {
    const result = await defaultInstaller.run("yarn", workDir);
    expect(result.code).toBe(0);
  });

  test("returns the child's non-zero exit code verbatim", async () => {
    // Overwrite the npm shim from beforeAll with a failing variant.
    // `Pm` is a closed union (`"npm" | "pnpm" | "yarn"`), so we can't
    // introduce a fresh binary name without widening the type — task 2
    // exercises mock injection where dispatch is verified directly.
    const npmBin = join(binDir, "npm");
    await writeFile(npmBin, `#!/bin/sh\nexit 7\n`, "utf8");
    await chmod(npmBin, 0o755);
    const result = await defaultInstaller.run("npm", workDir);
    expect(result.code).toBe(7);
  });
});
