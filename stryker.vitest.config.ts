// Dedicated vitest config for StrykerJS mutation runs. Stryker points
// at this via `vitest.configFile` in `stryker.config.mjs`. It is a flat
// single-project config — deliberately NOT the two-project shape of the
// root `vitest.config.ts` — so mutation runs only ever exercise the pure
// protocol kernel under Node forks. The Workerd `cloudflare-pool` project
// and the Minio/credentials/manual-e2e globs are never in scope here.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "stryker-protocol",
    // Only the protocol package's pure unit tests. Every file here runs
    // with zero infrastructure (no Minio, no Workerd, no credentials).
    include: ["packages/protocol/src/**/*.test.ts"],
    // Shared fast-check wiring (FC_NUM_RUNS) — matches the default project
    // so property-based protocol tests behave identically under Stryker.
    setupFiles: ["tests/setup/fast-check.ts"],
    // Forks pool mirrors the default project. The `--js-base-64` execArgv is
    // load-bearing: bytes.ts / hashing use Uint8Array.{toBase64,fromBase64},
    // which are gated behind this V8 flag on Node 24. Without it the base64
    // paths throw and mutants there report as false "killed".
    pool: "forks",
    execArgv: ["--js-base-64"],
    // Full assertion diffs (the default truncates at ~40 chars).
    chaiConfig: { truncateThreshold: 0 },
  },
});
