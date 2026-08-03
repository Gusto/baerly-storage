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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

// ---------------------------------------------------------------------
// Packed public-surface gate.
//
// attw proves the published entry points RESOLVE. This proves the packed
// surface contains what it should and NOTHING it shouldn't. A grep over
// hash-suffixed declaration chunks is not a valid gate: rolldown emits
// shared chunks, so a private symbol can exist in a chunk without being
// reachable from any published entry. The only sound test is to extract
// the real tarball and compile a consumer against it.
//
// Two fixture classes:
//   - POSITIVE: must compile clean. This is the non-vacuity guard — if the
//     harness stops actually running tsgo, the positive control fails.
//   - NEGATIVE: must fail, AND the diagnostic must be attributed to that
//     fixture's own file with one of its declared expected codes, so an
//     unrelated TypeScript error can never satisfy a negative test.
// ---------------------------------------------------------------------

const consumerRoot = mkdtempSync(join(tmpdir(), "baerly-consumer-"));
const packedRoot = join(consumerRoot, "node_modules", "@gusto", "baerly-storage");
mkdirSync(packedRoot, { recursive: true });

run("tar", ["-xzf", join(outDir, tarball), "-C", packedRoot, "--strip-components", "1"]);

// The packed declarations `import`/`reference` ambient type packages. `types: []`
// below disables AUTOMATIC @types inclusion for the fixture itself; these
// symlinks exist so resolution reached FROM the packed .d.ts still succeeds,
// keeping a diagnostic about OUR surface rather than a missing @types/node.
mkdirSync(join(consumerRoot, "node_modules", "@types"), { recursive: true });
mkdirSync(join(consumerRoot, "node_modules", "@cloudflare"), { recursive: true });
symlinkSync(
  realpathSync("node_modules/@types/node"),
  join(consumerRoot, "node_modules", "@types", "node"),
  "dir",
);
symlinkSync(
  realpathSync("node_modules/@cloudflare/workers-types"),
  join(consumerRoot, "node_modules", "@cloudflare", "workers-types"),
  "dir",
);

const packedManifest = JSON.parse(readFileSync(join(packedRoot, "package.json"), "utf8"));
const packedExports = packedManifest.exports ?? {};

// 1. No `_internal` subpath may be published.
const internalSubpaths = Object.keys(packedExports).filter((s) => s.startsWith("./_internal"));
if (internalSubpaths.length > 0) {
  console.error(
    `check-exports: packed exports must not contain an _internal subpath; found ${internalSubpaths.join(", ")}`,
  );
  process.exit(1);
}

// 2. Every packed export's `types` target must exist in the tarball.
const packedEntries = Object.entries(packedExports);
if (packedEntries.length === 0) {
  console.error("check-exports: packed exports map is empty (vacuous gate)");
  process.exit(1);
}
for (const [subpath, condition] of packedEntries) {
  const types = typeof condition === "object" && condition !== null ? condition.types : undefined;
  if (types === undefined) {
    console.error(`check-exports: packed export "${subpath}" declares no types condition`);
    process.exit(1);
  }
  if (!existsSync(join(packedRoot, types))) {
    console.error(`check-exports: packed export "${subpath}" types target ${types} is missing`);
    process.exit(1);
  }
}

// 3. Attributed consumer fixtures.
const CONSUMER_TSCONFIG = {
  compilerOptions: {
    target: "ES2025",
    lib: ["ES2025", "DOM", "DOM.Iterable"],
    module: "preserve",
    moduleResolution: "bundler",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  },
  files: ["fixture.ts"],
};

/**
 * `expect: "compiles"` — the non-vacuity positive control.
 * `expect: "fails"` — must fail with one of `codes`, reported against
 * `fixture.ts` itself.
 */
const CONSUMER_FIXTURES = [
  {
    name: "positive-public-maintenance-surface",
    expect: "compiles",
    source: `
import type { CompactOptions, MaintenanceOptions } from "@gusto/baerly-storage/maintenance";
import { runScheduledMaintenance } from "@gusto/baerly-storage/maintenance";

const compactOptions: CompactOptions = { minEntriesToCompact: 100 };
const options: MaintenanceOptions = { compact: compactOptions };
void options;
void runScheduledMaintenance;
`,
  },
  {
    name: "negative-internal-compact-options-from-root",
    expect: "fails",
    codes: ["TS2305", "TS2724"],
    source: `
import type { InternalCompactOptions } from "@gusto/baerly-storage";
export type Leaked = InternalCompactOptions;
`,
  },
  {
    name: "negative-internal-compact-options-from-maintenance",
    expect: "fails",
    codes: ["TS2305", "TS2724"],
    source: `
import type { InternalCompactOptions } from "@gusto/baerly-storage/maintenance";
export type Leaked = InternalCompactOptions;
`,
  },
  {
    name: "negative-internal-maintenance-options-from-maintenance",
    expect: "fails",
    codes: ["TS2305", "TS2724"],
    source: `
import type { InternalMaintenanceOptions } from "@gusto/baerly-storage/maintenance";
export type Leaked = InternalMaintenanceOptions;
`,
  },
  {
    name: "negative-internal-run-gc-options-from-maintenance",
    expect: "fails",
    codes: ["TS2305", "TS2724"],
    source: `
import type { InternalRunGcOptions } from "@gusto/baerly-storage/maintenance";
export type Leaked = InternalRunGcOptions;
`,
  },
  {
    // Weak by construction: the name exists nowhere in the repo, so this
    // fails trivially today. Retained as a forward guard against a future
    // `compactInternal()` split reaching the published surface.
    name: "negative-compact-internal-from-maintenance",
    expect: "fails",
    codes: ["TS2305", "TS2724"],
    source: `
import { compactInternal } from "@gusto/baerly-storage/maintenance";
export const leaked = compactInternal;
`,
  },
  {
    name: "negative-internal-testing-subpath",
    expect: "fails",
    codes: ["TS2307"],
    source: `
import type { InternalCompactOptions } from "@gusto/baerly-storage/_internal/testing";
export type Leaked = InternalCompactOptions;
`,
  },
  {
    name: "negative-internal-excess-property-on-maintenance-options",
    expect: "fails",
    codes: ["TS2353", "TS2322"],
    source: `
import type { MaintenanceOptions } from "@gusto/baerly-storage/maintenance";

const leaked: MaintenanceOptions = {
  compact: { maxEntriesPerRun: 40 },
};
void leaked;
`,
  },
];

let failures = 0;
for (const fixture of CONSUMER_FIXTURES) {
  const dir = join(consumerRoot, "fixtures", fixture.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture.ts"), fixture.source);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(CONSUMER_TSCONFIG, null, 2));

  const result = spawnSync(
    "pnpm",
    ["exec", "tsgo", "--noEmit", "--pretty", "false", "-p", join(dir, "tsconfig.json")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (fixture.expect === "compiles") {
    if (result.status !== 0) {
      failures += 1;
      console.error(
        `check-exports: positive control "${fixture.name}" must compile against the packed tarball but did not:\n${output}`,
      );
    }
    continue;
  }

  if (result.status === 0) {
    failures += 1;
    console.error(
      `check-exports: negative control "${fixture.name}" compiled — that name is reachable from the packed public surface`,
    );
    continue;
  }

  const attributed = output
    .split("\n")
    .filter((line) => line.includes("fixture.ts") && line.includes(fixture.name))
    .filter((line) => fixture.codes.some((code) => line.includes(`error ${code}:`)));

  if (attributed.length === 0) {
    failures += 1;
    console.error(
      `check-exports: negative control "${fixture.name}" failed, but not with ${fixture.codes.join("/")} on its own fixture.ts. An unrelated error cannot satisfy this test.\n${output}`,
    );
  }
}

if (failures > 0) {
  console.error(`check-exports: ${failures} packed-surface fixture(s) failed`);
  process.exit(1);
}

console.log(
  `check-exports: packed-surface gate passed (${CONSUMER_FIXTURES.length} attributed fixtures, ${packedEntries.length} published subpaths)`,
);
