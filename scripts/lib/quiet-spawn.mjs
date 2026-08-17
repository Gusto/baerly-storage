// Shared "run a command, silence it on success" helper for the agent-noise
// scripts (build-agent.mjs, bundle-sizes.ts's self-build, prepare.mjs's quiet
// build). All three ran a build via spawnSync, captured its output instead of
// inheriting it, and replayed it plus the exit code only on failure -- the same
// ~15 lines copied three times, so a fix to the replay logic had to land in
// three places or drift.
//
// Why capture rather than suppress: rolldown's ~103-line per-asset/chunk size
// table has no suppress flag -- its CLI calls the printer unconditionally and
// `--logLevel silent` measurably does not touch it. Discarding stdout and
// inheriting stderr does not work either: `pnpm -r` writes its own failure
// recap (ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL, which package failed, the exit
// status) to STDOUT, so dropping stdout drops the most useful line of a build
// failure.
//
// Both streams go to one temp file rather than two pipes so the replay
// preserves the real interleaving. `pnpm build` splits diagnostics across
// streams -- pnpm's recap on stdout, rolldown's error on stderr -- and a
// two-stream replay prints the error after the recap that summarizes it. A
// single merged fd also has no capture ceiling to tune: spawnSync's maxBuffer
// applies only to `pipe` stdio.
//
// Two accepted costs, both inherent to capture-and-replay:
//   - Nothing prints while the command runs, so a hung build looks identical
//     to a slow one. Inheriting is the only cure and it defeats the purpose.
//   - The replay is one write before process.exit, which on a pipe truncates
//     past one pipe buffer (~64 KiB). A whole successful build prints 6.5 kB
//     and a realistic failure ~2 kB, so that is ~32x of headroom. If a genuine
//     >64 KiB failure ever appears, the measured one-line escalation is to
//     replay with spawnSync("cat", [logPath], { stdio: ["ignore", "inherit",
//     "inherit"] }), which is synchronous and passes 8 MiB intact.
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run `cmd args` with stdout and stderr merged into one captured stream
 * instead of inherited. On success the capture is discarded. On failure it is
 * replayed in its original order and the process exits with the child's
 * status. Never returns on failure -- callers rely on that: returning would
 * let bundle-sizes.ts measure a stale dist/ after a failed build.
 *
 * A failure always prints a final line naming the invocation and how it ended,
 * including the case where the child exited nonzero having printed nothing.
 */
export function spawnQuiet(cmd, args) {
  const dir = mkdtempSync(join(tmpdir(), "baerly-quiet-"));
  const logPath = join(dir, "output.log");
  const fd = openSync(logPath, "w");
  let result;
  try {
    result = spawnSync(cmd, args, { stdio: ["inherit", fd, fd] });
  } finally {
    closeSync(fd);
  }
  if (result.status === 0) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const captured = readFileSync(logPath, "utf8");
  rmSync(dir, { recursive: true, force: true });
  if (captured) {
    process.stdout.write(captured);
  }
  // Three disjoint endings, so a failure can never exit without a diagnostic:
  // `error` for a child that never ran (ENOENT, EACCES), `signal` for one that
  // was killed (OOM, SIGINT), and a numeric status otherwise -- including a
  // nonzero exit that printed nothing, which previously fell through to a bare
  // exit with no output at all. Kept as an else-if chain because `status` is
  // null in the first two cases, and an unconditional status line would print
  // "exited with status null".
  const invocation = [cmd, ...args].join(" ");
  if (result.error) {
    process.stderr.write(`${invocation} failed to run: ${result.error.message}\n`);
  } else if (result.signal) {
    process.stderr.write(`${invocation} was killed by ${result.signal}\n`);
  } else {
    process.stderr.write(`${invocation} exited with status ${result.status}\n`);
  }
  process.exit(result.status ?? 1);
}
