#!/usr/bin/env node
// Anti-silent-gap guard for the format/validate ownership model.
//
// Every git-tracked file must be OWNED by exactly one mechanism:
//   - oxfmt formats it          (code/markup: see OXFMT_EXT)
//   - it is validated markdown  (verify:docs + remark + verify-mermaid)
//   - it is intentionally unformatted data/config/binary (the allowlists)
//
// `format:check` already proves the oxfmt-owned set is *formatted*; this guard
// proves there is no FOURTH bucket — a new file type that no formatter formats
// and no validator validates, silently slipping through green. When a genuinely
// new extension lands (`.py`, `.toml`, `.vue`, …) this fails and forces a
// deliberate choice: format it, validate it, or add it to an allowlist here.
//
// Keep the allowlists in sync with .oxfmtrc.json `ignorePatterns` (the
// attachments dir is excluded there as regenerated evidence) and .remarkignore.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

const ROOT = resolvePath(fileURLToPath(new URL(".", import.meta.url)), "..");

// Hand-authored source/markup that oxfmt formats. Enforced for real by
// `format:check`; listed here only so the file is accounted for.
const OXFMT_EXT = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "mjs",
  "cjs",
  "js",
  "json",
  "jsonc",
  "html",
  "css",
]);

// Prose: never reformatted, validated instead (links/anchors via remark,
// mermaid via verify-mermaid, docs/ frontmatter via verify-docs).
const MARKDOWN_EXT = new Set(["md", "mdx"]);

// Data / config / binary: no formatter owns these by design.
const UNFORMATTED_EXT = new Set([
  "yaml",
  "yml",
  "sh",
  "png",
  "svg",
  "ico",
  "txt",
  "example",
  "toml",
]);

// Exact basenames that are extension-less or dotfiles (no meaningful ext).
const ALLOWED_BASENAMES = new Set([
  "LICENSE",
  "NOTICE",
  "Dockerfile",
  "_gitignore", // scaffold-template rename sentinel
  ".gitignore",
  ".gitattributes",
  ".gitkeep",
  ".dockerignore",
  ".remarkignore",
  ".npmrc",
  ".nvmrc",
]);

// Path prefixes whose contents are intentionally unowned data.
const ALLOWED_PREFIXES = [
  "docs/spec/attachments/", // regenerated bench evidence (also ignored by oxfmt)
  "manual-e2e/fixtures/", // adversarial S3-key fixtures (deliberately weird names)
];

/** @returns {"oxfmt"|"markdown"|"data"|null} bucket, or null if unowned. */
export function classify(file) {
  if (ALLOWED_PREFIXES.some((p) => file.startsWith(p))) {
    return "data";
  }
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (ALLOWED_BASENAMES.has(base)) {
    return "data";
  }
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (MARKDOWN_EXT.has(ext)) {
    return "markdown";
  }
  if (OXFMT_EXT.has(ext)) {
    return "oxfmt";
  }
  if (UNFORMATTED_EXT.has(ext)) {
    return "data";
  }
  return null;
}

export function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function main() {
  const files = trackedFiles();
  const unowned = files.filter((f) => classify(f) === null);
  if (unowned.length === 0) {
    console.log(`lint-format-coverage: all ${files.length} tracked files are owned`);
    return 0;
  }
  for (const f of unowned) {
    console.error(`${f}: unowned file type — no formatter or validator covers it`);
  }
  console.error(
    [
      "",
      `lint-format-coverage: ${unowned.length} unowned file(s)`,
      "  To fix: pick one and wire it up —",
      "    • code/markup oxfmt handles → add its ext to OXFMT_EXT here",
      "    • prose → name it *.md/*.mdx (validated by verify:docs)",
      "    • data/config/binary → add its ext to UNFORMATTED_EXT, or the",
      "      path/basename to an allowlist in scripts/lint-format-coverage.mjs",
    ].join("\n"),
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main());
}
