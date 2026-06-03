import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The published package ships two hand-authored markdown artifacts in
// `dist/` so an agent reading `node_modules/@gusto/baerly-storage/dist/`
// gets the current API surface (API.md) and a migration-shaped record of
// what changed across versions (CHANGELOG.md) without a TS language server.
// rolldown's `copy-api-quickref` closeBundle step copies both verbatim.
const ROOT = resolve(__dirname, "../..");

const SHIPPED = [
  { dist: "dist/API.md", source: "packages/server/API.md" },
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
