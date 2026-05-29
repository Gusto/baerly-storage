#!/usr/bin/env node
// Enforce package layer direction. Bare-specifier imports between @baerly/* packages
// must follow the rule table below. Violations exit non-zero with a remediation hint.
// See docs/adr/006-package-layer-invariant.md for the WHY.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolvePath(HERE, "..");

/**
 * Forward-edge-only DAG. `allows` lists every other @baerly/* package the owner
 * is permitted to import. Self-imports always allowed. Anything not listed is
 * forbidden. Source of truth lives in ADR-006; this table is the executable
 * mirror. When adding a new @baerly/* package, add a row here.
 */
const RULES = {
  protocol: { allows: [] },
  server: { allows: ["protocol"] },
  dev: { allows: ["protocol", "server", "adapter-node"] },
  "adapter-node": { allows: ["protocol", "server", "dev"] },
  "adapter-cloudflare": { allows: ["protocol", "server", "dev"] },
  client: { allows: ["protocol", "server"] },
  cli: {
    allows: ["protocol", "server", "dev", "adapter-node", "adapter-cloudflare", "client"],
  },
  "create-baerly-storage": { allows: ["protocol", "server", "cli"] },
};

// Captures the package name from `@baerly/<name>` or `@baerly/<name>/<subpath>`.
// The non-capturing `(?:\/[^"']*)?` is the load-bearing fix vs. the v1 regex
// that only matched bare specifiers (and so missed `@baerly/server/http`).
const IMPORT_RE = /(?:from|import)\s+["']@baerly\/([\w-]+)(?:\/[^"']*)?["']/g;

export function findViolations(files) {
  const violations = [];
  for (const { path, source, ownerPkg } of files) {
    const rule = RULES[ownerPkg];
    if (!rule) {continue;}
    for (const m of source.matchAll(IMPORT_RE)) {
      const importedPkg = m[1];
      if (importedPkg === ownerPkg) {continue;}
      if (rule.allows.includes(importedPkg)) {continue;}
      violations.push({ path, ownerPkg, importedPkg, allowed: rule.allows });
    }
  }
  return violations;
}

export function formatViolation(v) {
  const allowList =
    v.allowed.length === 0
      ? "(nothing — protocol must remain pure)"
      : v.allowed.map((p) => `@baerly/${p}`).join(", ");
  return [
    `${v.path}: @baerly/${v.ownerPkg} imports @baerly/${v.importedPkg}`,
    `  To fix: move the imported symbol down into a package @baerly/${v.ownerPkg} is`,
    `  allowed to depend on, or invert the dependency. See ADR-006 for the WHY.`,
    `  @baerly/${v.ownerPkg} may only import: ${allowList}`,
  ].join("\n");
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") {continue;}
      out.push(...(await walk(p)));
    } else if (
      /\.(ts|tsx|mjs|cjs|js)$/.test(e.name) &&
      !/\.test\.(ts|tsx)$/.test(e.name) &&
      !/\.test-d\.(ts|tsx)$/.test(e.name)
    ) {
      out.push(p);
    }
  }
  return out;
}

async function loadFiles() {
  const pkgRoot = join(ROOT, "packages");
  const pkgs = await readdir(pkgRoot, { withFileTypes: true });
  const files = [];
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) {continue;}
    if (!RULES[pkg.name]) {continue;}
    const srcDir = join(pkgRoot, pkg.name, "src");
    const paths = await walk(srcDir);
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      files.push({ path: relative(ROOT, path), source, ownerPkg: pkg.name });
    }
  }
  return files;
}

async function main() {
  const files = await loadFiles();
  const violations = findViolations(files);
  if (violations.length === 0) {
    console.log(`lint-package-layers: 0 violations across ${files.length} files`);
    return 0;
  }
  for (const v of violations) {console.error(formatViolation(v));}
  console.error(`\nlint-package-layers: ${violations.length} violation(s)`);
  return 1;
}

// Robust "am I the entrypoint" check that handles symlinks + Windows paths.
const invokedDirectly =
  process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(await main());
}
