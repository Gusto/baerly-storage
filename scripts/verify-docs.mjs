#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { parse as parseYaml } from "yaml";

// VERIFY_DOCS_ROOT lets unit tests point at a temp dir;
// default to the repo root resolved from this script's location.
const ROOT = process.env.VERIFY_DOCS_ROOT ?? resolve(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs");
const VALID_AUDIENCE = new Set([
  "meta",
  "agent",
  "product",
  "operator",
  "integrator",
  "coder",
  "maintainer",
  "adr",
  "spec",
]);
const STALE_AFTER_DAYS = 180;

const findings = [];

// Skip these directory NAMES anywhere they appear in the walk.
// `superpowers` is the working-tree-only scratch space used by the
// superpowers harness; it's gitignored, so it never appears in CI but
// does locally, and its plan/spec files don't carry doc frontmatter.
const SKIP_DIR_NAMES = new Set(["node_modules", "superpowers"]);

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || SKIP_DIR_NAMES.has(name)) {
      continue;
    }
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      walk(path);
    }
    // Skip Excalidraw-managed source files (*.excalidraw.md). Their
    // frontmatter is owned by the Excalidraw Obsidian plugin and
    // doesn't carry an `audience:` field.
    else if (name.endsWith(".md") && !name.endsWith(".excalidraw.md")) {
      checkFile(path);
    }
  }
}

function extractFrontmatter(content) {
  if (!content.startsWith("---\n")) {
    return null;
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return null;
  }
  try {
    return parseYaml(content.slice(4, end));
  } catch (error) {
    return { parseError: error.message };
  }
}

function checkFile(path) {
  const rel = relative(ROOT, path);
  const content = readFileSync(path, "utf8");
  const fm = extractFrontmatter(content);

  if (fm === null) {
    findings.push(`${rel}: missing frontmatter`);
    return;
  }
  if (fm.parseError) {
    findings.push(`${rel}: YAML parse error — ${fm.parseError}`);
    return;
  }
  if (!fm.audience) {
    findings.push(`${rel}: missing 'audience'`);
  } else if (!VALID_AUDIENCE.has(fm.audience)) {
    findings.push(
      `${rel}: invalid audience '${fm.audience}' (allowed: ${[...VALID_AUDIENCE].join(", ")})`,
    );
  }
  if (Array.isArray(fm.related)) {
    for (const link of fm.related) {
      if (typeof link !== "string" || link.startsWith("http")) {
        continue;
      }
      const target = resolve(dirname(path), link);
      if (!existsSync(target)) {
        findings.push(`${rel}: broken related link → ${link}`);
      }
    }
  }
  if (fm["last-reviewed"]) {
    const reviewed =
      fm["last-reviewed"] instanceof Date
        ? fm["last-reviewed"]
        : new Date(String(fm["last-reviewed"]));
    if (Number.isNaN(reviewed.getTime())) {
      findings.push(`${rel}: unparseable last-reviewed`);
    } else {
      const days = Math.floor((Date.now() - reviewed.getTime()) / 86400000);
      if (days > STALE_AFTER_DAYS) {
        findings.push(`${rel}: last-reviewed ${days}d ago (>${STALE_AFTER_DAYS})`);
      }
    }
  }
}

walk(DOCS);

if (findings.length > 0) {
  for (const f of findings) {
    console.error(f);
  }
  console.error(`\n${findings.length} finding(s).`);
  process.exit(1);
}
console.log(
  `docs OK — checked all .md files under docs/ (cross-link + audience + ${STALE_AFTER_DAYS}d staleness)`,
);
