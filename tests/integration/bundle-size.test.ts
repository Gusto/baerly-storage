import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";

// ADR-0001 motivates the vendorless choice on bundle weight: this lib
// ships into a user's app bundle, so every byte we add is a byte they
// pay. Phase-8 ticket 37 added five auth-preset verifiers to the
// kernel barrel, pushing the unminified bundle from ~168 KiB to
// ~213 KiB. Rather than just bump the budget, we split the surface
// into subpath entrypoints (`baerly-storage/auth`, `baerly-storage/http`)
// so consumers who don't need them don't pay for them — and we budget
// each entrypoint independently. See ADR-0001 and the plan in
// `~/.claude/plans/foamy-strolling-wirth.md` for the rationale.
//
// Each entry is a static-import closure: rolldown code-splits shared
// modules into chunks, so importing `baerly-storage/auth` actually
// pulls in `auth.js` + the auth chunk + a shared errors chunk. We
// budget the full transitive closure, not just the entry file, because
// that's what the consumer's bundler pulls in.
//
// Budgets cover BOTH unminified raw bytes AND gzipped bytes:
//   - raw — what the parser sees (cold-start cost, esp. on Workers)
//   - gz  — what the wire / CDN cache sees (consumer-bundler-agnostic)
// Consumer bundlers minify on top of this; minified+gzipped is a
// future addition (see follow-up tickets in the plan).
//
// Budgets are set ~8–15% above the measured size on the refactor
// branch. A failure here means the surface grew without an explicit
// budget bump — either justify it and raise the number, or refactor
// behind another subpath.

interface Budget {
  /** Entry filename under `dist/`. */
  entry: string;
  /** Max unminified bytes for the entry's transitive closure. */
  raw: number;
  /** Max gzipped bytes for the entry's transitive closure. */
  gz: number;
}

const BUDGETS: readonly Budget[] = [
  // Full barrel: kernel + maintenance + http + auth. Subpath users
  // skip what they don't need; barrel users get everything.
  { entry: "index.js", raw: 235 * 1024, gz: 72 * 1024 },
  // Just the five auth verifier factories. Adding a sixth grows
  // this budget, not the kernel's.
  { entry: "auth.js", raw: 34 * 1024, gz: 12 * 1024 },
  // Hono-backed HTTP router + long-poll/since helpers. Heavy because
  // Hono itself is heavy; a follow-up may move to `hono/tiny`.
  { entry: "http.js", raw: 168 * 1024, gz: 50 * 1024 },
];

// Static-import specifiers only. Dynamic `import(...)` is intentionally
// excluded — code reachable only via dynamic import is a separate
// budget concern.
const STATIC_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^"']*?from\s*["']([^"']+)["']/g;

function collectClosure(entryAbs: string, seen: Set<string>): void {
  if (seen.has(entryAbs)) return;
  seen.add(entryAbs);
  const src = readFileSync(entryAbs, "utf8");
  for (const m of src.matchAll(STATIC_IMPORT_RE)) {
    const spec = m[1]!;
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    collectClosure(resolve(dirname(entryAbs), spec), seen);
  }
}

function measureClosure(entry: string): { raw: number; gz: number; files: string[] } {
  const distDir = resolve(__dirname, "../../dist");
  const entryAbs = resolve(distDir, entry);
  if (!existsSync(entryAbs)) {
    throw new Error(`dist/${entry} missing — run \`pnpm build\` before \`pnpm test\``);
  }
  const seen = new Set<string>();
  collectClosure(entryAbs, seen);
  const files = [...seen].toSorted();
  const raw = files.reduce((sum, f) => sum + statSync(f).size, 0);
  const gz = gzipSync(Buffer.concat(files.map((f) => readFileSync(f)))).length;
  return { raw, gz, files: files.map((f) => f.replace(`${distDir}/`, "")) };
}

describe("bundle size", () => {
  for (const { entry, raw, gz } of BUDGETS) {
    test(`dist/${entry} closure stays within budget`, () => {
      const measured = measureClosure(entry);
      // Show closure composition in failure output so a regression
      // points straight at the chunk that grew.
      const report = `${entry} closure: raw=${measured.raw} (budget ${raw}), gz=${measured.gz} (budget ${gz})\n  chunks: ${measured.files.join(", ")}`;
      expect(measured.raw, `raw bytes over budget — ${report}`).toBeLessThanOrEqual(raw);
      expect(measured.gz, `gzipped bytes over budget — ${report}`).toBeLessThanOrEqual(gz);
    });
  }
});
