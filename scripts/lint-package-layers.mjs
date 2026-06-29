#!/usr/bin/env node
// Enforce package layer direction. Imports between @baerly/* packages — static,
// dynamic `import()`, and relative cross-package — must follow the rule table
// below. Additionally gates `node:`-builtin purity for `protocol` and `server`
// so the kernel stays Workerd-loadable. Violations exit non-zero with a
// remediation hint. See docs/contributing/architecture.md (§Package layers) for the WHY.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolvePath(HERE, "..");

/**
 * Hand-maintained import allow list (contains one accepted Node-only
 * `dev ↔ adapter-node` cycle — see docs/contributing/architecture.md
 * §Package layers), plus a per-owner `node:`-builtin
 * purity gate for `protocol` and `server`. `allows` lists every other
 * @baerly/* package the owner is permitted to import. Self-imports always
 * allowed. Anything not listed is forbidden. The optional `allowNode` field
 * gates Node builtins: when defined, the owner may only import `node:` builtins
 * in the list (`protocol` allows none; `server` allows `node:async_hooks`,
 * which Workerd supports under `nodejs_compat`). Rows leaving `allowNode`
 * undefined are Node-only by design and may import any builtin. Source of truth
 * lives in docs/contributing/architecture.md §Package layers; this table is the
 * executable mirror. When adding a new @baerly/* package, add a row to both.
 */
const RULES = {
  protocol: { allows: [], allowNode: [] },
  server: { allows: ["protocol"], allowNode: ["node:async_hooks"] },
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
// Known limitation: this (and the regexes below) scans raw source, so
// import-shaped text inside comments/JSDoc `@example` blocks also matches.
const IMPORT_RE = /(?:from|import)\s+["']@baerly\/([\w-]+)(?:\/[^"']*)?["']/g;

// Dynamic `import("@baerly/<name>")` / `await import("@baerly/<name>/sub")`.
// A static-only regex sails past dynamic edges; this closes that gap.
const DYNAMIC_RE = /import\(\s*["']@baerly\/([\w-]+)(?:\/[^"']*)?["']\s*\)/g;

// Relative climb-out to a sibling package: `../../<name>/src/...` or
// `../../<name>/...`. The repo's own convention is relative `.ts` imports, so a
// sibling-adapter import written idiomatically would otherwise be missed. The
// captured `<name>` is gated on being a RULES key (and != ownerPkg) downstream
// so non-package sibling dirs don't produce false positives.
const RELATIVE_CROSS_RE = /(?:from|import)\s+["'](?:\.\.\/)+([\w-]+)\/(?:src\/)?[^"']*["']/g;

// `node:` builtin specifiers in static `from`/`import x from`, side-effect
// `import "node:…"`, and dynamic `import("node:…")` forms. Only enforced for
// owners whose RULES row defines `allowNode`.
const NODE_RE =
  /(?:from|import)\s+["'](node:[\w/.-]+)["']|import\(\s*["'](node:[\w/.-]+)["']\s*\)/g;

export function findViolations(files) {
  const violations = [];
  for (const { path, source, ownerPkg } of files) {
    const rule = RULES[ownerPkg];
    if (!rule) {
      continue;
    }
    const checkPkg = (importedPkg) => {
      if (importedPkg === ownerPkg) {
        return;
      }
      if (!RULES[importedPkg]) {
        return;
      }
      if (rule.allows.includes(importedPkg)) {
        return;
      }
      violations.push({ path, ownerPkg, importedPkg, allowed: rule.allows });
    };
    for (const m of source.matchAll(IMPORT_RE)) {
      checkPkg(m[1]);
    }
    for (const m of source.matchAll(DYNAMIC_RE)) {
      checkPkg(m[1]);
    }
    for (const m of source.matchAll(RELATIVE_CROSS_RE)) {
      checkPkg(m[1]);
    }
    if (rule.allowNode) {
      for (const m of source.matchAll(NODE_RE)) {
        const importedPkg = m[1] ?? m[2];
        if (rule.allowNode.includes(importedPkg)) {
          continue;
        }
        violations.push({ path, ownerPkg, importedPkg, allowed: rule.allows });
      }
    }
  }
  return violations;
}

export function formatViolation(v) {
  if (v.importedPkg.startsWith("node:")) {
    return [
      `${v.path}: @baerly/${v.ownerPkg} imports Node builtin ${v.importedPkg} — @baerly/${v.ownerPkg} must stay Workerd-loadable`,
      `  To fix: drop the Node builtin, or move the Node-only code into a package`,
      `  that is allowed to use it (e.g. @baerly/dev / @baerly/adapter-node).`,
      `  See docs/contributing/architecture.md (§Package layers) for the WHY.`,
    ].join("\n");
  }
  const allowList =
    v.allowed.length === 0
      ? "(nothing — protocol must remain pure)"
      : v.allowed.map((p) => `@baerly/${p}`).join(", ");
  return [
    `${v.path}: @baerly/${v.ownerPkg} imports @baerly/${v.importedPkg}`,
    `  To fix: move the imported symbol down into a package @baerly/${v.ownerPkg} is`,
    `  allowed to depend on, or invert the dependency. See docs/contributing/architecture.md (§Package layers) for the WHY.`,
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
      if (e.name === "node_modules" || e.name === "dist") {
        continue;
      }
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
    if (!pkg.isDirectory()) {
      continue;
    }
    if (!RULES[pkg.name]) {
      continue;
    }
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
  for (const v of violations) {
    console.error(formatViolation(v));
  }
  console.error(`\nlint-package-layers: ${violations.length} violation(s)`);
  return 1;
}

// Robust "am I the entrypoint" check that handles symlinks + Windows paths.
const invokedDirectly =
  process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(await main());
}
