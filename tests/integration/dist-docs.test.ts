import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The published package ships hand-authored markdown artifacts in `dist/`
// so an agent reading `node_modules/@gusto/baerly-storage/dist/` gets the
// current API surface (API.md), common-mistakes reference (RECIPES.md), and
// a migration-shaped record of what changed across versions (CHANGELOG.md)
// without a TS language server. rolldown's `copy-api-quickref` closeBundle
// step copies all three verbatim.
const ROOT = resolve(__dirname, "../..");

const SHIPPED = [
  { dist: "dist/API.md", source: "packages/server/API.md" },
  { dist: "dist/RECIPES.md", source: "packages/server/RECIPES.md" },
  { dist: "dist/CHANGELOG.md", source: "CHANGELOG.md" },
];

describe("shipped doc artifacts", () => {
  for (const { dist, source } of SHIPPED) {
    test(`${dist} ships byte-identical to ${source}`, () => {
      const distAbs = resolve(ROOT, dist);
      if (!existsSync(distAbs)) {
        throw new Error(`${dist} missing — run \`pnpm build\` before \`pnpm test\``);
      }
      expect(readFileSync(distAbs, "utf8")).toBe(readFileSync(resolve(ROOT, source), "utf8"));
    });
  }
});

// API.md is the zero-shot public-API quickref an agent reads from
// `node_modules/@gusto/baerly-storage/dist/API.md`. It sits at the
// ~12k-token soft ceiling (CLAUDE.md): net-new prose must land in
// RECIPES.md, not here. This guard fails the build if API.md creeps
// past the ceiling so the budget can't erode silently.
// Baseline 2026-07-15: bumped 46_000 → 46_080 (45 KiB) to seat the
// native-GCS Tier-1 promotion (GCS named alongside S3/R2 across the
// public surface). Rebaselined, not golfed — GCS parity prose is
// load-bearing.
const API_MD_MAX_BYTES = 46_080;

describe("API.md token budget", () => {
  test(`packages/server/API.md stays under ${API_MD_MAX_BYTES} bytes`, () => {
    const bytes = Buffer.byteLength(
      readFileSync(resolve(ROOT, "packages/server/API.md"), "utf8"),
      "utf8",
    );
    expect(bytes).toBeLessThanOrEqual(API_MD_MAX_BYTES);
  });
});
