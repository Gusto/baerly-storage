import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  closureFiles,
  collectClosure,
  DIST_DIR,
  measureMinGz,
  measureRawGz,
  minifyCacheStats,
  resetMinifyCache,
  STATIC_IMPORT_RE,
} from "../../scripts/bundle-measure.ts";
import {
  compareSnapshot,
  loadSnapshot,
  measureSnapshotEntries,
  publishedEntries,
  unmeasuredPublishedEntries,
} from "../../scripts/bundle-sizes.ts";

// Bundle weight matters because this lib ships into a user's app bundle.
// The BUDGETS this file used to carry now live in `bundle-sizes.json`,
// enforced by the `pnpm bundle-sizes` delta gate.
//
// What stays here is what is genuinely a TEST rather than a budget:
// closure-composition invariants that no byte count can express. That
// division is load-bearing rather than tidy — when the `@baerly/dev` barrel
// dragged the Node-only local-fs closure into every deployed Worker, every
// byte axis on `cloudflare.js` passed and the Workerd-builtin assertion
// below is what caught it.
//
// Policy, axis semantics, and how to respond to a failure:
//   docs/contributing/conventions/bundle-budgets.md

describe("bundle size", () => {
  test("minifies each unique chunk exactly once across overlapping closures", async () => {
    resetMinifyCache();
    const indexFiles = closureFiles("index.js");
    const httpFiles = closureFiles("http.js");

    await measureMinGz(indexFiles);
    await measureMinGz(httpFiles);

    const unique = new Set([...indexFiles, ...httpFiles]).size;
    const stats = minifyCacheStats();
    // One esbuild call per unique chunk, never more.
    expect(stats.misses).toBe(unique);
    // The two closures overlap, so the second pass must hit the cache.
    expect(stats.hits).toBeGreaterThan(0);
  });

  // The kernel barrel (`baerly-storage`) is the surface every consumer
  // pays for. Writer / compactor / GC read the active per-request
  // recorder via `getCurrentContext()?.recorder`; that lookup needs
  // the tiny `context.ts` chunk but MUST NOT drag the full
  // `observability-*.js` subgraph (logtape + canonical-line render +
  // pretty sink) into the barrel.
  test("dist/index.js closure excludes the observability subgraph", () => {
    const measured = measureRawGz(closureFiles("index.js"));
    const observabilityChunks = measured.files.filter((f) => f.startsWith("observability-"));
    expect(
      observabilityChunks,
      `kernel barrel must not pull the observability subgraph; found: ${observabilityChunks.join(", ")}`,
    ).toEqual([]);
  });

  // `cloudflare.js` ships into a Worker. Workerd can load exactly one of the
  // Node builtins this repo uses — `node:async_hooks`, under `nodejs_compat`,
  // which `@baerly/server` needs for the per-request observability ALS. Every
  // other `node:` specifier reaching this closure is code that cannot run
  // there.
  //
  // This guard exists because nothing else could see the real thing.
  // `worker.ts` imported `renderDevLanding` from the `@baerly/dev` barrel,
  // the barrel re-exports `LocalFsStorage`, and rolldown chunked the whole
  // Node-only local-fs closure — `node:crypto`, `node:fs/promises`,
  // `node:os`, `node:path` — into the Worker bundle for the sake of one HTML
  // string. Measured with that import reintroduced, all three byte axes on
  // this entry still PASSED: the drag was invisible on every axis, and only
  // became a symptom later when unrelated growth pushed min-gz over.
  // `scripts/lint-package-layers.mjs` cannot see it either — its `allowNode`
  // gate reads a package's own source, and no `node:` specifier ever
  // appeared in `packages/adapter-cloudflare/`.
  //
  // Asserting on the artifact is what closes that gap, because the artifact
  // is where a transitive drag becomes observable. It also means the raw/gz
  // delta gate in `bundle-sizes.json` does not have to carry this weight —
  // per the POLICY those axes are diagnostics, and a threshold tight enough
  // to catch a barrel drag would fire on an ordinary JSDoc edit instead.
  //
  // Matches quoted specifiers in `from "node:…"`, side-effect
  // `import "node:…"`, and `import("node:…")` — deliberately broader than
  // `STATIC_IMPORT_RE`, which requires `from`. Quoting is what keeps this off
  // prose: dist ships module-level JSDoc un-stripped, and several chunks
  // discuss `node:fs` in backticks (e.g. `current-json-*.js` documenting that
  // it stays Worker-bundleable).
  const NODE_SPECIFIER_RE = /["'](node:[\w/.-]+)["']/g;
  const WORKERD_LOADABLE_BUILTINS = new Set(["node:async_hooks"]);
  test("dist/cloudflare.js closure imports no Workerd-unloadable Node builtin", () => {
    const offenders: string[] = [];
    for (const file of closureFiles("cloudflare.js")) {
      for (const m of readFileSync(file, "utf8").matchAll(NODE_SPECIFIER_RE)) {
        const spec = m[1]!;
        if (WORKERD_LOADABLE_BUILTINS.has(spec)) {
          continue;
        }
        offenders.push(`${file.replace(DIST_DIR, "")} → ${spec}`);
      }
    }
    expect(
      offenders,
      `dist/cloudflare.js closure may import only [${[...WORKERD_LOADABLE_BUILTINS].join(", ")}]; found: ${offenders.join(", ")}. A Node builtin here means Node-only code was dragged into the Worker bundle — usually by importing a barrel that re-exports it. Import the leaf module instead (cf. \`@baerly/dev/dev-landing\` in packages/adapter-cloudflare/src/worker.ts)`,
    ).toEqual([]);
  });

  // `node.js` and `dev-vite.js` are server-side / dev-only aggregator
  // entrypoints — they never ship to a browser and never enter a
  // consumer's app bundle. The REAL risk on these surfaces is a heavy
  // runtime dependency silently creeping into the closure, so this guard
  // is a bare-specifier allowlist rather than a wire-size assertion; the
  // raw axis for both entries is delta-gated in `bundle-sizes.json`.
  //
  // For each entry we walk the static-import closure and collect every
  // NON-relative import specifier. Each must be either a Node builtin
  // (`node:*`) or one of the four declared runtime deps. This catches a
  // dep that regresses to a LIVE EXTERNAL (un-bundled) import — e.g. a
  // rolldown `external`/bundling slip. A heavy dep that gets bundled
  // INLINE won't show as a bare import here; the raw delta gate is what
  // catches that vector.
  const RUNTIME_DEP_ALLOWLIST = new Set(["@rgrove/parse-xml", "aws4fetch", "hono", "jose"]);
  // Extract the package name from a bare specifier. `hono/tiny` →
  // `hono`; `@scope/name/sub` → `@scope/name`.
  const packageName = (spec: string): string => {
    const parts = spec.split("/");
    return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  };
  for (const entry of ["node.js", "dev-vite.js"]) {
    test(`dist/${entry} closure imports only Node builtins + declared runtime deps`, () => {
      const seen = new Set<string>();
      collectClosure(resolve(DIST_DIR, entry), seen);
      const offenders: string[] = [];
      for (const file of seen) {
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(STATIC_IMPORT_RE)) {
          const spec = m[1]!;
          if (spec.startsWith("./") || spec.startsWith("../")) {
            continue;
          }
          if (spec.startsWith("node:") || RUNTIME_DEP_ALLOWLIST.has(packageName(spec))) {
            continue;
          }
          offenders.push(`${file.replace(DIST_DIR, "")} → ${spec}`);
        }
      }
      expect(
        offenders,
        `${entry} closure may import only node:* builtins + [${[...RUNTIME_DEP_ALLOWLIST].join(", ")}]; unexpected: ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  }

  // Scaffolded apps install only `baerly-storage`. `@rgrove/parse-xml`
  // and `aws4fetch` are bundled into the published library + bin
  // chunks that use them (see `rolldown.config.ts` and
  // `packages/cli/rolldown.config.ts`); no dist closure may leave a
  // live `import "@rgrove/parse-xml"` or `import "aws4fetch"` for the
  // host's module resolver to chase, because the host doesn't have
  // those packages on disk.
  //
  // History: the first version of this test only walked
  // `dist/baerly.js` (commit `51b532e`, agent-struggle #14). A second
  // regression of the same class slipped through on the library
  // surface — `dist/dev-vite.js` transitively pulled `dist/node.js`'s
  // S3 client and emitted a live `import "@xmldom/xmldom"`, which
  // killed `vite` on scaffolded Cloudflare apps. This test now walks
  // every entry in the published `exports` map plus the bin.
  // (2026-07-02): `fast-xml-parser` removed from this set — it is gone
  // from the tree entirely (neither a runtime nor a dev dependency) and
  // `@rgrove/parse-xml` added as the new runtime XML parser.
  const BUNDLED_OPTIONAL_PEERS = new Set(["@rgrove/parse-xml", "aws4fetch"]);
  const pkgRoot = resolve(DIST_DIR, "..");
  const rootPkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    publishConfig?: { exports?: Record<string, { import?: string }> };
  };
  const entries: string[] = [];
  // Walk the PUBLISHED exports (dist/*.js), not the dev exports
  // (packages/*/src/*.ts): the dev targets end in `.ts`, so filtering for
  // `.js` there matched nothing and this guard silently checked only `bin`.
  for (const cond of Object.values(rootPkg.publishConfig?.exports ?? {})) {
    if (cond.import?.endsWith(".js")) {
      entries.push(resolve(pkgRoot, cond.import));
    }
  }
  for (const binPath of Object.values(rootPkg.bin ?? {})) {
    entries.push(resolve(pkgRoot, binPath));
  }
  test("entry enumeration is non-empty (guards against a dead no-live-import walk)", () => {
    // 14 published exports + 1 bin. If this collapses to ~1 the exports
    // enumeration has silently broken again — fail loud instead of
    // generating zero closure tests below.
    expect(entries.length).toBeGreaterThan(10);
  });
  for (const entryAbs of entries) {
    const label = entryAbs.replace(`${pkgRoot}/`, "");
    test(`${label} closure has no live import of bundled optional peers`, () => {
      const seen = new Set<string>();
      collectClosure(entryAbs, seen);
      const offenders: string[] = [];
      for (const file of seen) {
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(STATIC_IMPORT_RE)) {
          const spec = m[1]!;
          if (BUNDLED_OPTIONAL_PEERS.has(spec)) {
            offenders.push(`${file.replace(DIST_DIR, "")} → ${spec}`);
          }
        }
      }
      expect(
        offenders,
        `${label} must self-contain optional peers; live imports: ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  }
});

describe("bundle size snapshot", () => {
  test("committed bundle-sizes.json matches a fresh build", async () => {
    const snapshot = loadSnapshot();
    const measured = await measureSnapshotEntries(snapshot);
    const violations = compareSnapshot(snapshot, measured);
    expect(
      violations,
      `${violations.length} bundle-size violation(s). Run \`pnpm bundle-sizes\` for the full report.`,
    ).toEqual([]);
    // The BUDGETS loop this replaced was one `test()` per entry, so each got
    // its own 5 s default. Measuring all 14 closures — esbuild-minifying every
    // unique chunk — now happens inside a single test, and 14x the work does
    // not fit 1x the budget on a loaded machine or runner. Observed: ~5 s idle,
    // over 5 s under parallel load. 60 s is slack, not a hang allowance.
  }, 60_000);

  // A new published subpath must not silently escape gating: rolldown emits
  // it, consumers can import it, and nothing would measure it. `pnpm
  // bundle-sizes` enforces the same thing on the same helper — this is the
  // backstop for a change that reaches CI without tripping the hook's glob.
  test("every published dist export appears in the snapshot", () => {
    const missing = unmeasuredPublishedEntries(loadSnapshot());
    expect(
      missing,
      `published entries absent from bundle-sizes.json: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  // The helper is only worth anything if it reads the real published surface.
  // Asserting it is non-empty keeps a bad `publishConfig.exports` shape from
  // reducing the check above to `[] === []`.
  test("the published surface it checks against is not empty", () => {
    expect(publishedEntries()).toContain("index.js");
  });
});

describe("spec artifact emission", () => {
  test("dist/baerly.spec.json is emitted and schema-shaped", () => {
    const path = resolve(DIST_DIR, "baerly.spec.json");
    expect(existsSync(path)).toBe(true);
    const ir = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(ir["specVersion"]).toBe("1");
    expect(Array.isArray(ir["errorCodes"])).toBe(true);
    expect((ir["errorCodes"] as unknown[]).length).toBe(15);
  });
});
