#!/usr/bin/env node
// Publish the two public @gusto packages to npmjs.com.
//
// Both packages are open-source and publish with `--access public`.
// `publishConfig.access: "public"` is set in each package.json, but
// pnpm has historically dropped that flag on the wire, so this script
// passes `--access public` explicitly to be safe.
//
// Usage:
//   pnpm release                  publish both packages
//   pnpm release --dry-run        pack + report current visibility, no writes
//   pnpm release --otp=123456     forward a 2FA one-time code

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const REGISTRY = "https://registry.npmjs.org/";

// `filter: null` == the root package (published from CWD).
const PACKAGES = [
  { name: "@gusto/baerly-storage", filter: null },
  { name: "@gusto/create-baerly-storage", filter: "@gusto/create-baerly-storage" },
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const otpArg = args.find((a) => a.startsWith("--otp="));
const otpFlag = otpArg ? ` --otp=${otpArg.split("=")[1]}` : "";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const runWithEnv = (cmd, env) =>
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });

// `npm access get status <pkg>` prints e.g. "@gusto/x: public".
function statusOf(name) {
  try {
    const out = execSync(`npm access get status ${name} --registry=${REGISTRY}`, {
      encoding: "utf8",
    });
    const o = out.toLowerCase();
    if (o.includes("public")) {
      return "public";
    }
    if (o.includes("private")) {
      return "private";
    }
    return `unknown(${out.trim()})`;
  } catch (error) {
    const msg = String(error.stderr || error.message || "")
      .trim()
      .split("\n")[0];
    return `error(${msg})`;
  }
}

const problems = [];

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
  const cmd =
    `pnpm ${where}publish --access public --no-git-checks` +
    `${dryRun ? " --dry-run" : ""}${otpFlag}`;
  console.log(`\n▶ ${dryRun ? "Dry-run publish" : "Publishing"} ${pkg.name}…`);
  try {
    // Pass BAERLY_SKIP_BUILD so a future prepack/prepublishOnly hook doesn't
    // rebuild the dist/ that verify:package just produced. Today, pnpm publish
    // triggers the `prepare` hook which still rebuilds unconditionally (that
    // deduplication is deferred).
    runWithEnv(cmd, { BAERLY_SKIP_BUILD: "1" });
  } catch {
    console.warn(`  ⚠ publish exited non-zero for ${pkg.name}`);
    problems.push(`${pkg.name}: publish step failed — see output above`);
  }
}

if (dryRun) {
  console.log("\n▶ Dry-run — current registry visibility (no changes made):");
  for (const pkg of PACKAGES) {
    console.log(`   ${pkg.name}: ${statusOf(pkg.name)}`);
  }
  console.log("");
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
