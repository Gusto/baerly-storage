import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { collectClosure, STATIC_IMPORT_RE } from "../../scripts/bundle-measure.ts";

// `collectClosure` is the front of every measured number: an entry's raw / gz
// / min-gz are sums over whatever it walks. A specifier it fails to see does
// not error — it silently shrinks the closure, so a regression living in the
// dropped subtree passes the delta gate. These tests pin the parser directly,
// against fixture chunks rather than `dist/`, so they hold no matter what
// shape the bundler happens to emit today.

/** Write `files` into a fresh temp dir; returns the absolute entry path. */
function chunkFixture(files: Record<string, string>, entry: string): string {
  const dir = mkdtempSync(join(tmpdir(), "baerly-closure-"));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source);
  }
  return resolve(dir, entry);
}

/** Every specifier `STATIC_IMPORT_RE` yields for `source`. */
function specifiers(source: string): string[] {
  return [...source.matchAll(STATIC_IMPORT_RE)].map((m) => m[1]!);
}

describe("static-import parsing", () => {
  test("reads both specifiers when two statements share a line", () => {
    expect(specifiers(`import a from "./x.js"; export * from "./y.js";\n`)).toEqual([
      "./x.js",
      "./y.js",
    ]);
  });

  test("reads a specifier per line in the usual one-per-line shape", () => {
    expect(specifiers(`import a from "./x.js";\nexport * from "./y.js";\n`)).toEqual([
      "./x.js",
      "./y.js",
    ]);
  });

  // The statement-position anchor is load-bearing, not incidental: `dist/`
  // ships comments un-stripped, and JSDoc `@example` blocks quote imports.
  // Widening the match to any `import ... from` would pull those in.
  test("ignores an import quoted inside a comment", () => {
    const source = `/**\n * Usage: \`import { Db } from "./db.js"\`\n */\nexport const b = 1;\n`;
    expect(specifiers(source)).toEqual([]);
  });
});

describe("collectClosure", () => {
  test("descends into both subtrees of a shared line", () => {
    const entry = chunkFixture(
      {
        "entry.js": `import a from "./x.js"; export * from "./y.js";\n`,
        "x.js": `export const x = 1;\n`,
        "y.js": `export const y = 1;\n`,
      },
      "entry.js",
    );
    const seen = new Set<string>();
    collectClosure(entry, seen);
    expect([...seen].map((f) => f.split("/").pop())).toEqual(
      expect.arrayContaining(["entry.js", "x.js", "y.js"]),
    );
    expect(seen.size).toBe(3);
  });

  test("does not follow a bare specifier out of dist", () => {
    const entry = chunkFixture(
      { "entry.js": `import { transform } from "esbuild";\nexport const e = 1;\n` },
      "entry.js",
    );
    const seen = new Set<string>();
    collectClosure(entry, seen);
    expect(seen.size).toBe(1);
  });
});
