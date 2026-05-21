// scripts/bundle-sizes.mjs — prints one BUNDLE_SIZE line per entry/kind for
// every closure in tests/integration/bundle-size.test.ts:BUDGETS. Always
// succeeds (exit 0). Use for at-a-glance budget visibility without running
// the full vitest suite.
import { spawnSync } from "node:child_process";
spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "tests/integration/bundle-size.test.ts", "--reporter=default"],
  {
    stdio: "inherit",
    env: { ...process.env, BUNDLE_SIZE_REPORT: "1" },
  },
);
