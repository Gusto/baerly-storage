#!/usr/bin/env node
// Build, pack and publish the two public @gusto packages to npmjs.com.
//
// `.github/workflows/release.yml` runs this in two jobs. The `pack` job
// (no OIDC token) installs, gates and packs both packages into tarballs.
// The `publish` job (OIDC token, `npm-publish` environment) runs no install
// and no lifecycle scripts: it publishes those exact tarballs with npm
// trusted publishing, which exchanges the OIDC token for a short-lived
// publish credential.
//
// `--provenance` is passed explicitly. Without it pnpm treats provenance
// as best-effort and publishes unattested when signing fails; with it the
// publish fails instead. One unattested release would make every later
// release fail our scaffolds' `trustPolicy: no-downgrade`.
//
// `--access public` is passed explicitly too, although `publishConfig.access`
// is set, because pnpm has historically dropped it on the wire.
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

import { execSync } from "node:child_process";
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

  const problems = [];
  for (const pkg of PACKAGES) {
    const file = join(dir, pkg.tarball(version));
    console.log(`\n▶ Publishing ${pkg.name}@${version}…`);
    try {
      // Run from the tarball directory, outside the workspace, so pnpm
      // reads only the packed manifest.
      run(`pnpm publish ${JSON.stringify(file)} --provenance --access public --no-git-checks`, {
        cwd: dir,
      });
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
