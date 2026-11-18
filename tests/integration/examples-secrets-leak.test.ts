import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /import\.meta\.env\.VITE_[A-Z_]*SECRET/,
  /\bVITE_[A-Z_]*SECRET\b/,
];

const SEARCH_ROOTS: readonly string[] = [
  "examples/minimal-cloudflare/src",
  "examples/minimal-node/src",
  "examples/react-cloudflare/src",
  "examples/react-node/src",
];

const walk = (dir: string): readonly string[] =>
  globSync("**/*.{ts,tsx}", { cwd: dir }).map((rel) => join(dir, rel));

describe("examples never leak SHARED_SECRET into the SPA bundle", () => {
  test("no VITE_*_SECRET references in example source files", () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      const files = walk(root);
      // A renamed source directory would otherwise pass vacuously.
      expect(files.length, `${root} has no source files`).toBeGreaterThan(0);
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const pat of FORBIDDEN_PATTERNS) {
          if (pat.test(text)) {
            offenders.push(`${file} matches ${pat.source}`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
