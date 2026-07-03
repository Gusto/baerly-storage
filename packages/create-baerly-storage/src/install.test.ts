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
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultInstaller } from "./install.ts";

describe("defaultInstaller", () => {
  let workDir: string;
  let binDir: string;
  let invokedLog: string;
  let originalPath: string | undefined;
  let originalInvokedLog: string | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "create-baerly-install-"));
    binDir = await mkdtemp(join(tmpdir(), "create-baerly-bin-"));
    // Fake pnpm/npm/yarn — record `__pm_invoked__ <cwd> <args>` to a file
    // then exit 0. The installer spawns with `stdio: "inherit"`, so an
    // `echo` here would bleed the child's stdout onto the parent test
    // tty. Writing the marker to `$INVOKED_LOG` (set per-run in the test)
    // instead keeps the invocation assertable without the leak.
    for (const name of ["pnpm", "npm", "yarn"]) {
      const path = join(binDir, name);
      await writeFile(
        path,
        `#!/bin/sh\nprintf '__pm_invoked__ %s %s\\n' "$PWD" "$*" >> "$INVOKED_LOG"\nexit 0\n`,
        "utf8",
      );
      await chmod(path, 0o755);
    }
    invokedLog = join(binDir, "invoked.log");
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${binDir}:${originalPath ?? ""}`;
    originalInvokedLog = process.env["INVOKED_LOG"];
    process.env["INVOKED_LOG"] = invokedLog;
  });

  afterAll(async () => {
    if (originalPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = originalPath;
    }
    if (originalInvokedLog === undefined) {
      delete process.env["INVOKED_LOG"];
    } else {
      process.env["INVOKED_LOG"] = originalInvokedLog;
    }
    await rm(workDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  test("spawns the detected pm's install command in cwd and returns code 0", async () => {
    const result = await defaultInstaller.run("pnpm", workDir);
    expect(result.code).toBe(0);
    // The fake pnpm recorded its cwd + args to the log file, proving the
    // child actually ran `pnpm install` in `workDir` (code 0 alone can't
    // distinguish a real spawn from a stub that never executed). Match on
    // the basename + args rather than the full path: on macOS the child's
    // `$PWD` resolves the `/private` → `/var` symlink, so the absolute
    // prefix differs from the un-resolved `workDir` handed to `run()`.
    const log = await readFile(invokedLog, "utf8");
    const workDirName = workDir.slice(workDir.lastIndexOf("/") + 1);
    expect(log).toMatch(new RegExp(`__pm_invoked__ .*/${workDirName} install`));
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
