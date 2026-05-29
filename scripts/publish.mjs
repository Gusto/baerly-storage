#!/usr/bin/env node
// Safe publish for the two @gusto packages that live on PUBLIC npm
// (npmjs.com) but MUST stay PRIVATE (restricted access).
//
// Why this script exists instead of a bare `pnpm publish`:
//   1. `publishConfig.access: "restricted"` is silently NOT forwarded
//      to the registry by `pnpm publish`. With no access flag sent,
//      the npm registry applies the `@gusto` org default visibility —
//      which is PUBLIC — so a bare publish lands world-readable.
//   2. `--access` is only honoured on a package's FIRST publish. For
//      packages that already exist, the registry ignores it on
//      subsequent publishes, so the flag alone can't re-assert private.
//
// So this script does all three things, every time:
//   a. publishes with an explicit `--access restricted`,
//   b. forces `npm access set status=private` (needs only package
//      write access — NOT org admin — so it works for any publisher),
//   c. VERIFIES with `npm access get status` and exits non-zero,
//      loudly, if either package is not private.
//
// The org-default-private setting (web UI, org admin) is strictly
// safer because it removes the public window entirely; this script is
// the admin-free safeguard when you can't change that setting.
//
// Usage:
//   pnpm release                  publish both, force private, verify
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

// BAERLY_SAFE_PUBLISH=1 is the token scripts/guard-publish.mjs checks,
// so the prepublishOnly guard lets these (and only these) publishes
// through.
const env = { ...process.env, BAERLY_SAFE_PUBLISH: "1" };

const run = (cmd) => execSync(cmd, { stdio: "inherit", env });

// `npm access get status <pkg>` prints e.g. "@gusto/x: private".
function statusOf(name) {
  try {
    const out = execSync(`npm access get status ${name} --registry=${REGISTRY}`, {
      encoding: "utf8",
      env,
    });
    const o = out.toLowerCase();
    if (o.includes("public")) {return "public";}
    if (o.includes("private")) {return "private";}
    return `unknown(${out.trim()})`;
  } catch (error) {
    const msg = String(error.stderr || error.message || "")
      .trim()
      .split("\n")[0];
    return `error(${msg})`;
  }
}

const problems = [];

console.log("\n▶ Building…");
run("pnpm run build");

for (const pkg of PACKAGES) {
  const where = pkg.filter ? `--filter ${pkg.filter} ` : "";
  const cmd =
    `pnpm ${where}publish --access restricted --no-git-checks` +
    `${dryRun ? " --dry-run" : ""}${otpFlag}`;
  console.log(`\n▶ ${dryRun ? "Dry-run publish" : "Publishing"} ${pkg.name}…`);
  try {
    run(cmd);
  } catch {
    // A version-conflict ("cannot publish over existing version") is a
    // failed release, but not fatal to the privacy goal — keep going so
    // we still force + verify private below.
    console.warn(`  ⚠ publish exited non-zero for ${pkg.name} (continuing to privacy enforcement)`);
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

console.log("\n▶ Forcing private visibility…");
for (const pkg of PACKAGES) {
  try {
    run(`npm access set status=private ${pkg.name} --registry=${REGISTRY}${otpFlag}`);
  } catch {
    problems.push(`${pkg.name}: \`npm access set status=private\` failed`);
  }
}

console.log("\n▶ Verifying visibility…");
let allPrivate = true;
for (const pkg of PACKAGES) {
  const status = statusOf(pkg.name);
  const ok = status === "private";
  allPrivate = allPrivate && ok;
  console.log(`   ${ok ? "✓" : "✗"} ${pkg.name}: ${status}`);
  if (!ok) {problems.push(`${pkg.name}: visibility is ${status}, expected private`);}
}

if (!allPrivate || problems.length > 0) {
  console.error("\n✗ RELEASE NOT SAFE — issues:");
  for (const p of problems) {console.error(`   - ${p}`);}
  console.error(
    `\n  If a package is not private, fix it NOW:\n` +
      `    npm access set status=private <pkg> --registry=${REGISTRY}\n` +
      `  then re-check:\n` +
      `    npm access get status <pkg> --registry=${REGISTRY}\n`,
  );
  process.exit(1);
}

console.log("\n✓ Both packages published and verified PRIVATE.\n");
