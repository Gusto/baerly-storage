import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { formatBundleSizeLine } from "../helpers/bundle-size-report.ts";

// Bundle weight matters because this lib ships into a user's app
// bundle — every byte we add is a byte they pay. To keep barrel
// consumers from paying for code they don't reach, we split the
// surface across subpath entrypoints (`baerly-storage/auth`,
// `baerly-storage/http`, `baerly-storage/maintenance`,
// `baerly-storage/observability`) and budget each entrypoint's
// transitive closure independently.
//
// The barrel (`baerly-storage`) carries the kernel surface (`Db`,
// `Writer`, query/table helpers, schema, indexes) plus the
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
  // Full barrel: kernel + http + auth. Maintenance entry points
  // (runGc, rebuildIndex, migrateCollection) are exported from
  // index.js and carry the observability subgraph with them.
  // `prettyConsoleSink` + picocolors no longer ship in
  // `@baerly/server` — the kernel's `configureObservability` only
  // accepts `"console-json"` or a `Sink` function; the pretty sink
  // now lives in `@baerly/adapter-node`.
  // Budget history:
  //   100 KiB gz (initial)
  //   → 103680 B gz: canonical-line renderer upgrade (picocolors +
  //     renderCanonical helpers in prettyConsoleSink).
  //   → 103 KiB gz: observability `summarize()` `_total` dedup
  //     (`fe4aa18`) — the namespace-aware suffix gate added ~24 bytes
  //     to the bundled path.
  //   → 101 KiB gz: pretty sink + picocolors moved behind a dynamic
  //     import (`logger-pretty.ts` chunk).
  //   → 388 KiB raw / 112 KiB gz: protocol re-exports widened to
  //     include MemoryStorage + InMemoryMetricsRecorder + Storage
  //     result types + Verifier (curated 11-symbol public surface
  //     on @baerly/server's barrel); MemoryStorage value export
  //     lands in the static closure.
  //   → 349 KiB raw / 101 KiB gz: `renderDevLanding` /
  //     `DevLandingOptions` moved from the kernel barrel to
  //     `@baerly/dev` (the dev-only HTML helper is now reached
  //     from the adapters' `opts.dev` branches via @baerly/dev,
  //     which is sideEffects:false so production consumers
  //     tree-shake the LocalFsStorage + vite-plugin + picocolors
  //     subgraph).
  //   → 349 KiB raw / 101 KiB gz: pretty sink + picocolors moved
  //     out of `@baerly/server` to `@baerly/adapter-node` entirely
  //     (no dynamic-import chunk in the kernel either).
  //   → 350 KiB raw / 101 KiB gz: obs cleanup increment —
  //     `flushUnauthorizedAndRespond` (185350a) and the nesting-aware
  //     `withObservability` guard (46cdd65) added ~37 B raw, pushing
  //     the closure past the prior 349 KiB ceiling. gz unchanged.
  //   → 351 KiB raw / 101 KiB gz: `withHttpObservability`
  //     extraction (e56594a) moved the request-boundary middleware
  //     out of router.ts and into canonical.ts as a reusable helper,
  //     and added `reconstructErrorFromEnvelope` so the canonical
  //     line still carries `{ code, message }` outside Hono's
  //     compose chain. Net for the index closure: router chunk
  //     shrank and obs chunk grew slightly more, +339 B raw. gz
  //     unchanged.
  //   → 352 KiB raw / 101 KiB gz: adding
  //     `baerly-storage/cloudflare` + `baerly-storage/node`
  //     subpath entries caused rolldown to re-split shared chunks,
  //     pulling ~787 bytes more code into the index.js static
  //     closure.
  //   → 354 KiB raw / 103 KiB gz: adding client, client-react,
  //     client-testing, dev, dev-vite, export, maintenance, and
  //     observability subpath entries caused rolldown to re-split
  //     shared chunks again, pulling ~1093 more bytes into the
  //     index.js static closure. Measured post-rebase onto the
  //     2026-05-18 main: 361611 raw / 104537 gz.
  //   → 357 KiB raw / 103 KiB gz: client-terminals-silently-lie
  //     follow-up. Router grew by ~2.3 KB raw to land three wire-
  //     correctness fixes (`?order=`/`?limit=` threading + `parseOrder`
  //     / `parseLimit`; `PUT /v1/t/:table/:id` for true replace;
  //     `GET /v1/count` scalar route). gz unchanged.
  { entry: "index.js", raw: 357 * 1024, gz: 103 * 1024 },
  // The three auth verifier factories (bearerJwt, sharedSecret,
  // cloudflareAccess) plus the transitive jose closure pulled in by
  // bearerJwt's createRemoteJWKSet + jwtVerify. Adding a fourth
  // verifier grows this budget, not the kernel's.
  // Budget history:
  //   34 KiB raw / 12 KiB gz (initial — hand-rolled WebCrypto JWT).
  //   → 53 KiB raw / 15 KiB gz: replace hand-rolled JWT/JWKS with
  //     `jose` (bearer-jwt.ts 444 → ~80 LoC; createRemoteJWKSet +
  //     jwtVerify preserve the kid-miss rate-limit via
  //     cooldownDuration:60_000).
  { entry: "auth.js", raw: 53 * 1024, gz: 15 * 1024 },
  // `BaerlyAppConfig` types + the identity `defineConfig` helper.
  // No runtime closure — the types erase entirely and the function
  // is `<C>(c: C) => c`. Measured: 162 raw / 141 gz. Budget is a
  // sensible floor (1 KiB raw / 512 B gz) since the actual bytes
  // are dominated by the source-map preamble and `export` keyword.
  { entry: "app-config.js", raw: 1024, gz: 512 },
  // hono/tiny-backed HTTP router + long-poll/since helpers +
  // observability middleware. Observability is load-bearing at
  // every request boundary (canonical-line emission,
  // structured logging, per-request metrics), so the request
  // path carries an observability baseline cost that can't be
  // shifted to a subpath. ~272 KiB raw.
  // Budget history:
  //   → 274 KiB raw / 79 KiB gz: `withHttpObservability` extraction
  //     (e56594a) moved the middleware out of router.ts into
  //     canonical.ts; the http closure still sees both chunks so
  //     the router shrinkage mostly offsets the obs growth (+317
  //     B raw net). gz unchanged.
  //   → 276 KiB raw / 80 KiB gz: adding 6 new subpath entries
  //     (client, dev, export, etc.) caused rolldown to re-split
  //     shared chunks, pulling ~397 more bytes into http.js closure.
  //     Measured post-rebase onto 2026-05-18 main: 282102 raw /
  //     81562 gz.
  //   → 279 KiB raw / 81 KiB gz: client-terminals-silently-lie
  //     follow-up. New `PUT /v1/t/:table/:id` (true replace) +
  //     `GET /v1/count` routes, plus `parseOrder` / `parseLimit` for
  //     wired order/limit query params. +2413 raw / +544 gz.
  { entry: "http.js", raw: 279 * 1024, gz: 81 * 1024 },
  // Observability primitives — ObservabilityContext, the
  // request-scoped MetricsRecorder, LogTape config + the
  // JSON sink only (the pretty sink + picocolors now live in
  // `@baerly/adapter-node`), canonical line flush, observableStorage
  // decorator. LogTape itself accounts for the bulk.
  // Budget history:
  //   → 89 KiB raw / 24 KiB gz: `flushUnauthorizedAndRespond`
  //     pulls `errorEnvelope` (+ its `HttpErrorEnvelope` type)
  //     from contract.ts into the observability closure (~170 B raw).
  //   → 92 KiB raw / 25 KiB gz (current): `withHttpObservability`
  //     extraction (e56594a) landed the standalone-use request
  //     wrapper plus `reconstructErrorFromEnvelope` in canonical.ts.
  //     The obs closure (which excludes the router chunk) sees only
  //     the growth side: +2046 B raw / +101 B gz vs. the prior
  //     budget. The matching shrinkage lives in the router chunk
  //     and shows up as a near-wash in the http.js / index.js
  //     closures.
  //   → 93 KiB raw / 25 KiB gz: s3HttpStorage moved out of
  //     `@baerly/protocol` into `@baerly/adapter-node`. The protocol
  //     kernel barrel no longer pulls s3-http co-located code, which
  //     reshuffles chunk-layout: `BaerlyError` now lives in its own
  //     `errors-*.js` chunk (~2 KiB) and rolldown wires that chunk
  //     into the observability closure (canonical-line + envelope
  //     paths reach `BaerlyError`). Measured: 95099 raw / 25286 gz.
  //     +891 B raw / +144 B gz vs. the prior budget — bump raw by
  //     1 KiB to absorb the chunk-layout side effect.
  { entry: "observability.js", raw: 93 * 1024, gz: 25 * 1024 },
  // Maintenance loop — compactor + GC + sweep driver. Pulls
  // compactor.ts + gc.ts + the observability subgraph
  // transitively (every work unit runs under withObservability).
  // Operator-side; not part of the kernel barrel as of T01.
  // ~142 KiB raw.
  // Budget history:
  //   → 157 KiB raw / 44 KiB gz: InMemoryMetricsRecorder added to
  //     @baerly/server's curated protocol re-exports; marginal cost
  //     from the recorder class landing in the maintenance closure.
  //   → 185 KiB raw / 51 KiB gz: kernel-cleanup (A4 + B22) moved
  //     `rebuildIndex` and `migrateCollection` off the top-level
  //     barrel and onto `baerly-storage/maintenance`. The two
  //     primitives plus their walkLogRange dependency widen the
  //     maintenance closure by ~28 KiB raw / 7 KiB gz; the matching
  //     shrinkage lands in the index.js closure.
  { entry: "maintenance.js", raw: 185 * 1024, gz: 51 * 1024 },
  // Cloudflare Workers adapter — re-exports the kernel barrel
  // (Db, Writer, etc.) plus the R2-binding `Storage` impl
  // and the `baerlyCloudflare` helper. Aggregator: closure
  // includes index.js + http.js subgraphs since adapters re-export
  // those for one-stop consumer imports.
  // Budget history:
  //   → 433 KiB raw / 127 KiB gz: initial budget set in T9 based on
  //     post-T8 measurement (427 KiB raw / 125 KiB gz); margin sized
  //     for ordinary chunk-graph shifts.
  //   → 434 KiB raw / 128 KiB gz: lint-tighten adopted 13 style rules
  //     (curly braces, no-nested-ternary helper extraction). Measured
  //     442393 raw / 130174 gz; bumped 1 KiB on each axis.
  //   → 436 KiB raw / 128 KiB gz: client-terminals-silently-lie
  //     follow-up. Router additions reach the aggregator closure
  //     (PUT/GET-count routes + order/limit threading). +811 raw, gz
  //     unchanged.
  //   → 340 KiB raw / 100 KiB gz: unify-baerly-storage F1 follow-up.
  //     `S3HttpStorage` is no longer re-exported from the CF
  //     aggregator — R2-only consumers no longer carry the `aws4fetch`
  //     SigV4 client + `@xmldom/xmldom` parser into their Worker
  //     closure. Cross-cloud / cross-account R2 consumers now import
  //     `S3HttpStorage` directly from `baerly-storage/node`. Measured:
  //     347593 raw / 102077 gz — −97 KiB raw / −26 KiB gz.
  { entry: "cloudflare.js", raw: 340 * 1024, gz: 100 * 1024 },
  // Node adapter — re-exports the kernel barrel plus
  // `s3HttpStorage`, `localFsStorage`, `memoryStorage`,
  // `localCacheStorage`, and the `baerlyNode` Fetch-API factory.
  // Aggregator: same shape as cloudflare.js.
  // Budget history:
  //   → 410 KiB raw / 120 KiB gz: initial budget set in T9 based on
  //     post-T8 measurement (405 KiB raw / 118 KiB gz).
  //   → 413 KiB raw / 120 KiB gz: client-terminals-silently-lie
  //     follow-up. Router additions reach the aggregator closure
  //     (PUT/GET-count routes + order/limit threading). +2092 raw, gz
  //     unchanged.
  //   → 413 KiB raw / 121 KiB gz: export-package-collapse follow-up.
  //     Dropping the `export` entry from rolldown.config.ts reshuffles
  //     shared-chunk boundaries (one less entry → different
  //     code-splitting pivot); raw closure actually shrank (421908
  //     measured) but gz crept up to 123044. Bump the gz ceiling 1 KiB
  //     to absorb the chunk-layout side effect.
  //   → 426 KiB raw / 125 KiB gz: hono-node-server pivot. Replaced the
  //     hand-rolled Node↔Fetch bridge (handle/readNodeStream/
  //     toFetchRequest/isClientDisconnect/serveStaticAsset, ~400 LOC)
  //     with `@hono/node-server`'s `serve()` + a Hono-middleware
  //     composition (`createApp`). The library's listener chunk lands
  //     in the closure; deletion of the body-cap middleware (it raced
  //     with the library's own `incoming` reader; kernel router's
  //     defence-in-depth is now the only mechanism, matching the
  //     cloudflare adapter) trims a few hundred bytes back. Measured:
  //     433698 raw / 125904 gz.
  //   → 720 KiB raw / 200 KiB gz: `@xmldom/xmldom` + `aws4fetch` now
  //     bundle into the library entries that use them (previously
  //     externalised, then declared as optional peerDeps which pnpm
  //     skips on install — scaffolded apps died with `Cannot find
  //     package '@xmldom/xmldom'` on first `vite` load). The S3 client
  //     subgraph (DOMParser + SigV4 signer) now lands in `dist/node.js`
  //     directly. Cold-start cost only; consumer-bundler-irrelevant.
  //     Measured: 676293 raw / 187995 gz.
  { entry: "node.js", raw: 720 * 1024, gz: 200 * 1024 },
  // Client surface — `BaerlyClient<TConfig>` + fetcher plumbing.
  // Browser/runtime-agnostic; no kernel modules in the closure.
  // Budget history:
  //   → 14 KiB raw / 6 KiB gz: initial budget set in T9 based on
  //     post-T8 measurement (9 KiB raw / 4 KiB gz).
  { entry: "client.js", raw: 14 * 1024, gz: 6 * 1024 },
  // React bindings for `BaerlyClient` (provider + hooks). React
  // itself is external, so the closure stays tiny.
  // Budget history:
  //   → 13 KiB raw / 5 KiB gz: initial budget set in T9 based on
  //     post-T8 measurement (8 KiB raw / 3 KiB gz).
  //   → 16 KiB raw / 6 KiB gz: client-hooks-api-shape follow-up.
  //     Added <BaerlyProvider> + useBaerlyClient and the
  //     useInsert / useUpdate / useReplace / useDelete mutation
  //     hook trio over a shared `useMutation` primitive. Read
  //     hooks switched from positional args to options-bag (no
  //     `client` arg — read from context). Measured: 15268 raw /
  //     4769 gz.
  { entry: "client-react.js", raw: 16 * 1024, gz: 6 * 1024 },
  // Testing helpers for `BaerlyClient` (in-memory fetcher etc.).
  // Vitest is external; closure is minimal.
  // Budget history:
  //   → 8 KiB raw / 4 KiB gz: initial budget set in T9 based on
  //     post-T8 measurement (3 KiB raw / 2 KiB gz).
  { entry: "client-testing.js", raw: 8 * 1024, gz: 4 * 1024 },
  // `@baerly/dev` surface — `LocalFsStorage`, `printDevBanner`,
  // `ensureTable`, `renderDevLanding`. NO longer an aggregator over
  // the kernel barrel: the only kernel surfaces these helpers touch
  // are pulled transitively by their own logic (e.g. `LocalFsStorage`
  // implements `Storage`, so it imports the kernel's `BaerlyError`
  // chunk). `baerlyDev` (the Vite plugin) is intentionally NOT
  // re-exported from this barrel — vite users import it from the
  // `baerly-storage/dev/vite` subpath instead, which keeps the vite
  // plugin closure out of consumers that only want `LocalFsStorage`
  // / `ensureTable` / `printDevBanner`.
  // Budget history:
  //   → 410 KiB raw / 120 KiB gz: initial budget set in T9 based on
  //     post-T8 measurement (405 KiB raw / 118 KiB gz).
  //   → 413 KiB raw / 120 KiB gz: client-terminals-silently-lie
  //     follow-up. Same router additions reach this aggregator's
  //     closure as well. +2003 raw, gz unchanged.
  //   → 413 KiB raw / 121 KiB gz: export-package-collapse follow-up.
  //     Same chunk-layout side effect as node.js — gz measured 123100.
  //   → 26 KiB raw / 10 KiB gz: unify-baerly-storage F3 follow-up.
  //     `baerlyDev` (the Vite plugin) dropped from the barrel. The
  //     dev surface no longer pulls the vite-plugin closure, the
  //     kernel barrel, or hono — closure is now just LocalFsStorage
  //     + the banner / landing / ensure-table helpers + their tiny
  //     transitive subgraph. Measured: 26020 raw / 9561 gz —
  //     −388 KiB raw / −111 KiB gz.
  //   → 27 KiB raw / 10 KiB gz: ambient drift across the shared
  //     `current-json` / `errors` / `src-*` chunks the dev barrel
  //     pulls in. Measured: 26868 raw / 9952 gz — +848 raw, +391 gz
  //     since F3. Bump raw with a 1 KiB headroom; gz is still under
  //     the existing budget.
  { entry: "dev.js", raw: 27 * 1024, gz: 10 * 1024 },
  // `@baerly/dev/vite` — the `baerlyDev()` vite plugin (mounts the
  // Baerly HTTP listener as middleware inside a Vite dev server).
  // Vite is external. Aggregator: re-exports the dev surface.
  // Budget history:
  //   → 410 KiB raw / 120 KiB gz: initial budget set in T9 based on
  //     post-T8 measurement (404 KiB raw / 118 KiB gz).
  //   → 413 KiB raw / 120 KiB gz: client-terminals-silently-lie
  //     follow-up. Same router additions land here too. +1812 raw,
  //     gz unchanged.
  //   → 413 KiB raw / 121 KiB gz: export-package-collapse follow-up.
  //     Same chunk-layout side effect as node.js — gz measured 122950.
  //   → 429 KiB raw / 125 KiB gz: transitive jose closure via auth
  //     chunk after replacing hand-rolled JWT/JWKS. Rolldown's shared-
  //     chunk splitting threads the auth chunk into dev-vite's static
  //     closure too.
  //   → 476 KiB raw / 137 KiB gz: hono-node-server pivot on top of
  //     jose. The Vite dev plugin imports `createApp` (+ the
  //     `@hono/node-server` listener chunk) from adapter-node, so the
  //     dev-vite closure tracks the node.js bump. The jose + hono
  //     deltas stack — both auth and listener chunks land in the
  //     transitive closure. Measured: 485674 raw / 138557 gz.
  //   → 480 KiB raw / 138 KiB gz: ambient drift across the shared
  //     `auth` / `compactor` / `http` / `query` / `src-*` chunks that
  //     thread through dev-vite's closure. Measured on a clean main:
  //     489957 raw / 140341 gz (+4283 raw / +1784 gz since the hono-
  //     node-server bump). Bump leaves ~1.5 KiB raw / ~1 KiB gz of
  //     headroom.
  //   → 780 KiB raw / 215 KiB gz: dev-vite shares the adapter-node
  //     listener chunk, so the `@xmldom/xmldom` + `aws4fetch` self-
  //     containment (see the `node.js` budget note above) lands here
  //     too. Dev-only Node import — never enters a consumer bundle.
  //     Measured: 731315 raw / 201995 gz.
  { entry: "dev-vite.js", raw: 780 * 1024, gz: 215 * 1024 },
  // `baerly` CLI bin — `init`, `dev`, `deploy`, `doctor`, `inspect`,
  // `admin {compact,fsck,migrate,dump,restore,rebuild-index}`,
  // `export`. Bundled as a single file (no static chunk splits)
  // with a `#!/usr/bin/env node` shebang. Not a library entry —
  // bundling a CLI bin is concerns-separate from the library
  // subpath exports — but budgeted here so cold-start cost stays
  // observable.
  // Budget history:
  //   → 567 KiB raw / 159 KiB gz: initial budget set in T9 based on
  //     post-T8 measurement (562 KiB raw / 157 KiB gz). CLI carries
  //     the kernel + maintenance + export + clack subgraphs and
  //     transitive `tsx` shim — large by design.
  //   → 570 KiB raw / 159 KiB gz: client-terminals-silently-lie
  //     follow-up. CLI bundles the kernel barrel, which now carries
  //     the new HTTP routes + parseOrder/parseLimit. +2032 raw, gz
  //     unchanged.
  //   → 571 KiB raw / 159 KiB gz: adapter-collections-wiring landed
  //     `collectionsToMaps` (+ two frozen empty-map sentinels) on the
  //     server barrel for the adapter flatten path. +899 raw, gz still
  //     under budget. Dead code from the CLI's perspective but the
  //     CLI imports the barrel by design.
  //   → 590 KiB raw / 165 KiB gz: hono-node-server pivot. `baerly dev`
  //     mounts the adapter via `getRequestListener(createApp(opts).fetch)`,
  //     so the `@hono/node-server` listener chunk + Hono itself land in
  //     the single-file CLI bundle. Measured: 601911 raw / 168282 gz.
  { entry: "baerly.js", raw: 590 * 1024, gz: 165 * 1024 },
];

// Static-import specifiers only. Dynamic `import(...)` is intentionally
// excluded — code reachable only via dynamic import is a separate
// budget concern.
const STATIC_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^"']*?from\s*["']([^"']+)["']/g;

function collectClosure(entryAbs: string, seen: Set<string>): void {
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
      const rawLine = formatBundleSizeLine({
        entry,
        kind: "raw",
        measured: measured.raw,
        budget: raw,
        chunks: measured.files,
      });
      const gzLine = formatBundleSizeLine({
        entry,
        kind: "gz",
        measured: measured.gz,
        budget: gz,
        chunks: measured.files,
      });
      if (process.env["BUNDLE_SIZE_REPORT"]) {
        console.log(rawLine);
        console.log(gzLine);
      }
      expect(measured.raw, `${rawLine}`).toBeLessThanOrEqual(raw);
      expect(measured.gz, `${gzLine}`).toBeLessThanOrEqual(gz);
    });
  }

  // Scaffolded apps install only `baerly-storage`. `@xmldom/xmldom`
  // and `aws4fetch` are bundled into the published library + bin
  // chunks that use them (see `rolldown.config.ts` and
  // `packages/cli/rolldown.config.ts`); no dist closure may leave a
  // live `import "@xmldom/xmldom"` or `import "aws4fetch"` for the
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
  const BUNDLED_OPTIONAL_PEERS = new Set(["@xmldom/xmldom", "aws4fetch"]);
  const pkgRoot = resolve(__dirname, "../..");
  const distDir = resolve(pkgRoot, "dist");
  const rootPkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    exports?: Record<string, { import?: string }>;
  };
  const entries: string[] = [];
  for (const cond of Object.values(rootPkg.exports ?? {})) {
    if (cond.import?.endsWith(".js")) {
      entries.push(resolve(pkgRoot, cond.import));
    }
  }
  for (const binPath of Object.values(rootPkg.bin ?? {})) {
    entries.push(resolve(pkgRoot, binPath));
  }
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
            offenders.push(`${file.replace(`${distDir}/`, "")} → ${spec}`);
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
