// Fixture project for `tests/unit/gate-manifest.test.ts`: the real gate
// ledger over one file whose gated suites always skip. Not collected by
// the root config (`*.fixture.ts` matches no root `include` glob).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["*.fixture.ts"],
    globalSetup: ["../../setup/gate-ledger.ts"],
    pool: "forks",
  },
});
