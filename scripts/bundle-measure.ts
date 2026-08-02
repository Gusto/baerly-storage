import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
// min+gz numbers are esbuild-version-sensitive: a minifier version bump
// rebaselines every entry's `minGz` measurement at once.
import { transform } from "esbuild";

/**
 * Absolute path to the built `dist/` these helpers measure.
 *
 * Resolved from `import.meta.url` rather than `__dirname` so the module
 * works both under vitest and under `node scripts/bundle-sizes.ts`, where
 * `__dirname` does not exist.
 */
export const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));

/** Matches a static `import ... from "x"` / `export ... from "x"` specifier. */
export const STATIC_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^"']*?from\s*["']([^"']+)["']/g;

/** Walk `entryAbs`'s static-import graph, accumulating absolute paths in `seen`. */
export function collectClosure(entryAbs: string, seen: Set<string>): void {
  if (seen.has(entryAbs)) {
    return;
  }
  seen.add(entryAbs);
  const src = readFileSync(entryAbs, "utf8");
  for (const m of src.matchAll(STATIC_IMPORT_RE)) {
    const spec = m[1]!;
    if (!spec.startsWith("./") && !spec.startsWith("../")) {
      continue;
    }
    collectClosure(resolve(dirname(entryAbs), spec), seen);
  }
}

/** Absolute paths of every chunk in `entry`'s closure, sorted for determinism. */
export function closureFiles(entry: string): string[] {
  const entryAbs = resolve(DIST_DIR, entry);
  if (!existsSync(entryAbs)) {
    throw new Error(`dist/${entry} missing — run \`pnpm build\` first`);
  }
  const seen = new Set<string>();
  collectClosure(entryAbs, seen);
  return [...seen].toSorted();
}

/**
 * Raw + gzipped closure size. Pure fs + zlib, NO esbuild, so callers that
 * only need these axes never pay the minifier.
 */
export function measureRawGz(files: readonly string[]): {
  raw: number;
  gz: number;
  files: string[];
} {
  const raw = files.reduce((sum, f) => sum + statSync(f).size, 0);
  const gz = gzipSync(Buffer.concat(files.map((f) => readFileSync(f)))).length;
  return { raw, gz, files: files.map((f) => f.replace(DIST_DIR, "")) };
}

// Entry closures overlap heavily — measured at 87 transform calls for 33
// unique chunks across the budgeted entries. Memoising by absolute chunk
// path cuts esbuild invocations ~62% for identical output, because `dist/`
// does not change within a single process.
const minifyCache = new Map<string, string>();
let cacheHits = 0;
let cacheMisses = 0;

/** Cache counters, for the test that pins the memoisation contract. */
export function minifyCacheStats(): { hits: number; misses: number } {
  return { hits: cacheHits, misses: cacheMisses };
}

/** Drop the cache and counters. Test-only. */
export function resetMinifyCache(): void {
  minifyCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

// The retry is a smoother for a one-off transient, scoped to the esbuild
// call only. Budget assertions are deterministic functions of the committed
// dist/ bytes, so a real regression fails on the first and every attempt.
// Each failure is logged rather than swallowed.
async function minifyChunk(file: string, attempts = 3): Promise<string> {
  const cached = minifyCache.get(file);
  if (cached !== undefined) {
    cacheHits++;
    return cached;
  }
  cacheMisses++;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { code } = await transform(readFileSync(file, "utf8"), {
        loader: "js",
        minify: true,
      });
      minifyCache.set(file, code);
      return code;
    } catch (error) {
      lastError = error;
      console.warn(
        `minifyChunk: esbuild attempt ${attempt}/${attempts} failed for ${file}: ${error}`,
      );
    }
  }
  throw new Error(`minifyChunk: esbuild failed for ${file} after ${attempts} attempts`, {
    cause: lastError,
  });
}

/**
 * Minify each chunk with esbuild, concatenate, gzip. The consumer-facing
 * artifact proxy: the lib ships UNMINIFIED, so neither `raw` nor
 * unminified-`gz` is what a consumer pays once their bundler re-minifies.
 * CONSERVATIVE UPPER BOUND — per-file syntax minify only, no cross-module
 * tree-shaking, so real consumer cost is <= this number.
 */
export async function measureMinGz(files: readonly string[]): Promise<number> {
  const minified: string[] = [];
  for (const file of files) {
    minified.push(await minifyChunk(file));
  }
  return gzipSync(Buffer.concat(minified.map((c) => Buffer.from(c)))).length;
}
