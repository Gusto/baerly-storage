// Maintenance contract for this file:
//
// The four examples/*/AGENTS.md files duplicate "Going to production"
// Patterns A/B/C in paired blocks, plus host-agnostic blocks that are
// identical across ALL FOUR files (no per-template variation): the STOP
// preamble, the library-reference pointer list, and Pattern D
// ("## Maintenance"). The shared guidance itself lives in the installed
// API.md / RECIPES.md; these blocks only point at it. Each block is delimited by HTML
// comment sentinels:
//
//   <!-- pattern-a:start -->
//   ...
//   <!-- pattern-a:end -->
//
// Sentinels are invisible in rendered markdown but persistent in
// source — they survive heading renames and mark section boundaries
// explicitly. This test asserts each paired block is byte-identical
// after normalising the legitimate per-template variations (tenant
// name, app name, NoteSchema vs none, react() plugin row).
//
// HOW TO MAINTAIN:
//   - To rename a Pattern heading: change the heading freely, the
//     sentinels still bound the section. No test change needed.
//   - To add a new pattern: add new sentinel pair in every paired
//     AGENTS.md, then add a new test() block here.
//   - Pattern D ("## Maintenance") is host-agnostic — the same block
//     is wrapped in <!-- pattern-d:start/end --> in all four files and
//     asserted byte-identical across all four (no normalisation needed,
//     since it carries no tenant/app/schema/plugin variation).
//   - To add a new legitimate variation: add a new normalise* helper
//     and chain it into normalise().
//
import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

function read(name: string): string {
  return readFileSync(join(ROOT, "examples", name, "AGENTS.md"), "utf8");
}

function extractSentinel(haystack: string, tag: string): string {
  const pattern = new RegExp(`<!-- ${tag}:start -->\\s*\\n([\\s\\S]*?)\\n\\s*<!-- ${tag}:end -->`);
  const match = haystack.match(pattern);
  if (!match || match[1] === undefined) {
    throw new Error(`sentinel block ${tag} not found`);
  }
  return match[1];
}

function normaliseTenant(s: string): string {
  return s.replace(/minimal-demo|react-demo/g, "<TENANT>");
}
function normaliseAppName(s: string): string {
  return s.replace(/minimal-cloudflare|react-cloudflare|minimal-node|react-node/g, "<APP>");
}
function stripConfigBlock(s: string): string {
  // The baerly.config.ts code-block legitimately differs (NoteSchema vs none).
  // KNOWN FRAGILITY: This regex matches every fenced ts block whose first
  // line is `// baerly.config.ts`. If a future Pattern block adds a SECOND
  // such code block (e.g. a "before" + "after" pair), this regex will
  // collapse both into one <CONFIG-BLOCK> placeholder in BOTH files —
  // hiding any drift between the second blocks. If you add a second
  // baerly.config.ts code sample, either rename one (`// baerly.config.ts
  // (after)`) or rewrite this helper to enumerate the expected count.
  return s.replace(/```ts\n\/\/ baerly\.config\.ts[\s\S]*?```/g, "<CONFIG-BLOCK>");
}
function stripVitePluginRow(s: string): string {
  // react-* has both the `@vitejs/plugin-react` import and the
  // `react(),` row in plugins:[]; minimal-* has neither.
  return s
    .replace(/^import react from "@vitejs\/plugin-react";\n/gm, "")
    .replace(/^\s*react\(\),\n/gm, "");
}

function normalise(s: string): string {
  return stripVitePluginRow(stripConfigBlock(normaliseAppName(normaliseTenant(s))));
}

describe("AGENTS.md Pattern drift fence", () => {
  test("Cloudflare Pattern A is byte-identical across minimal/react after normalisation", () => {
    const a = extractSentinel(read("minimal-cloudflare"), "pattern-a");
    const b = extractSentinel(read("react-cloudflare"), "pattern-a");
    expect(normalise(a)).toBe(normalise(b));
  });

  test("Cloudflare Pattern B is byte-identical across minimal/react after normalisation", () => {
    const a = extractSentinel(read("minimal-cloudflare"), "pattern-b");
    const b = extractSentinel(read("react-cloudflare"), "pattern-b");
    expect(normalise(a)).toBe(normalise(b));
  });

  test("Node Pattern B is byte-identical across minimal/react after normalisation", () => {
    const a = extractSentinel(read("minimal-node"), "pattern-b");
    const b = extractSentinel(read("react-node"), "pattern-b");
    expect(normalise(a)).toBe(normalise(b));
  });

  test("Node Pattern C is byte-identical across minimal/react after normalisation", () => {
    const a = extractSentinel(read("minimal-node"), "pattern-c");
    const b = extractSentinel(read("react-node"), "pattern-c");
    expect(normalise(a)).toBe(normalise(b));
  });

  test("STOP preamble is byte-identical across all four files", () => {
    // The orientation preamble ("## STOP — read this before writing any
    // storage code") carries no per-template variation, so it must match
    // RAW across all four — no normalise().
    const cfMin = extractSentinel(read("minimal-cloudflare"), "stop");
    const cfReact = extractSentinel(read("react-cloudflare"), "stop");
    const nodeMin = extractSentinel(read("minimal-node"), "stop");
    const nodeReact = extractSentinel(read("react-node"), "stop");
    expect(cfReact).toBe(cfMin);
    expect(nodeMin).toBe(cfMin);
    expect(nodeReact).toBe(cfMin);
  });

  test("library-reference pointer list is byte-identical across all four files", () => {
    const cfMin = extractSentinel(read("minimal-cloudflare"), "library");
    const cfReact = extractSentinel(read("react-cloudflare"), "library");
    const nodeMin = extractSentinel(read("minimal-node"), "library");
    const nodeReact = extractSentinel(read("react-node"), "library");
    expect(cfReact).toBe(cfMin);
    expect(nodeMin).toBe(cfMin);
    expect(nodeReact).toBe(cfMin);
  });

  test("Pattern D (## Maintenance) is byte-identical across all four files", () => {
    // Pattern D is host-agnostic: no tenant / app / schema / vite-plugin
    // variation, so it must match RAW across all four — no normalise().
    const cfMin = extractSentinel(read("minimal-cloudflare"), "pattern-d");
    const cfReact = extractSentinel(read("react-cloudflare"), "pattern-d");
    const nodeMin = extractSentinel(read("minimal-node"), "pattern-d");
    const nodeReact = extractSentinel(read("react-node"), "pattern-d");
    expect(cfReact).toBe(cfMin);
    expect(nodeMin).toBe(cfMin);
    expect(nodeReact).toBe(cfMin);
  });
});

// The scaffolds point at the installed API.md / RECIPES.md instead of
// restating them. `node_modules/@gusto/baerly-storage/dist/{API,RECIPES}.md`
// are byte copies of `packages/server/{API,RECIPES}.md` (dist-docs.test.ts),
// so a pointer resolves iff the file and heading exist in the source.
const SHIPPED_SOURCE: Record<string, string> = {
  "API.md": "packages/server/API.md",
  "RECIPES.md": "packages/server/RECIPES.md",
  "CHANGELOG.md": "CHANGELOG.md",
};

// GitHub heading slug: lowercase, drop everything but letters, digits,
// `-`, `_` and spaces, then spaces become hyphens.
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\- _]/gu, "")
    .replace(/ /g, "-");
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
    }
    const heading = fenced ? undefined : /^#{1,6}\s+(.*?)\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      slugs.add(slug(heading));
    }
  }
  return slugs;
}

describe("AGENTS.md installed-doc pointers", () => {
  for (const name of ["minimal-cloudflare", "react-cloudflare", "minimal-node", "react-node"]) {
    test(`${name}: every dist/*.md pointer and #anchor resolves`, () => {
      const text = read(name);
      const files = [
        ...text.matchAll(/node_modules\/@gusto\/baerly-storage\/dist\/([A-Za-z]+\.md)/g),
      ].map((m) => m[1]!);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const source = SHIPPED_SOURCE[file];
        expect(source, `${file} is not a shipped doc`).toBeDefined();
        expect(existsSync(join(ROOT, source!)), `${source} missing`).toBe(true);
      }
      // Anchors are written `API.md#x` or `RECIPES.md#x`, bare or after dist/.
      const anchors = [...text.matchAll(/\b(API\.md|RECIPES\.md)#([a-z0-9_-]+)/g)];
      expect(anchors.length).toBeGreaterThan(0);
      for (const [, file, anchor] of anchors) {
        const slugs = headingSlugs(readFileSync(join(ROOT, SHIPPED_SOURCE[file!]!), "utf8"));
        expect(slugs.has(anchor!), `${file}#${anchor} has no matching heading`).toBe(true);
      }
    });
  }
});
