import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
// min+gz numbers are esbuild-version-sensitive: a minifier version bump
// rebaselines every entry's `minGz` ceiling at once.
import { transformSync } from "esbuild";
import { describe, expect, test } from "vitest";
import { formatBundleSizeLine } from "../helpers/bundle-size-report.ts";

// Bundle weight matters because this lib ships into a user's app
// bundle — every byte we add is a byte they pay. To keep barrel
// consumers from paying for code they don't reach, we split the
// surface across subpath entrypoints (`@gusto/baerly-storage/auth`,
// `@gusto/baerly-storage/http`, `@gusto/baerly-storage/maintenance`,
// `@gusto/baerly-storage/observability`) and budget each entrypoint's
// transitive closure independently.
//
// The barrel (`baerly-storage`) carries the kernel surface (`Db`,
// `Writer`, query/table helpers, schema, indexes) plus the
// auth presets. Maintenance (`runScheduledMaintenance`, profile
// constants) and observability primitives are NOT on the barrel
// as of 2026-05 — operator-side code reaches them via their
// subpath entries.
//
// `http.js` carries a baseline observability cost that can't be
// shifted to a subpath: `packages/server/src/http/router.ts`
// directly calls `getLogger`/`CATEGORY` at the request boundary
// for structured logging. `index.js` pulls only the tiny
// `context.ts` chunk for the ALS lookup Writer/compactor/GC use
// to read the active per-request recorder — the full logtape
// subgraph stays out.
//
// Each entry is a static-import closure: rolldown code-splits shared
// modules into chunks, so importing `@gusto/baerly-storage/auth` actually
// pulls in `auth.js` + the auth chunk + a shared errors chunk. We
// budget the full transitive closure, not just the entry file, because
// that's what the consumer's bundler pulls in.
//
// Budgets cover THREE axes. The library ships UNMINIFIED (rolldown,
// no minify step), and a consumer's bundler re-minifies before it
// reaches production — so the unminified numbers are NOT what a
// consumer actually pays. They are regression DIFF DIAGNOSTICS; the
// minified axis is the consumer-facing cost:
//   - raw    — unminified bytes. A regression diagnostic + cold-start
//              CPU proxy (the isolate parses the un-gzipped script).
//   - gz     — gzip of the unminified bytes. Also a diagnostic: the
//              raw↔gz gap distinguishes duplicated boilerplate (gzip
//              dedups it, so raw climbs but gz barely moves) from
//              genuinely new code (both axes climb together). Not the
//              shipped cost — the consumer minifies first.
//   - min+gz — esbuild-minify each chunk, then gzip the concatenation.
//              This is the CONSUMER-FACING cost number: the closest
//              proxy to the artifact a consumer's bundler ships. It is
//              a CONSERVATIVE UPPER BOUND — per-chunk syntax minify
//              only, no cross-module tree-shaking / scope-hoisting — so
//              the real consumer cost is ≤ this number. See the note in
//              `measureClosure`.
// Only entries that declare `minGz` assert the third axis.
//
// Budgets are set to the smallest whole-KiB value (`N * 1024`) that
// clears the measured size with a small headroom (~1–2 KiB / ~0.5–1%),
// NOT the looser ~8–15% the earliest entries used — recent rebaselines
// sit just above measured so the ceilings stay honest. A failure here
// means the surface grew without an explicit budget bump — either
// justify it and raise the number, or refactor behind another subpath.
//
// The two big Node aggregators (`node.js`, `dev-vite.js`) carry no
// consumer-cost budget: they are server-side / dev-only and never enter
// a consumer's app bundle, so their wire size is a cost nobody pays (and
// the rolldown chunk graph carries ~120 KiB of run-to-run raw variance
// there). The real risk on those surfaces — a heavy runtime dep creeping
// into the closure — is instead guarded by TWO tests below: a bare-
// specifier allowlist (catches a dep regressing to a live external
// import) plus a deliberately-loose raw-creep tripwire (catches a heavy
// dep bundled inline, which the allowlist can't see).

// The `baerly` CLI bin is intentionally NOT budgeted. citty-cleanup
// lazy-loaded all 14 subcommands behind dynamic import, so the
// static-import closure this test measures is just the entry shim
// (~28 KiB) and tells nothing about what any subcommand actually
// pays at runtime. The CLI runs on developer machines or CI, never
// ships in a user app bundle, and Node startup dwarfs any sub-MB
// parse cost — so cold-start size here is not a useful signal. The
// `BUNDLED_OPTIONAL_PEERS` check further down still walks
// `dist/baerly.js` to catch live imports of `@xmldom/xmldom` /
// `aws4fetch` (the original agent-struggle #14 regression class);
// that's a behavioural guard, not a byte budget.

interface Budget {
  /** Entry filename under `dist/`. */
  entry: string;
  /** Max unminified bytes for the entry's transitive closure. */
  raw: number;
  /** Max gzipped bytes for the entry's transitive closure. */
  gz: number;
  /**
   * Max minified+gzipped bytes for the entry's transitive closure —
   * the consumer-facing artifact proxy. When set, the test minifies
   * each chunk with esbuild then gzips the concatenation, and asserts
   * the result stays under this ceiling.
   */
  minGz?: number;
  /**
   * Skip this entry's check pending follow-up. Tracked in
   * `docs/followups/first-touch-dx.md`.
   */
  skip?: boolean;
}

const BUDGETS: readonly Budget[] = [
  // Full barrel: kernel + http + auth. Maintenance entry points
  // (runGc, rebuildIndex) are exported from
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
  //     `@gusto/baerly-storage/cloudflare` + `@gusto/baerly-storage/node`
  //     subpath entries caused rolldown to re-split shared chunks,
  //     pulling ~787 bytes more code into the index.js static
  //     closure.
  //   → 354 KiB raw / 103 KiB gz: adding client, client-react,
  //     client-testing, dev, dev-vite, export, maintenance, and
  //     observability subpath entries caused rolldown to re-split
  //     shared chunks. `client-testing` later demoted to internal-
  //     only (no public subpath) — `dist/client-testing.{js,d.ts}`
  //     no longer ships, but the index.js closure cost stayed.
  //     shared chunks again, pulling ~1093 more bytes into the
  //     index.js static closure. Measured post-rebase onto the
  //     2026-05-18 main: 361611 raw / 104537 gz.
  //   → 357 KiB raw / 103 KiB gz: client-terminals-silently-lie
  //     follow-up. Router grew by ~2.3 KB raw to land three wire-
  //     correctness fixes (`?order=`/`?limit=` threading + `parseOrder`
  //     / `parseLimit`; `PUT /v1/c/:collection/:id` for true replace;
  //     `GET /v1/count` scalar route). gz unchanged.
  //   → 160 KiB raw / 50 KiB gz: snapshot-primitives
  //     extracted into `packages/server/src/snapshot.ts`; the kernel
  //     barrel re-exports them from there instead of `compactor.ts`, so
  //     the observability chunk no longer lands in the kernel closure.
  //     Measured: 150792 raw / 47342 gz.
  //   → 162 KiB raw / 51 KiB gz: predicate redesign. The wire-form
  //     migration adds `wire.ts` + `builder.ts` + `normalize.ts` +
  //     `satisfiable.ts` to the kernel closure (replacing the
  //     monolithic `validate.ts` / `merge.ts` / `matches.ts` that
  //     previously walked operator-object predicates). Net: more
  //     chunk-count, slightly more code (per-field-fold helpers).
  //     Measured: 165125 raw / 51476 gz.
  //   → 163 KiB raw / 51 KiB gz: pre-existing ambient drift across
  //     the `current-json` / `errors` / `query` / `snapshot` /
  //     `app-config` / `shared-secret` / `normalize` chunks the
  //     kernel barrel pulls in. Measured at react-hooks-collapse
  //     baseline: 166035 raw / 51758 gz — +910 raw vs. prior budget.
  //     Bump raw by ~1 KiB to absorb; gz is well under budget.
  //   → 163 KiB raw / 52 KiB gz: in-band-maintenance Task 1 + 1.5.
  //     CurrentJson schema v2 (`snapshot_bytes` /
  //     `snapshot_rows` / `last_warned_seq?`) widened the shared
  //     `current-json` chunk the kernel barrel pulls; gz crept +36 B
  //     over the prior 51 KiB budget. Raw is comfortably under.
  //     Measured: 166684 raw / 52260 gz. Bump gz by 1 KiB.
  //   → 200 KiB raw / 61 KiB gz: in-band-maintenance Task 2
  //     (2026-05-30). The write-tick hook makes `writer.ts` statically
  //     import `./maintenance.ts` (→ compactor.ts + gc.ts), so the
  //     maintenance subgraph is now part of every kernel-barrel
  //     closure (the write path genuinely depends on it). Measured:
  //     203193 raw / 62015 gz. INTERIM bump — a later in-band-
  //     maintenance task reconciles the net kernel/maintenance split.
  //   → 208 KiB raw / 63 KiB gz (2026-05-31, in-band-maintenance FINAL,
  //     Task 8 net reconciliation): the kernel write-tick hook
  //     (`writer.ts` → `maintenance.ts` → compactor.ts + gc.ts) makes the
  //     maintenance subgraph part of every kernel-barrel closure. Final
  //     measured: 211008 raw / 64304 gz. Net vs. the pre-maintenance
  //     baseline (166035 raw / 51758 gz, the predicate-redesign/ambient-
  //     drift measurement that predated Task 1): +44973 raw / +12546 gz.
  //     `index.js` has no `opts.maintenance` deletion offset to subtract
  //     (that cut was Node-adapter-only) — the kernel barrel growth is the
  //     gross add. Justified: in-band maintenance IS the kernel's core
  //     durability value (writes self-heal the bucket with no operator
  //     cron), the per-tick work is bounded by a static CPU/op ceiling, and
  //     the rejected sweep / `pending_gc` / lease designs were each LARGER
  //     than this static-ceiling shape. Owner-accepted (Decision D2:
  //     accept + rebaseline, lazy-load rejected as cosmetic for CF). gz
  //     (64304) still sits UNDER the prior 63 KiB ceiling, so it is left
  //     unchanged; only raw is rebaselined.
  //   → 209 KiB raw / 64 KiB gz (2026-05-31): two unrelated increments.
  //     (a) Base drift: the `S3-CAS is now enforced` main commit
  //     (63cbacd4) pushed the kernel-barrel gz closure to 64745 — already
  //     +233 over the prior 63 KiB ceiling before this change (shared-chunk
  //     re-split from the conformance/doctor work). (b) This change: the
  //     UTF-8 byte-order key comparator in `MemoryStorage` (shipped in the
  //     kernel barrel) plus shared-chunk re-splitting. Measured: 213028 raw
  //     / 65102 gz. Bump raw to 209 KiB, gz to 64 KiB.
  //   → 210 KiB raw / 65 KiB gz (2026-06-01): layout-version-cordon —
  //     reserved-`_` namespace (`names.ts` + call sites) + tolerant-reader
  //     contract JSDoc on `assertCurrentJson`/`IndexDefinition`. Comments
  //     are NOT stripped from the shipped bundle, so the contract docs cost
  //     bytes on both axes (measured 214669 raw / 65783 gz). gz was already
  //     +2 over the prior 64 KiB ceiling on main (pre-existing drift) and
  //     this change widened it. Rebaseline raw +1 KiB and gz +1 KiB
  //     (owner-accepted; user chose rebaseline). See docs/adr/007-layout-versioning-cordon.md.
  //   → +min+gz axis 19 KiB (2026-06-01): consumer-facing artifact proxy
  //     baselined / measured 17980. See the file header on what min+gz is.
  //   → 212 KiB raw (2026-06-14): maintenance-profile consolidation —
  //     two new exported `MAINTENANCE_PROFILE_*` constant objects in
  //     constants.ts (shared kernel chunk) + the `MaintenanceProfile` type
  //     and `profileToScheduledOptions` helper in maintenance.ts. The
  //     constant VALUES are load-bearing (one source of truth for the
  //     adapter/runner budgets) and comments aren't stripped, so this costs
  //     ~1.5 KiB raw (measured 216561). gz/min-gz unaffected (still passing).
  //     Rebaseline raw +2 KiB.
  //   → 213 KiB raw / 66 KiB gz (2026-06-14): caller-supplied `_id`
  //     boundary guard — the new `doc-id.ts` leaf module (`assertDocId`)
  //     is reached from `query.ts`'s `runInsert` / `runReplaceById`, both
  //     on the kernel barrel closure. This is genuinely new code (raw AND
  //     gz both climb, not dedup-able boilerplate): ~400 B raw / ~226 B gz
  //     over the prior ceilings (measured 217490 raw / 66786 gz). min-gz
  //     still passes. Rebaseline raw +1 KiB, gz +1 KiB.
  //   → 214 KiB raw / 67 KiB gz: single-write commit (2026-06-15) — writer
  //     forward-probe + galloping findLogTail + maintenance observed-tail
  //     plumbing (measured 218832 raw / 67692 gz). min-gz under.
  //   → 215 KiB raw (2026-06-15): single-write-commit doc accuracy pass —
  //     rewrote the now-stale Writer class docstring + density-precondition
  //     notes (comments ship un-stripped). +27 B raw over the prior ceiling
  //     (measured 219163). gz/min-gz unaffected. Rebaseline raw +1 KiB only.
  //   → 216 KiB raw (2026-06-16): own-session adoption now rejects a
  //     same-session/same-seq occupant unless the read-back log entry exactly
  //     matches the writer's attempted entry. Closes the session-collision
  //     data-loss path. Measured 220302 raw; gz/min-gz remain under.
  //   → 219 KiB raw / 69 KiB gz (2026-06-16): gc/pending.json CAS-merge fix
  //     (`casUpdateGcPending` retry loop + the pure `mergeGcPending` mutator,
  //     plus the bounded live-log scan) joins the maintenance subgraph this
  //     barrel pulls. Genuinely new logic — both axes climb (measured 224105
  //     raw / 69699 gz); min-gz still under. Rebaseline raw + gz to the
  //     smallest whole-KiB that clears.
  //   → raw +2 KiB (2026-06-22): CLOUDFLARE_PAID_TIER constant + JSDoc (~23 lines)
  //     in maintenance.ts lands in the protocol/maintenance shared chunk; comments
  //     ship un-stripped.
  //   → raw −1 KiB (2026-06-23): trimmed the duplicated @example recipe from the
  //     CLOUDFLARE_PAID_TIER JSDoc (kept a terse pointer); reclaims one of the two
  //     KiB above (measured 225667 raw). The constant's code holds the other KiB.
  //   → raw −1 KiB / gz −1 KiB (2026-06-24): W4-5 bundle hygiene — moved the 3
  //     RESOLUTION constants out of constants.ts into a zero-import leaf
  //     (auth-resolution.ts), eliminating the constants chunk from closures that
  //     only need the resolution strings. Trimmed verbose JSDoc in errors.ts +
  //     contract.ts. Measured: 226812 raw / 70586 gz.
  //   → gz −1 KiB (2026-06-24): WS4.1 T5 A1 JSDoc trim (CODE_RESOLUTIONS comment)
  //     shed bytes from the index closure; tighten gz to the smallest KiB that clears.
  //     Measured: 70586 gz (69*1024 = 70656 ≥ 70586). // WS4.1
  //   → gz +1 KiB (2026-06-24): the 69 KiB line did not reproduce on a clean build
  //     (measured 70712 gz, +56 over), and the `retriable`/resolution metadata is
  //     worth the bytes. Rebaseline gz to 70 KiB rather than golf source to fit.
  //     POLICY: min-gz is the hard ceiling — it is the real shipped-to-browser cost
  //     after a consumer bundler minifies (stripping the un-stripped JSDoc and
  //     mangling locals that this unminified-gz axis still counts). Treat raw/gz as
  //     creep tripwires, NOT hard limits; do not trim explanatory comments or golf
  //     identifiers to satisfy them. min-gz here is 19104 / 19456 (−352, healthy).
  { entry: "index.js", raw: 222 * 1024, gz: 70 * 1024, minGz: 19 * 1024 },
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
  //   → 54 KiB raw / 15 KiB gz: add `tenantPrefix?: string` override
  //     to bearerJwt + cloudflareAccess (validation branch + error
  //     messages + fixed-prefix short-circuit in the inner verifier).
  //     Closes the single-tenant CF Access gap where vanilla JWTs
  //     ship `sub`/`email` but no `tenant` claim. Measured: 54746 raw.
  //   → +min+gz axis 10 KiB (2026-06-01): consumer-facing artifact proxy
  //     baselined / measured 8909.
  //   → raw +1 KiB (2026-06-24): RETRIABLE_CODES + isRetriableCode + BaerlyError.retriable
  //     getter in errors.ts; JSDoc ships un-stripped (measured 55803 raw).
  //   → raw +2 KiB / gz +1 KiB (2026-06-24): 3 resolution string constants in
  //     constants.ts dragged the whole constants chunk into auth's closure
  //     (measured 67752 raw / 19398 gz). WS4 anti-pattern: constants chunk
  //     has ~10 KiB of heavy kernel-tuning JSDoc unused by auth.
  //   → raw −10 KiB / gz −4 KiB (2026-06-24): W4-5 bundle hygiene — moved the 3
  //     RESOLUTION constants to zero-import leaf auth-resolution.ts; constants chunk
  //     no longer in auth closure. Trimmed verbose JSDoc. Measured: 57120 raw /
  //     15182 gz / 9164 min-gz.
  { entry: "auth.js", raw: 56 * 1024, gz: 15 * 1024, minGz: 9 * 1024 },
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
  //     follow-up. New `PUT /v1/c/:collection/:id` (true replace) +
  //     `GET /v1/count` routes, plus `parseOrder` / `parseLimit` for
  //     wired order/limit query params. +2413 raw / +544 gz.
  //   → 282 KiB raw / 82 KiB gz: pre-existing ambient drift on the
  //     http router closure. Measured at react-hooks-collapse
  //     baseline: 287961 raw / 83315 gz — +910 raw vs. prior budget.
  //     Bump raw by ~1 KiB; gz is well under budget.
  //   → 281 KiB raw / 82 KiB gz: predicate redesign. The wire-form
  //     normaliser + validator + matcher + per-field satisfiability
  //     check thread into the router closure (via `parseWhereParam`,
  //     `runRead`, `runAllWithMeta`). The merger isn't directly
  //     imported here, but `mergePredicateWires` reaches the closure
  //     via the kernel `Query.where` seam. Measured: 287051 raw /
  //     83035 gz.
  //   → 312 KiB raw / 91 KiB gz: in-band-maintenance Task 2
  //     (2026-05-30). `writer.ts` now statically imports
  //     `./maintenance.ts` for the write-tick dispatch, pulling the
  //     compactor + GC subgraph into the http closure (the Writer is
  //     on the request path). Measured: 318946 raw / 93115 gz. INTERIM
  //     bump — a later in-band-maintenance task reconciles the net.
  //   → 321 KiB raw / 95 KiB gz (2026-05-31, in-band-maintenance FINAL,
  //     Task 8 net reconciliation): `writer.ts` statically imports
  //     `./maintenance.ts` for the write-tick dispatch, so the compactor +
  //     GC subgraph lands in the http closure (the Writer is on the request
  //     path). Final measured: 326761 raw / 95564 gz. Net vs. the pre-
  //     maintenance baseline (287051 raw / 83035 gz, predicate-redesign
  //     measurement): +39710 raw / +12529 gz. No `opts.maintenance`
  //     deletion offset applies here (that cut was Node-adapter-only).
  //     Justified: same as index.js — in-band maintenance is core kernel
  //     value, statically bounded, smaller than the rejected sweep/
  //     pending_gc/lease designs. Owner-accepted (Decision D2).
  //   → 322 KiB raw / 95 KiB gz (2026-06-01): layout-version-cordon. The
  //     tolerant-reader contract JSDoc on `assertCurrentJson` (in the http
  //     closure) ships un-stripped. Measured 328788 raw / 96357 gz — gz is
  //     comfortably UNDER the 95 KiB ceiling; only raw crosses (+84 over the
  //     prior 321 KiB). Rebaseline raw +1 KiB. See docs/adr/007-layout-versioning-cordon.md.
  //   → +min+gz axis 34 KiB (2026-06-01): consumer-facing artifact proxy
  //     baselined / measured 33029.
  //   → 324 KiB raw (2026-06-14): caller-supplied `_id` boundary guard.
  //     `doc-id.ts` (`assertDocId`) reaches the http closure via
  //     `runInsert` / `runReplaceById` on the request path. ~1.2 KiB raw
  //     (measured 330945); gz/min-gz still pass. Rebaseline raw +2 KiB.
  //   → 325 KiB raw / 96 KiB gz (2026-06-15): the read-tail forward-probe
  //     (`log-tail.ts`, single-write-commit Plan B) reaches the http
  //     closure via `runRead` (query) + `/v1/since` (measured 331794 raw /
  //     97702 gz). Rebaseline raw +1 KiB, gz +1 KiB; min-gz still passes.
  //   → 326 KiB raw (2026-06-15): `estimateTailBytes` + the
  //     `MAINTENANCE_COLD_START_ENTRY_BYTES` constant (single-write-commit
  //     Plan B, ratio-trigger derived tail estimate) reach the http closure
  //     via the maintenance subgraph (measured 333048 raw; +248 over). Bump
  //     raw +1 KiB; gz/min-gz comfortably under.
  //   → 97 KiB gz (2026-06-15): the load-bearing adoption-precondition
  //     JSDoc on `tryAdoptOwnSessionLogEntry` (single-write-commit Plan B)
  //     ships un-stripped into the http closure (measured 98361 gz; +57
  //     over). Bump gz +1 KiB; raw/min-gz still pass.
  //   → 327 KiB raw: single-write commit (2026-06-15) — writer/maintenance
  //     forward-probe plumbing (measured 334509 raw). gz/min-gz under.
  //   → 328 KiB raw (2026-06-15): single-write-commit doc accuracy pass —
  //     the corrected maintenance-runner comment ships un-stripped into this
  //     closure via the maintenance subgraph. +15 B raw over the prior
  //     ceiling (measured 334863). gz/min-gz under. Rebaseline raw +1 KiB.
  //   → 329 KiB raw (2026-06-16): same adoption exact-entry guard as
  //     index.js reaches the request-path writer closure. Measured 336002
  //     raw; gz/min-gz remain under.
  //   → 98 KiB gz (2026-06-16): single-write-commit edge-case hardening
  //     (writer/maintenance/log-tail) lands in the request-path closure
  //     (measured 99362 gz; +34 over the 97 KiB ceiling). Bump gz +1 KiB;
  //     raw/min-gz still pass.
  //   → 332 KiB raw / 99 KiB gz (2026-06-16): gc/pending.json CAS-merge fix
  //     (`casUpdateGcPending` retry loop + the pure `mergeGcPending` mutator,
  //     plus the bounded live-log scan) reaches this closure via the
  //     request-path writer → maintenance subgraph. Genuinely new logic —
  //     both axes climb (measured 339734 raw / 100780 gz); min-gz still under.
  //     Rebaseline raw + gz to the smallest whole-KiB that clears.
  //   → raw +1 KiB (2026-06-22): CLOUDFLARE_PAID_TIER constant + JSDoc in
  //     maintenance.ts lands in the request-path writer → maintenance closure
  //     (measured 341936 raw); gz/min-gz unaffected.
  //   → gz +1 KiB (2026-06-24): RETRIABLE_CODES + isRetriableCode + BaerlyError.retriable
  //     getter in errors.ts (measured 101414 gz).
  //   → raw −2 KiB / gz −1 KiB (2026-06-24): W4-5 bundle hygiene — constants chunk no
  //     longer in http closure (moved RESOLUTION constants to zero-import leaf; JSDoc trim).
  //     Measured: 341579 raw / 101395 gz / 34178 min-gz.
  //   → raw +1 KiB (2026-06-24): WS4.1 T1 CODE_RESOLUTIONS + WHERE_ORDER/WRITE_BODY strings
  //     reach http.js via the protocol barrel → errorEnvelope. Measured: 342699 raw.
  //   → raw +1 KiB (2026-06-24): WS4.1 T2 WHERE_ORDER/WRITE_BODY_SHAPE_RESOLUTION wired into
  //     router.ts throw sites (7 new resolution strings inline). Measured: 343596 raw.
  { entry: "http.js", raw: 336 * 1024, gz: 100 * 1024, minGz: 34 * 1024 },
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
  //   → 91 KiB raw / 25 KiB gz (2026-05-31, in-band-maintenance FINAL,
  //     Task 8): the observability subpath is unaffected by the
  //     maintenance pull (no `maintenance-*.js` in its closure).
  //     Tightened raw to 91 KiB — the smallest whole-KiB that clears
  //     the 91446 measured (93184 ≥ 91446, ≈1.7 KiB / 1.9% headroom),
  //     per the "smallest whole-KiB that clears" rule. gz (24835) is
  //     left at 25 KiB; its 765 B slack is already tight.
  //   → +min+gz axis 12 KiB (2026-06-01): consumer-facing artifact proxy
  //     baselined / measured 11284.
  //   → raw −1 KiB (2026-06-24): W4-5 bundle hygiene — JSDoc trim in errors.ts reclaims
  //     bytes. Measured: 92686 raw / 25244 gz / 11399 min-gz.
  //   → raw +1 KiB / gz +1 KiB (2026-06-24): WS4.1 T1 CODE_RESOLUTIONS + resolution strings
  //     reach observability.js via the errors chunk (canonicalLine + errorEnvelope paths).
  //     Measured: 93806 raw / 25709 gz.
  //   → raw +1 KiB (2026-06-24): WS4.1 T2 WHERE_ORDER/WRITE_BODY_SHAPE_RESOLUTION wired into
  //     router.ts throw sites. Measured: 94247 raw.
  //   → raw −1 KiB (2026-06-24): WS4.1 T5 A1 JSDoc trim (CODE_RESOLUTIONS comment) sheds
  //     bytes from the observability closure; tighten to the smallest KiB that clears.
  //     Measured: 93936 raw (92*1024 = 94208 ≥ 93936). // WS4.1
  { entry: "observability.js", raw: 92 * 1024, gz: 26 * 1024, minGz: 12 * 1024 },
  // Maintenance loop — compactor + GC + sweep driver. Pulls
  // compactor.ts + gc.ts + the observability subgraph
  // transitively (storage decorator + logger config + canonical
  // line). Operator-side; not part of the kernel barrel as of T01.
  // ~142 KiB raw.
  // Budget history:
  //   → 157 KiB raw / 44 KiB gz: InMemoryMetricsRecorder added to
  //     @baerly/server's curated protocol re-exports; marginal cost
  //     from the recorder class landing in the maintenance closure.
  //   → 185 KiB raw / 51 KiB gz: kernel-cleanup (A4 + B22) moved
  //     `rebuildIndex` off the top-level barrel and onto
  //     `@gusto/baerly-storage/maintenance`. The primitive plus its
  //     walkLogRange dependency widens the maintenance closure
  //     by ~28 KiB raw / 7 KiB gz; the matching shrinkage lands
  //     in the index.js closure.
  //   → 108 KiB raw / 33 KiB gz (2026-05-31, in-band-maintenance FINAL,
  //     Task 8): the 185 KiB ceiling was grossly loose (74% headroom).
  //     SHRINK FINDING: the write-tick hook pulled the maintenance subgraph
  //     into the kernel barrel, so rolldown now dedups compactor + gc +
  //     rebuildIndex into the SHARED `maintenance-*.js` chunk consumed by
  //     `index.js`/`http.js`/the adapters, instead of `maintenance.js`
  //     carrying a fat private copy. The subpath closure is now just
  //     `maintenance.js` (430 B re-export shim) + the shared
  //     `maintenance-*` chunk + context/current-json/errors — and crucially
  //     NO `observability-*.js` chunk (the old standalone subpath dragged
  //     the logtape subgraph; it no longer does). Final measured: 108893
  //     raw / 32917 gz. Tightened to the same small-headroom convention as
  //     every other entry — no loose ceilings.
  //   → +min+gz axis 11 KiB (2026-06-01): consumer-facing artifact proxy
  //     baselined / measured 9919.
  //   → 110 KiB raw / 34 KiB gz (2026-06-14): maintenance-profile
  //     consolidation — the new `MAINTENANCE_PROFILE_*` constants (shared
  //     kernel chunk) + the `profileToScheduledOptions` helper land in this
  //     subpath's closure (measured 111961 raw / 33974 gz). Rebaseline raw
  //     +2 KiB, gz +1 KiB. min-gz unaffected (still passing).
  //   → 111 KiB raw / 34 KiB gz (2026-06-15): the assembled-key-length
  //     guard (`assertKeyWithinLimit`, key-limit.ts) lands in the writer's
  //     closure, which this subpath re-exports (measured 112796 raw).
  //     Rebaseline raw +1 KiB; gz/min-gz unaffected (still passing).
  //   → 112 KiB raw / 34 KiB gz (2026-06-15): the read-tail forward-probe
  //     (`log-tail.ts`, single-write-commit Plan B) lands in `gc.ts`'s
  //     closure (measured 114362 raw). Rebaseline raw +1 KiB; gz/min-gz
  //     unaffected (still passing).
  //   → 113 KiB raw / 34 KiB gz (2026-06-15): the compactor's
  //     `mean_entry_bytes` stamp + its `current.json` validation
  //     (single-write-commit Plan B Phase 3) land in this closure
  //     (measured 114767 raw). Rebaseline raw +1 KiB; gz/min-gz
  //     unaffected (still passing).
  //   → 113 KiB raw / 35 KiB gz (2026-06-15): the compactor's tail
  //     forward-probe (`probeTailFrom`, log-tail.ts; single-write-commit
  //     Plan B Phase 3.2) joins this closure as the fold-ceiling
  //     discovery + tail_hint stamp (measured 34833 gz, +17 over the
  //     34 KiB ceiling). Rebaseline gz +1 KiB; raw/min-gz unaffected
  //     (still passing — log-tail.ts was already in gc.ts's closure).
  //   → 114 KiB raw / 35 KiB gz (2026-06-15): `estimateTailBytes` + the
  //     `MAINTENANCE_COLD_START_ENTRY_BYTES` constant (single-write-commit
  //     Plan B Phase 3.3, ratio-trigger derived tail estimate) land in this
  //     closure (measured 115918 raw; +206 over). Rebaseline raw +1 KiB;
  //     gz/min-gz unaffected (still passing).
  //   → 116 KiB raw (2026-06-15): single-write commit — runner observed-tail
  //     plumbing + findLogTail/probe floors (measured 117799 raw; gz under).
  //   → 36 KiB gz (2026-06-15): single-write-commit doc accuracy pass —
  //     corrected the stale runner write-tick/scheduled comment (comments
  //     ship un-stripped). +21 B gz over the prior ceiling (measured 35861).
  //     raw/min-gz unaffected. Rebaseline gz +1 KiB only.
  //   → 120 KiB raw / 37 KiB gz (2026-06-16): gc/pending.json CAS-merge fix —
  //     the new `casUpdateGcPending` retry loop + the pure `mergeGcPending`
  //     mutator (swept-key dedup + cursor-asymmetry handling) and the bounded
  //     live-log scan land directly in gc.ts's closure, which this subpath
  //     re-exports. Genuinely new logic — both axes climb (measured 122167
  //     raw / 37458 gz); min-gz still under. Rebaseline raw + gz to the
  //     smallest whole-KiB that clears.
  //   → raw +1 KiB / gz +1 KiB (2026-06-22): CLOUDFLARE_PAID_TIER constant +
  //     JSDoc (~23 lines) in maintenance.ts lands directly in this subpath's
  //     closure (measured 124481 raw / 38054 gz); min-gz unaffected.
  //   → raw −1 KiB (2026-06-23): trimmed the duplicated @example recipe from the
  //     CLOUDFLARE_PAID_TIER JSDoc (measured 123841 raw). gz stays at 38 KiB —
  //     the trim narrowed but didn't cross the KiB boundary (measured 37916 gz).
  //   → raw +1 KiB (2026-06-24): RETRIABLE_CODES + isRetriableCode + BaerlyError.retriable
  //     getter in errors.ts (measured 124817 raw).
  //   → raw −2 KiB / gz −1 KiB (2026-06-24): W4-5 bundle hygiene — constants chunk no
  //     longer in maintenance closure (moved RESOLUTION constants to leaf; JSDoc trim).
  //     Measured: 124579 raw / 38165 gz / 11113 min-gz.
  { entry: "maintenance.js", raw: 122 * 1024, gz: 38 * 1024, minGz: 11 * 1024 },
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
  //     `S3HttpStorage` directly from `@gusto/baerly-storage/node`. Measured:
  //     347593 raw / 102077 gz — −97 KiB raw / −26 KiB gz.
  //   → 363 KiB raw / 108 KiB gz: in-band-maintenance Task 2
  //     (2026-05-30). The kernel write-tick hook pulls the maintenance
  //     subgraph (compactor + gc) into the aggregator closure via
  //     `writer.ts` → `maintenance.ts`. Measured: 371087 raw / 110013
  //     gz. INTERIM bump — a later in-band-maintenance task reconciles
  //     the net.
  //   → 375 KiB raw / 112 KiB gz (2026-05-31, in-band-maintenance FINAL,
  //     Task 8 net reconciliation): the kernel write-tick hook pulls the
  //     maintenance subgraph (compactor + gc) into the aggregator closure
  //     via `writer.ts` → `maintenance.ts`, plus Task 5.5's
  //     `cfMaintenanceDispatch` (the CF in-band dispatch that runs one
  //     phase per tick under the CF-free CPU ceiling). Final measured:
  //     382290 raw / 113407 gz. Net vs. the pre-maintenance baseline
  //     (347593 raw / 102077 gz, the unify-baerly-storage F1 measurement):
  //     +34697 raw / +11330 gz. CF has no `opts.maintenance`/`setInterval`
  //     deletion offset (that was the Node adapter); the CF adapter never
  //     shipped a scheduled sweep. Justified: in-band maintenance is core
  //     kernel value, statically bounded (reuses the tested
  //     `CLOUDFLARE_FREE_TIER` profile), smaller than the rejected sweep/
  //     pending_gc/lease designs. Owner-accepted (Decision D2).
  //   → 377 KiB raw / 112 KiB gz (2026-05-31): the UTF-8 byte-order key
  //     comparator added to `MemoryStorage` ships in the protocol closure
  //     this bundle pulls; shared-chunk re-splitting redistributed ~1 KB
  //     raw here. Measured: 385000 raw / 114547 gz. Bump raw to 377 KiB;
  //     gz stays comfortably under 112 KiB.
  //   → 378 KiB raw / 113 KiB gz (2026-06-01): layout-version-cordon —
  //     reserved-`_` namespace + tolerant-reader contract JSDoc in the
  //     protocol/server closure this bundle pulls, shipped un-stripped.
  //     Measured 386641 raw / 115250 gz. gz was already +295 over the prior
  //     112 KiB ceiling on main (pre-existing drift) and this change widened
  //     it. Rebaseline raw +1 KiB and gz +1 KiB (owner-accepted; user chose
  //     rebaseline). See docs/adr/007-layout-versioning-cordon.md.
  //   → +min+gz axis 40 KiB (2026-06-01): consumer-facing artifact proxy
  //     baselined / measured 39317. For this entry the compressed axis
  //     (`gz` / `min+gz`) is the one that maps to the real Cloudflare
  //     Workers compressed script-size limit (1 MB free / 10 MB paid) —
  //     that is the cliff a Worker actually hits at deploy time. `raw` is
  //     a cold-start CPU proxy (the isolate parses the un-gzipped script),
  //     NOT "what the parser sees" universally — a consumer's own bundler
  //     re-minifies before deploy, so min+gz is the closest proxy to the
  //     bytes Cloudflare weighs against the limit.
  //   → raw 379 KiB (2026-06-11): hono 4.12.23 → 4.12.25 patch bump in
  //     the dep refresh widened the closure +27 raw bytes (387099),
  //     tipping the 378 KiB ceiling. gz/min+gz unaffected. Rebaseline
  //     raw +1 KiB.
  //   → raw 380 KiB / gz 114 KiB (2026-06-14): caller-supplied `_id`
  //     boundary guard. `doc-id.ts` (`assertDocId`) reaches the cloudflare
  //     closure via `runInsert` / `runReplaceById` on the request path.
  //     ~845 B raw / ~78 B gz over (measured 388941 raw / 115790 gz);
  //     min+gz unaffected. Rebaseline raw +1 KiB, gz +1 KiB.
  //   → raw 381 KiB (2026-06-15): `estimateTailBytes` + the
  //     `MAINTENANCE_COLD_START_ENTRY_BYTES` constant (single-write-commit
  //     Plan B Phase 3.3) reach the cloudflare closure via the maintenance
  //     subgraph (measured 389655 raw; +535 over). Rebaseline raw +1 KiB;
  //     gz/min-gz comfortably under.
  //   → raw 383 KiB / gz 115 KiB (2026-06-15): single-write commit — the
  //     writer/maintenance forward-probe + findLogTail subgraph reaches the
  //     cloudflare closure (measured 391116 raw / 117198 gz). min-gz under.
  //   → raw 384 KiB (2026-06-16): same adoption exact-entry guard as
  //     index.js reaches the Cloudflare writer closure. Measured 392594 raw;
  //     gz/min-gz remain under.
  //   → raw 388 KiB / gz 117 KiB (2026-06-16): gc/pending.json CAS-merge fix
  //     (`casUpdateGcPending` retry loop + the pure `mergeGcPending` mutator,
  //     plus the bounded live-log scan) reaches the cloudflare closure via the
  //     writer → maintenance subgraph. Genuinely new logic — both axes climb
  //     (measured 396326 raw / 119124 gz); min-gz still under. Rebaseline
  //     raw + gz to the smallest whole-KiB that clears.
  //   → raw +1 KiB (2026-06-22): CLOUDFLARE_PAID_TIER constant + JSDoc (~23 lines)
  //     in maintenance.ts reaches the cloudflare closure via the maintenance shared
  //     chunk (measured 399144 raw); gz/min-gz unaffected.
  //   → raw −1 KiB (2026-06-24): W4-5 bundle hygiene — constants chunk no longer in
  //     cloudflare closure (moved RESOLUTION constants to leaf; JSDoc trim).
  //     Measured: 399974 raw / 120229 gz / 40569 min-gz.
  //   → raw +1 KiB (2026-06-24): WS4.1 T1 CODE_RESOLUTIONS + resolution strings reach
  //     cloudflare.js via the protocol barrel → errorEnvelope. Measured: 401094 raw.
  //   → raw +1 KiB / gz +1 KiB (2026-06-24): WS4.1 T2 WHERE_ORDER/WRITE_BODY_SHAPE_RESOLUTION
  //     wired into router.ts throw sites. Measured: 401991 raw / 121051 gz.
  //   → min-gz +1 KiB (2026-06-24): renamed `BaerlyError`'s private `r` field to
  //     `retriableOverride` for clarity. Soft-private TS field names survive
  //     minification (no prop-mangle), so this lands +2 B on the min-gz axis
  //     (measured 40962 / 40960). A clearer field is worth two shipped bytes —
  //     rebaseline min-gz to 41 KiB.
  { entry: "cloudflare.js", raw: 393 * 1024, gz: 119 * 1024, minGz: 41 * 1024 },
  // Client surface — `BaerlyClient<TConfig>` + fetcher plumbing.
  // Browser/runtime-agnostic; no kernel modules in the closure.
  // Budget history:
  //   → 14 KiB raw / 6 KiB gz: initial budget set in T9 based on
  //     post-T8 measurement (9 KiB raw / 4 KiB gz).
  //   → 16 KiB raw / 6 KiB gz: predicate redesign. The SDK now
  //     normalises `.where(...)` arguments to the wire form on the
  //     client (so the two-shape API works in the browser without a
  //     server round-trip for object→wire conversion). Adds
  //     `normalize.ts` + `wire.ts` + the `errors` chunk to the
  //     client closure. The client does NOT pull
  //     `mergePredicateWires` / `assertWireSatisfiable` — chained
  //     `.where(...)` concatenates clauses; the server's
  //     `parseWhereParam` validator is the satisfiability check.
  //     Measured: 15334 raw / 5187 gz — gz actually dropped
  //     vs. the previous budget (gzip dedup over the new wire-form
  //     identifiers).
  //   → +min+gz axis 3 KiB (2026-06-01): consumer-facing artifact proxy
  //     baselined / measured 2144.
  { entry: "client.js", raw: 16 * 1024, gz: 6 * 1024, minGz: 3 * 1024 },
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
  //   → 24 KiB raw / 8 KiB gz: predicate redesign. The React hook
  //     (`useLiveQuery`) calls `normalizePredicateArg` on every
  //     render so its `stableKey(...)` dep is computed over the
  //     normalised wire — object-form and callback-form
  //     predicates with the same semantic content share a cache
  //     entry. Pulls `normalize.ts` + the `errors` chunk into the
  //     closure. The +1 KiB gz delta is the intrinsic cost of the
  //     wire-form normalisation; the React closure also pays
  //     because the hook lives downstream of the SDK's wire-aware
  //     `.where(...)` seam. Measured: 22522 raw / 7262 gz.
  //   → 26 KiB raw / 9 KiB gz: react-hooks-collapse. Six hooks
  //     (`useLiveQuery` / `useLiveDocument` / `useInsert` / `useUpdate`
  //     / `useReplace` / `useDelete`) plus `useInvalidationTick`
  //     collapse to two (`useQuery` / `useMutation`). New closure
  //     carries the Proxy-free recorder (sentinel-trap on awaited
  //     terminals), the `subscription-pool` (per-(client, table)
  //     ref-counted long-poll, signature-keyed result cache, AbortController
  //     fetch lifecycle), and the `useSyncExternalStore` plumbing.
  //     `normalizePredicateArg` / `stableKey`-on-predicates dropped
  //     from the closure (signature now comes from chain + deps;
  //     predicate values flow through deps). Measured: 25063 raw /
  //     8534 gz — net +2541 raw / +1272 gz vs. pre-collapse.
  //   → +min+gz axis 4 KiB (2026-06-01): consumer-facing artifact proxy
  //     baselined / measured 3380.
  //   → raw +1 KiB (2026-06-24): RETRIABLE_CODES + isRetriableCode + BaerlyError.retriable
  //     getter in errors.ts (measured 26916 raw).
  //   → gz −1 KiB (2026-06-24): W4-5 bundle hygiene — JSDoc trim in errors.ts.
  //     Measured: 26724 raw / 8979 gz / 3469 min-gz.
  { entry: "client-react.js", raw: 27 * 1024, gz: 9 * 1024, minGz: 4 * 1024 },
  // `@baerly/dev` surface — `LocalFsStorage`, `printDevBanner`,
  // `ensureTable`, `renderDevLanding`. NO longer an aggregator over
  // the kernel barrel: the only kernel surfaces these helpers touch
  // are pulled transitively by their own logic (e.g. `LocalFsStorage`
  // implements `Storage`, so it imports the kernel's `BaerlyError`
  // chunk). `baerlyDev` (the Vite plugin) is intentionally NOT
  // re-exported from this barrel — vite users import it from the
  // `@gusto/baerly-storage/dev/vite` subpath instead, which keeps the vite
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
  //   → 28 KiB raw / 11 KiB gz: pre-existing ambient drift across
  //     the same chunks the dev barrel transitively pulls. Measured
  //     at react-hooks-collapse baseline: 27951 raw / 10381 gz —
  //     +1083 raw / +429 gz vs. prior. Bump both axes by ~1 KiB.
  //   → 30 KiB raw / 11 KiB gz: in-band-maintenance Task 1. CurrentJson
  //     schema v2 widened the shared `current-json` chunk this dev
  //     barrel pulls (via `Db` → kernel), and rolldown's non-
  //     deterministic chunk re-layout reshuffled the `src-*` split.
  //     Measured: 30203 raw / 11081 gz — gz is actually UNDER the
  //     prior budget; only raw crept over. Bump raw by 2 KiB.
  //   → 34 KiB raw / 12 KiB gz (2026-05-31, in-band-maintenance FINAL,
  //     Task 8): `@baerly/dev`'s closure does NOT pull the maintenance
  //     subgraph (chunks: `chunk-*`, `current-json`, `dev`, `errors`,
  //     `src-*` — no `maintenance-*.js`). The growth is the shared
  //     `current-json` chunk widening (CurrentJson schema v2 fields the
  //     write-tick gate reads — `snapshot_bytes`/
  //     `snapshot_rows`/`last_warned_seq`) plus rolldown's `src-*` re-
  //     layout as the kernel closures shifted around the maintenance pull.
  //     Final measured: 33276 raw / 12004 gz. Owner-accepted (Decision D2).
  //   → 34 KiB raw / 13 KiB gz (2026-05-31): the UTF-8 byte-order key
  //     comparator added to `LocalFsStorage` + the protocol closure this
  //     bundle pulls crept gz +21 over the 12 KiB ceiling. Measured:
  //     33966 raw / 12309 gz. Raw stays under 34 KiB; bump gz to 13 KiB.
  //   → 35 KiB raw / 13 KiB gz (2026-06-15): the assembled-key-length
  //     guard (`assertKeyWithinLimit`, key-limit.ts) lands in the writer's
  //     closure this dev barrel pulls via `Db` (measured 34959 raw).
  //     Raw crept +143 over the 34 KiB ceiling; bump raw to 35 KiB. gz
  //     stays under 13 KiB.
  //   → 36 KiB raw / 13 KiB gz (2026-06-15): the read-tail forward-probe
  //     (`log-tail.ts`, single-write-commit Plan B) lands in this barrel's
  //     closure via `Db.probeLogTail` (measured 36200 raw). Bump raw +1 KiB;
  //     gz stays under 13 KiB.
  //   → 37 KiB raw / 14 KiB gz (2026-06-22): MAINTENANCE_PROFILE_CF_PAID JSDoc
  //     (~23 lines) in constants.ts lands in the protocol chunk this dev barrel
  //     pulls; comments ship un-stripped (gz 13→14).
  //   → raw +1 KiB (2026-06-24): RETRIABLE_CODES + isRetriableCode + BaerlyError.retriable
  //     getter in errors.ts (measured 38173 raw).
  //   → raw −2 KiB (2026-06-24): W4-5 bundle hygiene — constants chunk no longer
  //     in dev closure (moved RESOLUTION constants to leaf; JSDoc trim).
  //     Measured: 37935 raw / 13618 gz.
  { entry: "dev.js", raw: 38 * 1024, gz: 14 * 1024 },
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

function measureClosure(entry: string): {
  raw: number;
  gz: number;
  minGz: number;
  files: string[];
} {
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
  // `min+gz` minifies each chunk with esbuild (the minifier most
  // consumer bundlers — Vite/esbuild — actually run), concatenates,
  // then gzips. This is the consumer-facing artifact proxy: the lib
  // ships UNMINIFIED, so neither `raw` nor unminified-`gz` is what a
  // consumer pays once their bundler re-minifies. CONSERVATIVE UPPER
  // BOUND: per-file `transformSync` does syntax minification per chunk
  // but NOT the cross-module tree-shaking / scope-hoisting a real
  // consumer bundler does, so the real shipped cost is ≤ this number.
  // It is not the exact shipped artifact.
  const minified = files.map(
    (f) => transformSync(readFileSync(f, "utf8"), { loader: "js", minify: true }).code,
  );
  const minGz = gzipSync(Buffer.concat(minified.map((c) => Buffer.from(c)))).length;
  return { raw, gz, minGz, files: files.map((f) => f.replace(`${distDir}/`, "")) };
}

describe("bundle size", () => {
  for (const { entry, raw, gz, minGz, skip } of BUDGETS) {
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
      const minGzLine = formatBundleSizeLine({
        entry,
        kind: "min-gz",
        measured: measured.minGz,
        budget: minGz ?? 0,
        chunks: measured.files,
      });
      if (process.env["BUNDLE_SIZE_REPORT"]) {
        console.log(rawLine);
        console.log(gzLine);
        if (minGz !== undefined) {
          console.log(minGzLine);
        }
      }
      // Check every axis and report ALL overages at once. Asserting
      // raw-then-gz-then-min-gz in sequence makes the FIRST failing axis
      // mask the rest (a single `expect` aborts the test), so a raw
      // overrun hides a simultaneous gz overrun — you rebaseline raw,
      // re-run, and only THEN discover gz is over too. Collecting the
      // failures avoids that iterate-twice trap and prints a paste-ready
      // rebaseline (smallest whole-KiB that clears the measured value)
      // for each axis that crossed.
      const axes: {
        kind: "raw" | "gz" | "min-gz";
        measured: number;
        budget: number;
        line: string;
      }[] = [
        { kind: "raw", measured: measured.raw, budget: raw, line: rawLine },
        { kind: "gz", measured: measured.gz, budget: gz, line: gzLine },
      ];
      if (minGz !== undefined) {
        axes.push({ kind: "min-gz", measured: measured.minGz, budget: minGz, line: minGzLine });
      }
      const over = axes.filter((a) => a.measured > a.budget);
      const report = over
        .map((a) => {
          const kib = Math.ceil(a.measured / 1024);
          return `${a.line}\n    → rebaseline ${a.kind}: ${kib} * 1024 (= ${kib * 1024}, clears ${a.measured})`;
        })
        .join("\n");
      expect(
        over.length,
        `${over.length} axis/axes over budget for dist/${entry}:\n${report}`,
      ).toBe(0);
    });
  }

  // The kernel barrel (`baerly-storage`) is the surface every consumer
  // pays for. Writer / compactor / GC read the active per-request
  // recorder via `getCurrentContext()?.recorder`; that lookup needs
  // the tiny `context.ts` chunk but MUST NOT drag the full
  // `observability-*.js` subgraph (logtape + canonical-line render +
  // pretty sink) into the barrel.
  test("dist/index.js closure excludes the observability subgraph", () => {
    const measured = measureClosure("index.js");
    const observabilityChunks = measured.files.filter((f) => f.startsWith("observability-"));
    expect(
      observabilityChunks,
      `kernel barrel must not pull the observability subgraph; found: ${observabilityChunks.join(", ")}`,
    ).toEqual([]);
  });

  // `node.js` and `dev-vite.js` are server-side / dev-only aggregator
  // entrypoints — they never ship to a browser and never enter a
  // consumer's app bundle. Budgeting their wire size (raw/gz) measures
  // a cost nobody pays, and the rolldown chunk graph carries ~120 KiB
  // of run-to-run raw variance, so a byte ceiling there is noise. The
  // REAL risk on these surfaces is a heavy runtime dependency silently
  // creeping into the closure, so this REPLACES the wire-size budget
  // with a stricter, more meaningful guard: a bare-specifier allowlist.
  //
  // For each entry we walk the static-import closure and collect every
  // NON-relative import specifier. Each must be either a Node builtin
  // (`node:*`) or one of the four declared runtime deps. This catches a
  // dep that regresses to a LIVE EXTERNAL (un-bundled) import — e.g. a
  // rolldown `external`/bundling slip. A heavy dep that gets bundled
  // INLINE won't show as a bare import here; the raw creep tripwire
  // below is what catches that vector.
  const RUNTIME_DEP_ALLOWLIST = new Set(["aws4fetch", "fast-xml-parser", "hono", "jose"]);
  // Extract the package name from a bare specifier. `hono/tiny` →
  // `hono`; `@scope/name/sub` → `@scope/name`.
  const packageName = (spec: string): string => {
    const parts = spec.split("/");
    return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  };
  for (const entry of ["node.js", "dev-vite.js"]) {
    test(`dist/${entry} closure imports only Node builtins + declared runtime deps`, () => {
      const distDir = resolve(__dirname, "../../dist");
      const seen = new Set<string>();
      collectClosure(resolve(distDir, entry), seen);
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
          offenders.push(`${file.replace(`${distDir}/`, "")} → ${spec}`);
        }
      }
      expect(
        offenders,
        `${entry} closure may import only node:* builtins + [${[...RUNTIME_DEP_ALLOWLIST].join(", ")}]; unexpected: ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  }

  // node.js / dev-vite.js: NOT a cost budget — server/dev surfaces
  // never ship to a consumer. This loose raw ceiling is an inline-
  // dep-creep tripwire (generous headroom absorbs rolldown's run-to-
  // run variance; trips only on a gross new dependency). Live-
  // external-import creep is caught separately by the allowlist guard.
  //
  // The allowlist guard above only catches a dep left as a LIVE
  // external import. All four runtime deps are bundled INLINE into the
  // dist, so a heavy dependency bundled INTO the closure would balloon
  // byte count without tripping the allowlist. This raw ceiling
  // recovers that coverage.
  for (const { entry, raw } of [
    { entry: "node.js", raw: 700 * 1024 },
    { entry: "dev-vite.js", raw: 710 * 1024 },
  ]) {
    test(`dist/${entry} closure stays under the inline-dep-creep raw ceiling`, () => {
      const measured = measureClosure(entry).raw;
      expect(
        measured,
        `${entry} raw closure ${measured} B exceeds inline-dep-creep ceiling ${raw} B`,
      ).toBeLessThanOrEqual(raw);
    });
  }

  // Scaffolded apps install only `baerly-storage`. `fast-xml-parser`
  // and `aws4fetch` are bundled into the published library + bin
  // chunks that use them (see `rolldown.config.ts` and
  // `packages/cli/rolldown.config.ts`); no dist closure may leave a
  // live `import "fast-xml-parser"` or `import "aws4fetch"` for the
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
  const BUNDLED_OPTIONAL_PEERS = new Set(["fast-xml-parser", "aws4fetch"]);
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
