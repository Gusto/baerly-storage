#!/usr/bin/env node
/**
 * Rewrite extensionless relative imports to include explicit `.ts` /
 * `.tsx` extensions so workspace source is consumable by Node's
 * native `--experimental-strip-types` runtime.
 *
 * Scope: paths oxlint doesn't lint (bench/, deploy/, examples/, scripts/, root *.config.ts).
 * oxlint owns packages/** and tests/** via `import/extensions: ["error","always"]`.
 *
 *   node scripts/add-ts-extensions.mjs           # apply
 *   node scripts/add-ts-extensions.mjs --check   # exit non-zero on diff
 *
 * Resolution rules per specifier `./foo`:
 *   - `./foo.ts`        exists → append `.ts`
 *   - `./foo.tsx`       exists → append `.tsx`
 *   - `./foo/index.ts`  exists → append `/index.ts`
 *   - `./foo/index.tsx` exists → append `/index.tsx`
 *   - otherwise: print site and exit 2.
 */
import { readFile, writeFile, stat, glob } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_MODE = process.argv.includes("--check");
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");

// Coverage split: oxlint (configured with `import/extensions: ["error","always"]`)
// already lints `packages/**` and `tests/**` over `verify:agent`'s glob. This
// script owns the paths oxlint doesn't lint, plus the autofix capability that
// stock `import/extensions` can't provide (it can't filesystem-resolve a bare
// `./foo` to `./foo.ts` vs `./foo/index.tsx`).
const GLOBS = [
  "bench/**/*.ts",
  "bench/**/*.tsx",
  "deploy/**/*.ts",
  "examples/*/apps/*/src/**/*.ts",
  "examples/*/apps/*/src/**/*.tsx",
  "examples/*/apps/*/*.config.ts",
  "examples/*/smoke.test.ts",
  "scripts/**/*.ts",
  "scripts/**/*.mts",
  "*.config.ts",
];

const KNOWN_SUFFIXES =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|css|scss|svg|png|jpg|jpeg|gif|webp|ico|html|md|wasm|node)$/i;

const PATTERNS = [
  /(\bfrom\s*)(['"])(\.\.?\/[^'"\n]*)\2/g,
  /(^|[^.\w$])(import\s+)(['"])(\.\.?\/[^'"\n]*)\3/g,
  /(\bimport\s*\(\s*)(['"])(\.\.?\/[^'"\n]*)\2/g,
  /(\bvi\.(?:mock|doMock|importActual)\s*\(\s*)(['"])(\.\.?\/[^'"\n]*)\2/g,
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveSuffix(importerDir, specifier) {
  const target = resolvePath(importerDir, specifier);
  if (await exists(`${target}.ts`)) {
    return ".ts";
  }
  if (await exists(`${target}.tsx`)) {
    return ".tsx";
  }
  if (await exists(`${target}/index.ts`)) {
    return "/index.ts";
  }
  if (await exists(`${target}/index.tsx`)) {
    return "/index.tsx";
  }
  return null;
}

const unresolved = [];
let changedFiles = 0;
let editedSites = 0;

async function rewriteFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const dir = dirname(filePath);
  const replacements = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      // Locate the specifier within the match. The specifier capture is
      // always the last group ending in the closing quote.
      const groups = m.slice(1);
      // The specifier is the last non-quote, non-leading group; quote is the
      // capture immediately before it. Find spec by scanning groups from the
      // tail: spec = last group, quote = the one before that.
      const spec = groups[groups.length - 1];
      const quote = groups[groups.length - 2];
      if (KNOWN_SUFFIXES.test(spec)) {
        continue;
      }
      // Find the spec's start index in the source by locating the closing
      // quote right after `spec` ends. `m.index + m[0].length - quote.length`
      // is the index of the closing quote; subtract spec.length to get the
      // spec's start.
      const closingQuoteIdx = m.index + m[0].length - quote.length;
      const specStart = closingQuoteIdx - spec.length;
      const specEnd = closingQuoteIdx;
      const suffix = await resolveSuffix(dir, spec);
      if (!suffix) {
        unresolved.push({ filePath, spec });
        continue;
      }
      replacements.push({ start: specStart, end: specEnd, value: spec + suffix });
    }
  }
  if (replacements.length === 0) {
    return;
  }
  replacements.sort((a, b) => a.start - b.start);
  // De-dupe identical sites (a literal can match multiple patterns)
  const deduped = [];
  for (const r of replacements) {
    const last = deduped[deduped.length - 1];
    if (last && last.start === r.start && last.end === r.end) {
      continue;
    }
    deduped.push(r);
  }
  let out = "";
  let cursor = 0;
  for (const r of deduped) {
    out += source.slice(cursor, r.start) + r.value;
    cursor = r.end;
  }
  out += source.slice(cursor);
  if (out === source) {
    return;
  }
  editedSites += deduped.length;
  changedFiles += 1;
  if (!CHECK_MODE) {
    await writeFile(filePath, out);
  }
}

const seen = new Set();
for (const pattern of GLOBS) {
  for await (const rel of glob(pattern, { cwd: REPO_ROOT })) {
    const abs = resolvePath(REPO_ROOT, rel);
    if (seen.has(abs)) {
      continue;
    }
    seen.add(abs);
    await rewriteFile(abs);
  }
}

if (unresolved.length > 0) {
  for (const u of unresolved) {
    console.error(`unresolved: ${u.filePath}: "${u.spec}"`);
  }
  process.exit(2);
}

if (CHECK_MODE) {
  if (changedFiles > 0) {
    console.error(
      `${editedSites} site(s) in ${changedFiles} file(s) need explicit .ts/.tsx extension`,
    );
    process.exit(1);
  }
  console.log("OK: all relative imports carry .ts/.tsx extensions.");
} else {
  console.log(`Rewrote ${editedSites} site(s) across ${changedFiles} file(s).`);
}
