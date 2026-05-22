import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /import\.meta\.env\.VITE_[A-Z_]*SECRET/,
  /\bVITE_[A-Z_]*SECRET\b/,
];

const SEARCH_ROOTS: readonly string[] = [
  "examples/minimal-cloudflare/src",
  "examples/helpdesk-cloudflare/src",
  "examples/minimal-node/src",
  "examples/react-cloudflare/src",
  "examples/react-node/src",
];

const isClientFile = (path: string): boolean =>
  path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".d.ts");

function walk(dir: string, out: string[] = []): readonly string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, out);
    } else if (s.isFile() && isClientFile(full)) {
      out.push(full);
    }
  }
  return out;
}

describe("examples never leak SHARED_SECRET into the SPA bundle", () => {
  test("no VITE_*_SECRET references in example source files", () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      for (const file of walk(root)) {
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
