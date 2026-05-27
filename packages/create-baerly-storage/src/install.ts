/**
 * `Installer` DI seam for the post-scaffold install step. The default
 * implementation shells out to the detected package manager via
 * `node:child_process.spawn` with `stdio: "inherit"` so the user sees
 * the pm's own progress (pnpm's spinner, npm's bars). Tests inject a
 * mock to avoid spawning real installs.
 *
 * Mirrors the shape of `packages/cli/src/runner.ts:ProcessRunner` —
 * intentionally not imported cross-package because `create-baerly-storage`
 * has its own dependency surface (no `@baerly/cli` dep).
 */
import { spawn } from "node:child_process";
import type { Pm } from "./pm-detect.ts";

export interface Installer {
  /**
   * Run `<pm> install` in `cwd`. Resolves with the child's exit code.
   * Never throws on a non-zero exit — the caller decides whether that
   * should be fatal. Throws only if `spawn` itself fails (binary not
   * on PATH, permission denied).
   */
  run(pm: Pm, cwd: string): Promise<{ readonly code: number }>;
}

export const defaultInstaller: Installer = {
  run: (pm, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(pm, ["install"], { cwd, stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1 }));
    }),
};
