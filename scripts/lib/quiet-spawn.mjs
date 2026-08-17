// Shared "run a command, silence it on success" helper for the agent-noise
// scripts (build-agent.mjs, bundle-sizes.ts's self-build, prepare.mjs's quiet
// build). All three ran a build via spawnSync, captured stdout/stderr instead
// of inheriting them, and replayed both plus the exit code only on failure --
// the same ~15 lines copied three times, so a fix to the replay logic had to
// land in three places or drift.
//
// spawnSync's default maxBuffer is 1 MiB per stream; a verbose-but-successful
// build (this is precisely what these callers capture: rolldown's ~150-line
// per-asset/chunk table) that exceeds it gets its child process killed, which
// leaves `status: null` and makes a real success look like a failure. The
// explicit maxBuffer below is far above anything a build here has ever
// printed, so that failure mode can't recur silently.
import { spawnSync } from "node:child_process";

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Run `cmd args` with stdout/stderr captured instead of inherited. On
 * success, the capture is discarded. On failure, both streams are replayed
 * in order and the process exits with the child's status. A failure always
 * prints something: when the child never ran or was killed, there is no
 * captured output to replay, so the out-of-band reason is printed instead.
 */
export function spawnQuiet(cmd, args) {
  const result = spawnSync(cmd, args, {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    // Two failure modes leave `status: null` and report the reason only
    // out-of-band: `error` for a child that never ran (ENOENT, EACCES) or
    // overran maxBuffer, `signal` for one that was killed (OOM, SIGINT). In
    // both cases the captured streams can be empty or `undefined`, so the
    // replay above prints nothing -- and a bare `exit 1` with no diagnostic is
    // the one outcome worse for an agent than the noise this helper removes.
    const invocation = [cmd, ...args].join(" ");
    if (result.error) {
      process.stderr.write(`${invocation} failed to run: ${result.error.message}\n`);
    } else if (result.signal) {
      process.stderr.write(`${invocation} was killed by ${result.signal}\n`);
    }
    process.exit(result.status ?? 1);
  }
}
