/**
 * `ProcessRunner` interface + default `node:child_process.spawn`-backed
 * implementation. Shared by `baerly deploy` and `baerly doctor`, both of
 * which shell out to Wrangler.
 *
 * Tests inject a mock; production uses {@link defaultRunner}. Pass
 * `{ tee: true }` to also write the child's stdout/stderr to the parent
 * process — `baerly deploy` does this so the operator sees Wrangler's
 * progress in real time; `baerly doctor` captures silently for parsing.
 */

import { spawn } from "node:child_process";

export interface ProcessRunner {
  /**
   * Run `cmd` with `args` in `cwd`. Returns the integer exit code plus
   * captured stdout/stderr. Captured output is also tee'd to the host
   * process's stdout/stderr when the runner was constructed with
   * `{ tee: true }`.
   */
  run(
    cmd: string,
    args: readonly string[],
    cwd: string,
  ): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

/**
 * Default `node:child_process.spawn`-backed runner. Inherits stdin and
 * captures stdout/stderr. With `tee: true` the captured bytes are also
 * forwarded to the parent process so the user sees the child's progress
 * in real time.
 */
export const defaultRunner = (opts: { readonly tee?: boolean } = {}): ProcessRunner => {
  const tee = opts.tee === true;
  return {
    run: (cmd, args, cwd) =>
      new Promise((res, rej) => {
        const child = spawn(cmd, args as string[], {
          cwd,
          stdio: ["inherit", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (b: Buffer) => {
          stdout += b.toString("utf8");
          if (tee) {
            process.stdout.write(b);
          }
        });
        child.stderr?.on("data", (b: Buffer) => {
          stderr += b.toString("utf8");
          if (tee) {
            process.stderr.write(b);
          }
        });
        child.on("error", rej);
        child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
      }),
  };
};
