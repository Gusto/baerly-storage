// scripts/check-exports.mjs — validates the published package's export map
// and type resolution with @arethetypeswrong/cli.
//
// Packs with `pnpm pack` (NOT `attw --pack .`, which shells out to
// `npm pack` and therefore does NOT apply pnpm's `publishConfig.exports`
// overrides — so the manifest would still point `exports` at the
// `packages/*/src/*.ts` dev paths that `files: ["dist"]` excludes, and
// every entry point would fail to resolve). `pnpm pack` applies
// publishConfig, so the tarball's `exports` correctly point at `dist/`.
//
// `--profile esm-only` ignores the expected node10 / CJS-require cases:
// this is a deliberately ESM-only package (no CJS build), so a CJS
// `require()` resolving to ESM is correct, not a defect.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(cmd, args, extraOpts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...extraOpts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

run("pnpm", ["run", "build"]);

const outDir = mkdtempSync(join(tmpdir(), "baerly-attw-"));
run("pnpm", ["pack", "--pack-destination", outDir]);

const tarball = readdirSync(outDir).find((f) => f.endsWith(".tgz"));
if (!tarball) {
  console.error(`check-exports: no tarball produced in ${outDir}`);
  process.exit(1);
}

run("pnpm", ["exec", "attw", join(outDir, tarball), "--profile", "esm-only"]);
