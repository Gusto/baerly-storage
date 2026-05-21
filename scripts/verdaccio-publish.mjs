#!/usr/bin/env node
// Publish every workspace package to local Verdaccio under a unique
// dev version (`0.1.<unix-ts>`) so each iteration gets a fresh
// resolution and no integrity-cache or lockfile entry from a prior
// publish can collide.
//
// Why `0.1.<int>` and not `0.1.0-dev.<ts>`: scaffold templates pin
// `baerly-storage: ^0.1.0`, and semver `^0.1.0` does not match
// prereleases. Plain integer patches satisfy the caret range
// cleanly, so `pnpm install` resolves to whatever the latest
// `0.1.<n>` on Verdaccio happens to be.
//
// Versions are restored to whatever was in `git HEAD` after publish
// (success or failure), so the working tree stays clean.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const VERSION = `0.1.${Math.floor(Date.now() / 1000)}`;

const candidates = ["package.json"];
for (const dir of ["packages", "examples"]) {
  if (!existsSync(dir)) {continue;}
  for (const sub of readdirSync(dir)) {
    const p = join(dir, sub, "package.json");
    if (existsSync(p)) {candidates.push(p);}
  }
}

// Preserve the original `version` field per file so we can put it
// back without touching anything else in package.json (e.g. an
// unstaged edit to `scripts` further up the file).
const touched = [];
for (const p of candidates) {
  const pkg = JSON.parse(readFileSync(p, "utf8"));
  if (pkg.private || typeof pkg.version !== "string") {continue;}
  touched.push({ path: p, originalVersion: pkg.version });
  pkg.version = VERSION;
  writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
}

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const restore = () => {
  for (const { path, originalVersion } of touched) {
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      pkg.version = originalVersion;
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    } catch {
      console.error(`[verdaccio-publish] failed to restore version in ${path}`);
    }
  }
};

process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

let ok = false;
try {
  run("pnpm verdaccio:reset");
  run("pnpm run build");
  run("pnpm -r publish --registry http://localhost:4873 --no-git-checks --force --ignore-scripts");
  ok = true;
} finally {
  restore();
}

run(
  'find "$HOME/.cache/pnpm" "$HOME/Library/Caches/pnpm" \\( -name dlx -o -name "localhost+4873" \\) -prune -exec rm -rf {} + 2>/dev/null || true',
);

if (ok) {console.log(`\nPublished as ${VERSION}`);}
