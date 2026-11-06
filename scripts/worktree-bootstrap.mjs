#!/usr/bin/env node
// Bootstrap a fresh git worktree so verify:agent / test:agent / baerly are usable.
// `pnpm install` triggers the `prepare` hook, which builds dist/ — so a
// separate build step here would just re-bundle. ~10-30s on a warm cache.

import { execSync } from "node:child_process";
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

// worktree:bootstrap must leave dist/ built; a fresh worktree has nothing to
// reuse, so ignore any ambient BAERLY_SKIP_BUILD (an internal "reuse dist/" flag).
delete process.env.BAERLY_SKIP_BUILD;

run("pnpm install --frozen-lockfile");

// `credentials/` is gitignored, so a new worktree has none and the
// credentialed suites skip. Link the main checkout's copy when one exists.
const mainCheckout = dirname(
  resolve(execSync("git rev-parse --path-format=absolute --git-common-dir").toString().trim()),
);
const shared = join(mainCheckout, "credentials");
const local = resolve("credentials");
const hasLocal = (() => {
  try {
    lstatSync(local);
    return true;
  } catch {
    return false;
  }
})();
if (local !== shared && existsSync(shared) && !hasLocal) {
  symlinkSync(shared, local, "dir");
  console.log(`\n✓ Linked credentials/ -> ${shared}`);
}

console.log("\n✓ Worktree ready. Next:");
console.log("    pnpm verify:agent    # typecheck + lint");
console.log("    pnpm test:agent      # zero-infra tests");
