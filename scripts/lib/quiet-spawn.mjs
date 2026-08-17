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
 * in order and the process exits with the child's status.
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
    process.exit(result.status ?? 1);
  }
}
