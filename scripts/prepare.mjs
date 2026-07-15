// scripts/prepare.mjs
// pnpm `prepare` lifecycle hook. Two behaviors:
//   - In the primary checkout: install lefthook + run build.
//   - In a secondary worktree: skip lefthook install (the parent already
//     wired hooks; re-installing flaps core.hooksPath) and still run build.
// The build is skipped when BAERLY_SKIP_BUILD is set (reuse the current
// dist/, mirroring build-if-needed.mjs), so a caller that already built —
// e.g. publish.mjs after verify:package — doesn't rebuild.
// Detection: `git rev-parse --git-dir` differs from `--git-common-dir`
// when called inside a secondary worktree.
import { execSync, spawnSync } from "node:child_process";

function isSecondaryWorktree() {
  try {
    const dir = execSync("git rev-parse --git-dir", { encoding: "utf8" }).trim();
    const common = execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim();
    return dir !== common;
  } catch {
    // Not a git checkout (e.g. consumer's installed copy): skip lefthook entirely.
    return true;
  }
}

function run(cmd, args, { quiet = false } = {}) {
  // `quiet` captures stdout/stderr instead of inheriting it: the rolldown
  // build prints a ~125-line per-asset/chunk size table that has no clean
  // CLI suppress flag and is pure noise on a green `pnpm install` (it runs
  // via this hook on every CI install). On failure the captured output is
  // replayed so nothing is lost. Same capture-and-replay-on-failure shape as
  // scripts/check-exports.mjs, but that one inherits stderr (its noise is on
  // stdout); here we also capture stderr to fully silence a green build, which
  // means build warnings that don't fail the build are dropped on success.
  const result = spawnSync(cmd, args, {
    stdio: quiet ? ["inherit", "pipe", "pipe"] : "inherit",
    ...(quiet ? { encoding: "utf8" } : {}),
  });
  if (result.status !== 0) {
    if (quiet) {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }
    process.exit(result.status ?? 1);
  }
}

if (!isSecondaryWorktree()) {
  run("pnpm", ["exec", "lefthook", "install"]);
}
if (process.env.BAERLY_SKIP_BUILD) {
  console.log("prepare: BAERLY_SKIP_BUILD set — reusing current dist/, skipping build.");
} else {
  run("pnpm", ["run", "build"], { quiet: true });
}
