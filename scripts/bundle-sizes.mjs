// scripts/bundle-sizes.mjs — prints one BUNDLE_SIZE line per entry/kind for
// every closure in tests/integration/bundle-size.test.ts:BUDGETS. Use for
// at-a-glance budget visibility without grep-ing vitest output.
//
// Builds dist/ first because invoking vitest via `pnpm exec` bypasses
// `pretest`. The build is cached when nothing changed, so re-runs are fast.
import { spawnSync } from "node:child_process";

function run(cmd, args, extraOpts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...extraOpts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("pnpm", ["run", "build"]);
run(
  "pnpm",
  ["exec", "vitest", "run", "tests/integration/bundle-size.test.ts", "--reporter=default"],
  { env: { ...process.env, BUNDLE_SIZE_REPORT: "1" } },
);
