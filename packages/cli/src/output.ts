/**
 * Output contract for `baerly`. Two modes:
 *
 *   - text (default): preserves the legacy `baerly <cmd>: <code>:
 *     <msg>\n` shape on stderr (asserted by `copy.test.ts`); stdout
 *     stays silent on success.
 *   - JSON (`--json`): one structured envelope per invocation —
 *     `{result,...}` on stdout for success, `{error:{code,message,
 *     command}}` on stderr for failure. Picked up by agents that
 *     drive the CLI programmatically.
 *
 * Detection of `--json` happens twice — once in `baerly.ts` before
 * `runMain` (so a parse-time error from citty also honors the flag)
 * and once inside each subcommand's `run` handler (so programmatic
 * `runCopy` callers like `copy.test.ts` work without going through
 * the entry).
 */

import pc from "picocolors";

let jsonMode = false;

/** Toggle JSON-envelope output mode. Called from `baerly.ts` and each subcommand. */
export const setJsonMode = (v: boolean): void => {
  jsonMode = v;
};

export const isJsonMode = (): boolean => jsonMode;

/**
 * Color helpers — no-ops in JSON mode (so emitted JSON stays
 * machine-parseable) and when `picocolors` detects a non-TTY or
 * `NO_COLOR`.
 */
export const color = {
  red: (s: string): string => (jsonMode ? s : pc.red(s)),
  yellow: (s: string): string => (jsonMode ? s : pc.yellow(s)),
  dim: (s: string): string => (jsonMode ? s : pc.dim(s)),
};

/**
 * Emit an error. Text mode preserves the exact `baerly <cmd>:
 * <code>: <msg>\n` shape that `copy.test.ts` (transitively) and any
 * scripts piping stderr already expect.
 */
export const emitError = (command: string, code: string, message: string): void => {
  if (jsonMode) {
    process.stderr.write(`${JSON.stringify({ error: { code, message, command } })}\n`);
  } else {
    process.stderr.write(`baerly ${command}: ${code}: ${message}\n`);
  }
};

/**
 * Emit a success result. No-op in text mode (subcommands stay silent
 * on success, matching the existing contract); in JSON mode writes
 * one structured envelope to stdout.
 */
export const emitSuccess = (data: Record<string, unknown>): void => {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ result: data })}\n`);
  }
};
