// @ts-check
// StrykerJS mutation testing, scoped to the pure protocol kernel.
// Manual, on-demand tool: `pnpm test:mutate`. NOT wired into verify/test/CI.
// See docs/contributing/mutation-testing.md for the why and how-to-read.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // Point the vitest runner at the dedicated scoped config (protocol-only,
  // Node forks, --js-base-64). Never the root two-project vitest.config.ts.
  vitest: {
    configFile: "stryker.vitest.config.ts",
  },
  // Mutate the protocol kernel's logic only. Exclude tests, type-only test
  // files, barrel re-exports (no logic to mutate), and the storage
  // conformance harness (test scaffolding, not production logic).
  mutate: [
    "packages/protocol/src/**/*.ts",
    "!packages/protocol/src/**/*.test.ts",
    "!packages/protocol/src/**/*.test-d.ts",
    "!packages/protocol/src/**/index.ts",
    "!packages/protocol/src/storage/conformance.ts",
  ],
  // pnpm isolates each package under .pnpm/; the vitest-runner lives in its
  // own bucket, invisible to Stryker's default "@stryker-mutator/*" glob
  // (which resolves relative to core's own isolated node_modules). Adding an
  // explicit entry forces discovery through the project-root symlink instead.
  plugins: ["@stryker-mutator/*", "@stryker-mutator/vitest-runner"],
  // The vitest-runner hardcodes `pool: "threads"` (worker_threads, not
  // child-process forks). worker_threads reject --js-base-64 as an invalid
  // execArgv flag. Passing it here injects it into the Stryker child-process
  // host that owns each vitest instance; threads workers inherit it from the
  // parent process, so Uint8Array.{toBase64,fromBase64} (bytes.ts, hashing)
  // work correctly and those mutants are not falsely killed.
  testRunnerNodeArgs: ["--js-base-64"],
  // perTest only re-runs the tests that cover each mutant — the main speed
  // lever. Requires the runner to report per-test coverage (vitest does).
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "json", "html"],
  htmlReporter: { fileName: "reports/mutation/protocol.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // Baseline tool: report only, never fail. `break: null` means the run
  // exits 0 regardless of score. Revisit once a baseline is established.
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: ".stryker-tmp",
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
};
