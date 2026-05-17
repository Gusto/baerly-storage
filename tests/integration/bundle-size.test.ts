import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";

// Bundle weight matters because this lib ships into a user's app
// bundle — every byte we add is a byte they pay. To keep barrel
// consumers from paying for code they don't reach, we split the
// surface across subpath entrypoints (`baerly-storage/auth`,
// `baerly-storage/http`, `baerly-storage/maintenance`,
// `baerly-storage/observability`) and budget each entrypoint's
// transitive closure independently.
//
// The barrel (`baerly-storage`) carries the kernel surface (`Db`,
// `ServerWriter`, query/table helpers, schema, indexes) plus the
// auth presets. Maintenance (`runScheduledMaintenance`, profile
// constants) and observability primitives are NOT on the barrel
// as of 2026-05 — operator-side code reaches them via their
// subpath entries.
//
// `http.js` and (transitively) `index.js` carry a baseline
// observability cost that can't be shifted to a subpath:
// `packages/server/src/http/router.ts` directly calls
// `getLogger`/`CATEGORY` at the request boundary for structured
// logging, and the maintenance work units use `withObservability`.
// The thresholds below reflect that floor.
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
  /**
   * Skip this entry's check pending follow-up. Tracked in
   * `docs/followups/first-touch-dx.md`.
   */
  skip?: boolean;
}

const BUDGETS: readonly Budget[] = [
  // Full barrel: kernel + http + auth. After T01 (maintenance
  // moved to /maintenance subpath) and T02 (observability
  // re-exports dropped from the barrel), the barrel no longer
  // statically pulls maintenance or observability for app code
  // that only wants `Db`. ~345 KiB raw.
  // Budget bumped from 350 KiB raw / 100 KiB gz → 351 KiB raw / 103680 B gz
  // by the canonical-line renderer upgrade (picocolors + renderCanonical
  // helpers in prettyConsoleSink). Small, expected — one-time bump.
  { entry: "index.js", raw: 351 * 1024, gz: 103680 },
  // Just the five auth verifier factories. Adding a sixth grows
  // this budget, not the kernel's.
  { entry: "auth.js", raw: 34 * 1024, gz: 12 * 1024 },
  // hono/tiny-backed HTTP router + long-poll/since helpers +
  // observability middleware. Observability is load-bearing at
  // every request boundary (canonical-line emission,
  // structured logging, per-request metrics), so the request
  // path carries an observability baseline cost that can't be
  // shifted to a subpath. ~270 KiB raw.
  { entry: "http.js", raw: 285 * 1024, gz: 82 * 1024 },
  // Observability primitives — ObservabilityContext, the
  // request-scoped MetricsRecorder, LogTape config + sinks,
  // canonical line flush, observableStorage decorator. LogTape
  // itself accounts for the bulk; a smaller direct-stdout sink
  // could trim further but is deferred.
  { entry: "observability.js", raw: 100 * 1024, gz: 36 * 1024 },
  // Maintenance loop — compactor + GC + sweep driver. Pulls
  // compactor.ts + gc.ts + the observability subgraph
  // transitively (every work unit runs under withObservability).
  // Operator-side; not part of the kernel barrel as of T01.
  // ~141 KiB raw.
  { entry: "maintenance.js", raw: 155 * 1024, gz: 43 * 1024 },
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
  for (const { entry, raw, gz, skip } of BUDGETS) {
    test.skipIf(skip)(`dist/${entry} closure stays within budget`, () => {
      const measured = measureClosure(entry);
      // Show closure composition in failure output so a regression
      // points straight at the chunk that grew.
      const report = `${entry} closure: raw=${measured.raw} (budget ${raw}), gz=${measured.gz} (budget ${gz})\n  chunks: ${measured.files.join(", ")}`;
      expect(measured.raw, `raw bytes over budget — ${report}`).toBeLessThanOrEqual(raw);
      expect(measured.gz, `gzipped bytes over budget — ${report}`).toBeLessThanOrEqual(gz);
    });
  }
});
