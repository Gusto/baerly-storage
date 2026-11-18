// @ts-check
// StrykerJS mutation testing, scoped to the pure protocol kernel.
// Manual, on-demand tool: `pnpm test:mutate`. NOT wired into verify/test/CI.
// See docs/contributing/mutation-testing.md for the why and how-to-read.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // Point the vitest runner at the dedicated scoped config (protocol-only,
  // Node forks). Never the root two-project vitest.config.ts.
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
  // Stryker copies the whole project into `.stryker-tmp/sandbox-*/` and does
  // NOT read `.gitignore` — only `node_modules`, `.git`, `/reports`,
  // `*.tsbuildinfo`, `/stryker.log`, and `.stryker-tmp` are ignored for free.
  // Everything here is gitignored local state that no protocol unit test
  // reads, and each entry earns its place:
  //   - `credentials/` holds real AWS/R2/GCS keys for the manual-e2e suites.
  //     Copying live secrets into a temp dir that outlives a crashed run is
  //     not something a mutation run should ever do.
  //   - `.pnpm-store/` is a repo-local pnpm store whose `v11/projects/*`
  //     entries are symlinks to worktrees. Once a worktree is removed its
  //     symlink dangles, and the sandbox copy dies on it with
  //     `ENOENT: copyfile`.
  //   - the worktree roots and agent scratch are gigabytes of sibling
  //     checkouts; `dist/` is build output the mutated sources don't use.
  ignorePatterns: ["credentials", ".pnpm-store", ".worktrees", ".claude", ".plans", "dist"],
  // pnpm isolates each package under .pnpm/; the vitest-runner lives in its
  // own bucket, invisible to Stryker's default "@stryker-mutator/*" glob
  // (which resolves relative to core's own isolated node_modules). Naming it
  // explicitly forces discovery through the project-root symlink instead.
  plugins: ["@stryker-mutator/vitest-runner"],
  reporters: ["clear-text", "progress", "json", "html"],
  htmlReporter: { fileName: "reports/mutation/protocol.html" },
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
};
