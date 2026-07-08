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

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!isSecondaryWorktree()) {
  run("pnpm", ["exec", "lefthook", "install"]);
}
if (process.env.BAERLY_SKIP_BUILD) {
  console.log("prepare: BAERLY_SKIP_BUILD set — reusing current dist/, skipping build.");
} else {
  run("pnpm", ["run", "build"]);
}
