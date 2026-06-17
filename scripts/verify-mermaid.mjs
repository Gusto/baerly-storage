#!/usr/bin/env node
/**
 * Parse every fenced ```mermaid block in the repo's tracked Markdown
 * with Mermaid's own engine and fail on any syntax error.
 *
 * Why this exists: GitHub renders Mermaid client-side with the real
 * `mermaid` library, so a malformed diagram renders as a red "Unable
 * to render rich display" box for every reader — but nothing in the
 * existing doc gate catches it. `remark-validate-links` (run by
 * `verify:docs`) only validates Markdown links and heading anchors;
 * fenced code blocks are opaque to it. This closes that gap. See
 * the bug that motivated it: a node label `compactor[... compact()]`
 * with unquoted parentheses — labels with `()[]{}:` etc. must be
 * wrapped in double quotes.
 *
 * The newer pure-grammar `@mermaid-js/parser` package does NOT
 * support flowcharts (they still use the legacy jison grammar), so
 * we drive the full `mermaid` package's `parse()` under a `happy-dom`
 * DOM shim (already a dev dependency) — the same code path, and the
 * same error messages, that GitHub produces. No browser, no
 * rendering, runs in milliseconds.
 *
 * Runs as part of `pnpm verify:docs`. Exit codes:
 *   0 — every mermaid block parses
 *   1 — one or more blocks failed to parse (printed with file + error)
 *
 * Scope: all git-tracked `*.md` / `*.mdx` files (respects
 * `.gitignore`, so node_modules / dist / the gitignored superpowers
 * scratch space are excluded for free).
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const ROOT = resolve(import.meta.dirname, "..");

// Mermaid's parser touches `document` during diagram-type detection,
// so install a minimal DOM before importing it.
const window = new Window();
globalThis.window = window;
globalThis.document = window.document;

const { default: mermaid } = await import("mermaid");
mermaid.initialize({ startOnLoad: false });

const MERMAID_BLOCK = /```mermaid\r?\n([\s\S]*?)```/g;

function trackedMarkdown() {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "*.md", "*.mdx"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return out.split("\0").filter(Boolean);
}

const findings = [];
let blockCount = 0;

for (const rel of trackedMarkdown()) {
  const content = readFileSync(resolve(ROOT, rel), "utf8");
  for (const match of content.matchAll(MERMAID_BLOCK)) {
    blockCount++;
    const src = match[1];
    // 1-based line number of the ```mermaid fence for a clickable ref.
    const fenceLine = content.slice(0, match.index).split("\n").length;
    try {
      await mermaid.parse(src);
    } catch (error) {
      findings.push(`${rel}:${fenceLine}: mermaid parse error`);
      for (const line of String(error.message).split("\n")) {
        findings.push(`  ${line}`);
      }
      findings.push(
        `  To fix: open the diagram and quote any node label containing reserved characters — e.g. \`x[foo()]\` → \`x["foo()"]\`. Mermaid flowchart labels with \`()[]{}:\` must be wrapped in double quotes; use \`&lt;\`/\`&gt;\` for angle brackets.`,
      );
    }
  }
}

if (findings.length > 0) {
  for (const f of findings) {
    console.error(f);
  }
  console.error(`\n${findings.length} line(s) of findings.`);
  process.exit(1);
}
console.log(`mermaid OK — parsed ${blockCount} block(s) in tracked Markdown`);
