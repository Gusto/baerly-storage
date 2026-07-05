// scripts/check-publint.mjs — validates the published packages' manifests
// (exports/files/bin field shapes, publish metadata) with publint.
//
// Sibling to check-exports.mjs: attw checks that types *resolve* for
// consumers; publint checks that the published `package.json` is *correct*
// (well-formed `exports`, `files` covering the referenced paths, no
// dev-only fields leaking, etc.). The two are the canonical publishing
// pair, so they share the same pack-first approach.
//
// `--pack pnpm` makes publint pack with pnpm (not npm), so pnpm's
// `publishConfig.exports` overrides are applied and the linted tarball's
// `exports` point at `dist/` rather than the excluded `src/*.ts` dev
// paths — the same reason check-exports.mjs uses `pnpm pack`.
//
// Manual gate, not wired into verify. Covers both published packages
// (attw covers only the root library; publint's bin/files checks are
// just as relevant to the create-baerly-storage CLI).
import { spawnSync } from "node:child_process";

function run(cmd, args, extraOpts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...extraOpts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

// publint reads `files: ["dist"]`, so dist/ must exist and be current.
run("pnpm", ["run", "build"]);

// [directory, human label] for each published package.
const PACKAGES = [
  [".", "@gusto/baerly-storage"],
  ["packages/create-baerly-storage", "@gusto/create-baerly-storage"],
];

for (const [dir, label] of PACKAGES) {
  console.log(`\ncheck-publint: linting ${label}`);
  run("pnpm", ["exec", "publint", dir, "--pack", "pnpm"]);
}
