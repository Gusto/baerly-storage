#!/usr/bin/env node
// Bootstrap a fresh git worktree so verify:agent / test:agent / baerly are usable.
// Two steps: install frozen deps, then build dist/. ~10-30s on a warm cache.

import { execSync } from "node:child_process";

const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

run("pnpm install --frozen-lockfile");
run("pnpm run build");

console.log("\n✓ Worktree ready. Next:");
console.log("    pnpm verify:agent    # typecheck + lint");
console.log("    pnpm test:agent      # zero-infra tests");
