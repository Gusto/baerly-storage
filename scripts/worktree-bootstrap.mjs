#!/usr/bin/env node
// Bootstrap a fresh git worktree so verify:agent / test:agent / baerly are usable.
// `pnpm install` triggers the `prepare` hook, which builds dist/ — so a
// separate build step here would just re-bundle. ~10-30s on a warm cache.

import { execSync } from "node:child_process";

const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

// worktree:bootstrap must leave dist/ built; a fresh worktree has nothing to
// reuse, so ignore any ambient BAERLY_SKIP_BUILD (an internal "reuse dist/" flag).
delete process.env.BAERLY_SKIP_BUILD;

run("pnpm install --frozen-lockfile");

console.log("\n✓ Worktree ready. Next:");
console.log("    pnpm verify:agent    # typecheck + lint");
console.log("    pnpm test:agent      # zero-infra tests");
