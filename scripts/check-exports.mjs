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
//
// Run standalone as `pnpm check:exports`; also run as a pre-publish gate
// by scripts/publish.mjs. Not wired into verify. Set BAERLY_SKIP_BUILD=1
// to reuse an existing dist/ (publish.mjs builds once, then sets it).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(cmd, args, extraOpts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...extraOpts });
  if (result.status !== 0) {
    // A quiet call (stdout captured) has nothing on the console — replay
    // the captured stdout so a failure keeps its full detail.
    if (result.stdout) {
      process.stderr.write(result.stdout);
    }
    process.exit(result.status ?? 1);
  }
  return result;
}

if (!process.env.BAERLY_SKIP_BUILD) {
  run("pnpm", ["run", "build"]);
}

const outDir = mkdtempSync(join(tmpdir(), "baerly-attw-"));
// Capture pack's stdout rather than inheriting it: `pnpm pack` prints
// the full "Tarball Contents" file listing (~200 lines) on every run,
// which is pure noise on a green CI gate. We only need the .tgz path
// (read from outDir below); on failure `run` replays the captured
// output so nothing is lost.
run("pnpm", ["pack", "--pack-destination", outDir], {
  stdio: ["ignore", "pipe", "inherit"],
  encoding: "utf8",
});

const tarball = readdirSync(outDir).find((f) => f.endsWith(".tgz"));
if (!tarball) {
  console.error(`check-exports: no tarball produced in ${outDir}`);
  process.exit(1);
}

// `-f table` forces attw's compact grid (one row per subpath). Without it,
// a non-TTY run (CI) falls back to the `ascii` format, which prints a
// ~6-line block per entry point — ~90 lines that repeat the same ignored
// node10/node16-CJS resolutions across all 13 subpaths.
run("pnpm", ["exec", "attw", join(outDir, tarball), "--profile", "esm-only", "-f", "table"]);
