// Vitest 4 `projects:` split. The default project runs the in-tree and
// Node-only suites under `pool: "forks"` (same as pre-Phase-3). The
// `cloudflare-pool` project runs `r2BindingStorage` conformance under
// `@cloudflare/vitest-pool-workers` so the test executes against a
// real Workerd R2 binding. Both projects share
// `tests/setup/fast-check.ts` so `FC_NUM_RUNS` continues to apply to
// fast-check arbitraries in either runtime.
//
// `CONFORMANCE=1`, `EXPORT_SMOKE=1`, and `MINIO=1` stay scoped to the
// default project — the matching test files live under
// `tests/integration/` or use `describe.runIf` inside the file, not in
// any adapter package. `ADAPTER_CLOUDFLARE=1` is recommended (but not
// enforced) for selecting the `cloudflare-pool` project; the standard
// invocation is `vitest run --project=cloudflare-pool` via the
// `test:adapter-cloudflare` script.
//
// vitest-pool-workers ≥ 0.16 (the version pinned in `package.json`)
// drops the `pool: "@cloudflare/vitest-pool-workers"` +
// `poolOptions.workers` shape that earlier docs describe. The current
// API is `plugins: [cloudflareTest({ miniflare: {…} })]` per project —
// the plugin wires `poolRunner = cloudflarePool(...)` for us.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// `conformance.test.ts` requires gitignored credentials files
// (`credentials/*.json`) and a live Minio. Excluded by default;
// opt in with `CONFORMANCE=1 pnpm test` (or `pnpm test:conformance`).
const conformanceExclude = process.env.CONFORMANCE === "1" ? [] : ["**/conformance.test.ts"];

// `export-smoke.test.ts` translates frozen Phase-1 `LogEntry` shapes
// into a real Postgres on `:5433` (provisioned by `pnpm dev:storage`).
// Excluded by default; opt in with `EXPORT_SMOKE=1 pnpm test` (or
// `pnpm test:export-smoke`). The test file itself also uses
// `describe.runIf(EXPORT_SMOKE === "1")` — double-gating is
// intentional: the glob exclusion keeps the import (`pg`) from
// resolving at all on the default path.
const exportSmokeExclude = process.env.EXPORT_SMOKE === "1" ? [] : ["**/export-smoke.test.ts"];

// Real-deploy gate (`tests/integration/real-deploy-*.test.ts`) hits
// live Cloudflare Worker / Node-host deploys driven by
// `CF_DEPLOY_URL` / `NODE_DEPLOY_URL` / `SHARED_SECRET`. Excluded
// from the default project's glob so `pnpm test` stays green on a
// fresh checkout with no env vars; opt in via `pnpm gate:real-deploy`
// (which sets the env up out-of-band per `deploy/README.md`). Each
// file also uses `describe.runIf(...)` — double-gating is
// intentional: the exclude prevents the imports (`aws4fetch`,
// `@xmldom/xmldom`) from even resolving on the default path.
const realDeployExclude =
  process.env.CF_DEPLOY_URL !== undefined || process.env.NODE_DEPLOY_URL !== undefined
    ? []
    : ["**/real-deploy-cloudflare.test.ts", "**/real-deploy-node.test.ts"];

// Day-one handshake gate (`tests/integration/day-one-handshake.test.ts`)
// orchestrates `npm create baerly@latest` → `baerly deploy` → first-
// record on a per-target basis driven by `DAY_ONE_TARGETS=node|
// cloudflare,node`. Excluded from the default project's glob when the
// env var is unset so `pnpm test` stays green on a fresh checkout;
// opt in via `pnpm gate:day-one` after exporting `DAY_ONE_TARGETS`
// (plus `CF_API_TOKEN` / `CF_ACCOUNT_ID` for the CF target) per
// `docs/operating/day-one-gate.md`. The file also uses
// `describe.runIf(...)` — double-gating mirrors `realDeployExclude`.
const dayOneExclude =
  process.env.DAY_ONE_TARGETS !== undefined ? [] : ["**/day-one-handshake.test.ts"];

// The R2 binding conformance entry lives at
// `packages/adapter-cloudflare/src/r2-binding-storage.conformance.test.ts`
// and reads `globalThis.__BAERLY_R2_BINDING__`. Only the
// `cloudflare-pool` project — backed by
// `@cloudflare/vitest-pool-workers` — supplies that global (via
// `tests/setup/r2-binding.ts`). Excluded from the default project's
// glob below so we don't try to run it under plain Node forks.
const r2BindingConformanceGlob =
  "packages/adapter-cloudflare/src/r2-binding-storage.conformance.test.ts";

// Companion randomized cascade entry — same project membership rules
// as the conformance glob above. Drives the shared
// `tests/fixtures/randomized-cascade.ts` driver against the miniflare
// R2 binding so the four-adapter randomized matrix is closed (memory
// / local-fs / node-minio live in the default project, cloudflare-r2
// lives here).
const r2BindingRandomizedGlob = "packages/adapter-cloudflare/src/randomized.test.ts";

// Companion table-API cascade entry — same project membership rules
// as the two globs above. Drives the shared
// `tests/fixtures/table-api-cascade.ts` driver against the miniflare
// R2 binding so the four-adapter table-API matrix is closed (memory
// / local-fs / node-minio live in `tests/integration/table-api.test.ts`,
// cloudflare-r2 lives here).
const r2BindingTableApiGlob = "packages/adapter-cloudflare/src/table-api.test.ts";

// `baerlyWorker()`'s fetch + scheduled tests — exercises the Cron
// Trigger plumbing and the Phase-6 CRUD route fan-out against the
// miniflare R2 binding. Same project membership rules as the three
// globs above. Glob is `worker*.test.ts` so both `worker.test.ts`
// (scheduled handler) and `worker-routes.test.ts` (CRUD routes) are
// picked up by the `cloudflare-pool` project.
const cfWorkerTestGlob = "packages/adapter-cloudflare/src/worker*.test.ts";

// Read-path Cache API integration tests — runs `caches.default`
// inside Workerd / miniflare. Same project membership rules as the
// globs above.
const cfCacheTestGlob = "packages/adapter-cloudflare/src/cache.test.ts";

// HTTP conformance cascade (Workerd variant). Hits `SELF.fetch`,
// which invokes the worker module pointed at by `cloudflareTest({
// main: ... })` below — `tests/setup/http-conformance-worker.ts`.
// The Node-side variants live at
// `tests/integration/http-conformance.test.ts` and run under the
// default project. Membership rules match the four globs above.
const cfHttpConformanceGlob = "packages/adapter-cloudflare/src/http-conformance.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "default",
          include: [
            "src/**/*.test.ts",
            "tests/**/*.test.ts",
            "packages/*/src/**/*.test.ts",
            // Example apps' top-level smoke tests (no infra deps).
            // Their internal source globs stay out — examples are
            // illustrative, not part of the protocol suite.
            "examples/*/smoke.test.ts",
            // Bench unit tests (bench/storage.test.ts and any future
            // bench-colocated tests). Bench scripts are not bundled
            // into the protocol output; this glob keeps them typechecked
            // and tested without widening the main source include.
            "bench/**/*.test.ts",
          ],
          exclude: [
            ...configDefaults.exclude,
            ...conformanceExclude,
            ...exportSmokeExclude,
            ...realDeployExclude,
            ...dayOneExclude,
            // CF adapter has its own project; don't double-run.
            r2BindingConformanceGlob,
            r2BindingRandomizedGlob,
            r2BindingTableApiGlob,
            cfWorkerTestGlob,
            cfCacheTestGlob,
            cfHttpConformanceGlob,
          ],
          setupFiles: ["tests/setup/fast-check.ts"],
          // Process isolation. Vitest 4's default `pool: 'threads'` with
          // `isolate: true` rebuilds the module graph for every test file
          // inside a worker thread; the per-file setup overhead starves
          // `randomized.test.ts`'s tight 5ms polling loop when the suite
          // grows. Forks have process-level isolation with no rebuild
          // overhead per file, and the wall-clock cost of forking is
          // amortized across the suite's reload time.
          pool: "forks",
          // Uint8Array.{toBase64,fromBase64} are TC39 Stage 4 but still gated
          // behind --js-base-64 in current V8 (Node 24 / V8 13.6). Drop this
          // once Node ships the methods unflagged.
          execArgv: ["--js-base-64"],
          // Default truncates assertion diffs at ~40 chars — useless for
          // fast-check shrinking failures on document trees. Full diffs only
          // print on failure, so log size is bounded.
          chaiConfig: { truncateThreshold: 0 },
        },
      },
      {
        // `cloudflareTest()` (a Vite plugin) registers itself as the
        // project's `poolRunner`, so `pool:` and `execArgv:` are not
        // set here — Workerd ignores Node V8 flags like `--js-base-64`
        // anyway.
        plugins: [
          cloudflareTest({
            // `main` points at the worker module wired into miniflare
            // as the `SELF` binding — the HTTP-conformance Workerd
            // variant (`packages/adapter-cloudflare/src/http-conformance.test.ts`)
            // calls `SELF.fetch(req)` to drive the full Phase-6 CRUD
            // surface through `baerlyWorker({ verifier: testVerifier() })`.
            // The other cloudflare-pool tests don't reference `SELF`,
            // so wiring a `main` for them is a no-op.
            main: "tests/setup/http-conformance-worker.ts",
            // Inline miniflare config — no separate `wrangler.toml`.
            // The binding name `BUCKET` matches what
            // `packages/adapter-cloudflare/src/r2-binding-storage.ts`
            // documents and what `tests/setup/r2-binding.ts` reads
            // back via `env.BUCKET`. `APP` + `TENANT` env vars are
            // consumed by `baerlyWorker.fetch`; `TENANT` is ignored
            // when a `verifier` is supplied (which the conformance
            // worker does), but miniflare requires the bound name to
            // exist on the env shape.
            miniflare: {
              r2Buckets: ["BUCKET"],
              bindings: { APP: "http-conf", TENANT: "" },
              compatibilityDate: "2025-01-01",
              compatibilityFlags: ["nodejs_compat"],
            },
          }),
        ],
        test: {
          name: "cloudflare-pool",
          include: [
            r2BindingConformanceGlob,
            r2BindingRandomizedGlob,
            r2BindingTableApiGlob,
            cfWorkerTestGlob,
            cfCacheTestGlob,
            cfHttpConformanceGlob,
          ],
          // `tests/setup/r2-binding.ts` runs inside Workerd, imports
          // from `cloudflare:test`, and re-publishes `env.BUCKET` on
          // `globalThis.__BAERLY_R2_BINDING__` for the conformance
          // factory to consume.
          //
          // `tests/setup/fast-check.ts` is also loaded so
          // `FC_NUM_RUNS` keeps working inside the Workers pool.
          setupFiles: ["tests/setup/fast-check.ts", "tests/setup/r2-binding.ts"],
          chaiConfig: { truncateThreshold: 0 },
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**", "packages/*/src/**"],
      exclude: ["**/*.test.ts", "**/dist/**"],
      reporter: ["text", "html"],
    },
  },
});
