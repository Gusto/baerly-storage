#!/usr/bin/env node
// Build, pack and publish the two public @gusto packages to npmjs.com.
//
// `.github/workflows/release.yml` runs this in two jobs. The `pack` job
// (no OIDC token) installs, gates and packs both packages into tarballs
// with pnpm. The `publish` job (OIDC token, `npm-publish` environment)
// installs nothing and runs no lifecycle scripts: it publishes those exact
// tarballs with the npm CLI bundled with Node, whose trusted publishing
// exchanges the OIDC token for a short-lived publish credential.
//
// `--provenance` is passed explicitly. Under trusted publishing, provenance
// left at its default is best-effort and a signing failure publishes
// unattested; explicit, a signing failure fails the publish. One unattested
// release would make every later release fail our scaffolds'
// `trustPolicy: no-downgrade`.
//
// Usage (exactly one mode):
//   pnpm release --dry-run               gates, then a publish dry run of both packages
//   pnpm release --pack=<dir>            gates, then pack both packages into <dir>
//   node scripts/publish.mjs --publish=<dir>
//                                        publish the two tarballs in <dir>; refuses
//                                        outside a GitHub Actions tag run
//
// Flags parse strictly: an unknown or mistyped flag (`--dryrun`,
// `--dry-run=true`) aborts instead of doing anything.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE =
  "Usage: pnpm release --dry-run | pnpm release --pack=<dir> | " +
  "node scripts/publish.mjs --publish=<dir>";

const abort = (message) => {
  console.error(`\n✗ RELEASE ABORTED — ${message}`);
  process.exit(1);
};

let values;
try {
  ({ values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      pack: { type: "string" },
      publish: { type: "string" },
    },
    strict: true,
  }));
} catch (error) {
  abort(`${error.message}. ${USAGE}`);
}
const modes = [values["dry-run"] && "dry-run", values.pack && "pack", values.publish && "publish"];
const chosen = modes.filter(Boolean);
if (chosen.length !== 1) {
  abort(`choose exactly one mode. ${USAGE}`);
}
const mode = chosen[0];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CWD = process.cwd();
process.chdir(ROOT);

// `filter: null` == the root package (published from CWD). `tarball` is the
// file name `pnpm pack` writes for a version.
const PACKAGES = [
  {
    name: "@gusto/baerly-storage",
    filter: null,
    tarball: (v) => `gusto-baerly-storage-${v}.tgz`,
  },
  {
    name: "@gusto/create-baerly-storage",
    filter: "@gusto/create-baerly-storage",
    tarball: (v) => `gusto-create-baerly-storage-${v}.tgz`,
  },
];

const REGISTRY = "https://registry.npmjs.org/";

// npm applies a packed manifest's `publishConfig` to the publish, so a
// tarball could redirect its own publish (`registry`) or retag it (`tag`).
// Only the keys our manifests set are allowed.
const ALLOWED_PUBLISH_CONFIG = new Set(["access", "exports"]);

const run = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", ...opts });
// Pass BAERLY_SKIP_BUILD so the `prepare` hook, which pnpm publish/pack
// triggers, reuses the dist/ that verify:package just produced.
const runSkipBuild = (cmd) => run(cmd, { env: { ...process.env, BAERLY_SKIP_BUILD: "1" } });

const reportProblems = (problems, heading) => {
  console.error(`\n✗ ${heading} — issues:`);
  for (const p of problems) {
    console.error(`   - ${p}`);
  }
  console.error("");
  process.exit(1);
};

if (mode === "publish") {
  publishTarballs(resolve(CWD, values.publish));
} else {
  runGates();
  if (mode === "dry-run") {
    dryRun();
  } else {
    pack(resolve(CWD, values.pack));
  }
}

function runGates() {
  // Fail fast on stale generated artifacts (spec / version matrix) before
  // even building — no point packaging a checked-in artifact that no longer
  // matches the code it was generated from.
  console.log("\n▶ Checking generated artifacts are fresh…");
  try {
    run("pnpm run verify:artifacts");
  } catch {
    abort(
      "a checked-in generated artifact is stale (spec-drift or version-matrix). " +
        "Run `pnpm gen:spec` / `pnpm gen:version-matrix`, commit, and re-run. Nothing published.",
    );
  }

  // Build once and run the packaging-contract gate (attw + publint on the
  // packed tarball). verify:package builds via build-if-needed
  // (BAERLY_SKIP_BUILD is unset here, so it builds).
  console.log("\n▶ Building & validating published packages…");
  try {
    run("pnpm run verify:package");
  } catch {
    abort("build or pre-publish validation failed; nothing published. Fix the findings above.");
  }
}

function dryRun() {
  const problems = [];
  for (const pkg of PACKAGES) {
    const where = pkg.filter ? `--filter ${pkg.filter} ` : "";
    console.log(`\n▶ Dry-run publish ${pkg.name}…`);
    try {
      runSkipBuild(`pnpm ${where}publish --access public --no-git-checks --dry-run`);
    } catch {
      console.warn(`  ⚠ publish exited non-zero for ${pkg.name}`);
      problems.push(`${pkg.name}: publish step failed — see output above`);
    }
  }
  if (problems.length > 0) {
    reportProblems(problems, "RELEASE DRY-RUN FAILED");
  }
  console.log("\n✓ Dry run passed. Nothing published.\n");
}

function pack(dest) {
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  mkdirSync(dest, { recursive: true });
  for (const pkg of PACKAGES) {
    const where = pkg.filter ? `--filter ${pkg.filter} ` : "";
    console.log(`\n▶ Packing ${pkg.name}…`);
    try {
      runSkipBuild(`pnpm ${where}pack --pack-destination ${JSON.stringify(dest)}`);
    } catch {
      abort(`pack failed for ${pkg.name}; see output above.`);
    }
    if (!existsSync(join(dest, pkg.tarball(version)))) {
      abort(`pack did not write ${pkg.tarball(version)} to ${dest}.`);
    }
  }
  console.log(`\n✓ Packed both packages into ${dest}.\n`);
}

function publishTarballs(dir) {
  // A laptop with an npm token must not be able to publish: only the
  // release workflow's tag run may, so every release carries provenance.
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF_TYPE !== "tag") {
    abort(
      "--publish runs only in the release workflow on a tag push " +
        "(GITHUB_ACTIONS=true, GITHUB_REF_TYPE=tag). Nothing published.",
    );
  }
  const tag = process.env.GITHUB_REF_NAME ?? "";
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    abort(`tag ${JSON.stringify(tag)} is not v<major>.<minor>.<patch>. Nothing published.`);
  }
  const version = tag.slice(1);
  const expected = PACKAGES.map((pkg) => pkg.tarball(version)).toSorted();
  const found = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".tgz"))
        .toSorted()
    : [];
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    abort(
      `${dir} must hold exactly ${expected.join(", ")}; found ${found.join(", ") || "none"}. ` +
        "Nothing published.",
    );
  }

  for (const pkg of PACKAGES) {
    checkPackedManifest(join(dir, pkg.tarball(version)), pkg.name, version);
  }

  const problems = [];
  for (const pkg of PACKAGES) {
    const file = join(dir, pkg.tarball(version));
    console.log(`\n▶ Publishing ${pkg.name}@${version}…`);
    try {
      // npm runs from the tarball directory: inside the checkout it refuses
      // every command, because `devEngines.packageManager` names pnpm.
      // A tarball spec runs no lifecycle scripts; `--ignore-scripts` says so.
      run(
        `npm publish ${JSON.stringify(file)} --provenance --access public --ignore-scripts ` +
          `--registry ${REGISTRY}`,
        { cwd: dir },
      );
    } catch {
      console.warn(`  ⚠ publish exited non-zero for ${pkg.name}`);
      problems.push(`${pkg.name}: publish step failed — see output above`);
    }
  }
  if (problems.length > 0) {
    reportProblems(problems, "RELEASE INCOMPLETE");
  }
  console.log("\n✓ Both packages published.\n");
}

function checkPackedManifest(file, name, version) {
  let manifest;
  try {
    manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }),
    );
  } catch (error) {
    abort(`could not read package/package.json from ${file}: ${error.message}. Nothing published.`);
  }
  if (manifest.name !== name || manifest.version !== version) {
    abort(
      `${file} packs ${manifest.name}@${manifest.version}, expected ${name}@${version}. ` +
        "Nothing published.",
    );
  }
  const config = manifest.publishConfig ?? {};
  const extra = Object.keys(config).filter((k) => !ALLOWED_PUBLISH_CONFIG.has(k));
  if (extra.length > 0 || (config.access !== undefined && config.access !== "public")) {
    abort(
      `${file} sets publishConfig ${JSON.stringify(config)}; only access: "public" and ` +
        "exports are allowed. Nothing published.",
    );
  }
}
