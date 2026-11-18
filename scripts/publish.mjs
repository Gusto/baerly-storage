#!/usr/bin/env node
// Publish the two public @gusto packages to npmjs.com.
//
// Runs in `.github/workflows/release.yml` on a `v*` tag push. npm trusted
// publishing exchanges the job's OIDC token for a short-lived publish
// credential and attaches provenance, so there is no token or OTP here;
// `publishConfig.provenance` stays unset so trusted publishing decides.
//
// Both packages publish with `--access public`. `publishConfig.access` is
// set in each package.json too; the flag is passed explicitly because
// pnpm has historically dropped it on the wire.
//
// Usage:
//   pnpm release              publish both packages (CI only)
//   pnpm release --dry-run    gate + pack both packages, no writes
//
// Flags parse strictly: an unknown or mistyped flag (`--dryrun`,
// `--dry-run=true`) aborts instead of falling through to a real publish.

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

let dryRun;
try {
  ({
    values: { "dry-run": dryRun },
  } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } }, strict: true }));
} catch (error) {
  console.error(`\n✗ RELEASE ABORTED — ${error.message}. Usage: pnpm release [--dry-run]`);
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

// `filter: null` == the root package (published from CWD).
const PACKAGES = [
  { name: "@gusto/baerly-storage", filter: null },
  { name: "@gusto/create-baerly-storage", filter: "@gusto/create-baerly-storage" },
];

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const runWithEnv = (cmd, env) =>
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });

const problems = [];

// Fail fast on stale generated artifacts (spec / version matrix) before
// even building — no point packaging a checked-in artifact that no longer
// matches the code it was generated from.
console.log("\n▶ Checking generated artifacts are fresh…");
try {
  run("pnpm run verify:artifacts");
} catch {
  console.error(
    "\n✗ RELEASE ABORTED — a checked-in generated artifact is stale " +
      "(spec-drift or version-matrix). Run `pnpm gen:spec` / " +
      "`pnpm gen:version-matrix`, commit, and re-run. Nothing published.",
  );
  process.exit(1);
}

// Build once and run the packaging-contract gate (attw + publint on the
// packed tarball) before any bytes hit npm. verify:package builds via
// build-if-needed (BAERLY_SKIP_BUILD is unset here, so it builds).
console.log("\n▶ Building & validating published packages…");
try {
  run("pnpm run verify:package");
} catch {
  console.error(
    "\n✗ RELEASE ABORTED — build or pre-publish validation failed; nothing published. " +
      "Fix the findings above and re-run.",
  );
  process.exit(1);
}

for (const pkg of PACKAGES) {
  const where = pkg.filter ? `--filter ${pkg.filter} ` : "";
  const cmd = `pnpm ${where}publish --access public --no-git-checks${dryRun ? " --dry-run" : ""}`;
  console.log(`\n▶ ${dryRun ? "Dry-run publish" : "Publishing"} ${pkg.name}…`);
  try {
    // Pass BAERLY_SKIP_BUILD so the `prepare` hook — which pnpm publish
    // triggers, and which honors this flag as of the build-dedup change —
    // reuses the dist/ that verify:package just produced instead of rebuilding.
    runWithEnv(cmd, { BAERLY_SKIP_BUILD: "1" });
  } catch {
    console.warn(`  ⚠ publish exited non-zero for ${pkg.name}`);
    problems.push(`${pkg.name}: publish step failed — see output above`);
  }
}

if (dryRun) {
  if (problems.length > 0) {
    console.error("\n✗ RELEASE DRY-RUN FAILED — issues:");
    for (const p of problems) {
      console.error(`   - ${p}`);
    }
    console.error("");
    process.exit(1);
  }
  console.log("\n✓ Dry run passed. Nothing published.\n");
  process.exit(0);
}

if (problems.length > 0) {
  console.error("\n✗ RELEASE INCOMPLETE — issues:");
  for (const p of problems) {
    console.error(`   - ${p}`);
  }
  console.error("");
  process.exit(1);
}

console.log("\n✓ Both packages published.\n");
