import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
// min+gz numbers are esbuild-version-sensitive: a minifier version bump
// rebaselines every entry's `minGz` ceiling at once.
import { transform } from "esbuild";
import { describe, expect, test } from "vitest";
import { formatBundleSizeLine } from "../helpers/bundle-size-report.ts";
import { IS_CI } from "../setup/ci.ts";

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
// `dist/baerly.js` to catch live imports of `@rgrove/parse-xml` /
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
  /** Skip this entry's budget check. */
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
  //     (owner-accepted; user chose rebaseline). See docs/adr/003-layout-versioning-cordon.md.
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
  //   → raw +1 KiB (2026-06-25): opaque manifest_pointer digest replaces the
  //     old snapshot/log-tail-shaped cursor. The FNV helper reaches the kernel
  //     query closure (measured 227561 raw); gz/min-gz remain under.
  //   → raw +1 KiB / min-gz +1 KiB (2026-06-30): MemoryStorage fail-closed
  //     guard — `isDeployedEnv` predicate + the actionable error string ship in
  //     the kernel closure (measured 229129 raw / 19688 min-gz). Genuinely new
  //     safety logic (prevents silent in-memory-in-prod data loss); the error
  //     string survives minification, so min-gz climbs too. Justified.
  //   → raw +1 KiB (2026-06-30): `isDeployedEnv` now suppresses the PaaS-marker
  //     branch under CI (so MemoryStorage stays usable in k8s-hosted CI, which
  //     sets KUBERNETES_SERVICE_HOST). +22 raw over the prior bound (measured
  //     229398); min-gz is 19724 / 20480 (−756, healthy) — per the POLICY above,
  //     raw is a creep tripwire, so rebaseline rather than golf the predicate.
  //   → raw +2 KiB / gz +1 KiB (2026-06-30): `assertValidStorageKey`
  //     (storage/key.ts) reaches the MemoryStorage closure — the raw `Storage`
  //     key-namespace guard, with its full explanatory JSDoc + a self-explaining
  //     error message. Stacks on top of the fail-closed guard above, which is why
  //     the gz axis (flagged near-ceiling on that bump) now crosses 70 KiB as
  //     predicted. Measured 231593 raw / 72425 gz / 19885 min-gz; min-gz stays
  //     under 20 KiB (−595). Per the POLICY, rebaselined the raw/gz tripwires
  //     rather than golf the doc/error.
  //   NOTE (2026-07-01): the gz 71 KiB bump above also absorbs CI's cross-
  //     environment gz nondeterminism (~18 B observed) that flaked the axis
  //     near the old 70 KiB ceiling. The IRSA credential work ships under the
  //     separate `node`/adapter-node entry, not the kernel barrel, so it does
  //     not move this closure.
  //   NOTE (2026-07-01): adding the ./s3 rolldown input re-chunks shared modules
  //     and nudges the index.js gz closure up (measured 72639 vs 72704 budget,
  //     65 B of headroom) — still under the 71 KiB bound, left un-bumped.
  //   → 229 KiB raw / 72 KiB gz (2026-07-04): maintenance env-parse
  //     consolidation moved `parseMaintenanceEnv` into the shared bundled
  //     `maintenance` chunk (now in this closure), plus rolldown 1.1.0→1.1.3
  //     pulled by `pnpm dedupe`. Measured 234242 raw / 73263 gz; min-gz under.
  //   → 230 KiB raw (2026-07-15): adding the ./gcs rolldown input re-chunks
  //     shared modules and nudges the index.js raw closure up by ~70 B
  //     (measured 234566 vs the old 234496 ceiling), the same class of
  //     shared-chunk boundary shift the ./s3 note above records. gz/min-gz
  //     unaffected; this is a tripwire rebaseline, not a shipped-cost change.
  //   → 231 KiB raw / 73 KiB gz (2026-08-01): floor-monotonicity work on
  //     `current.json` — the `casUpdateCurrentJson` admission guard plus the
  //     expanded `@throws` contract and `CurrentJson.log_seq_start` invariant
  //     JSDoc. Almost entirely comment/JSDoc bytes, which rolldown ships
  //     un-stripped: min-gz (the minified hard ceiling, where comments are
  //     gone) barely moved. Measured 236371 raw / 74129 gz / 20252 min-gz
  //     (min-gz 228 B under). Deliberate doc-quality spend, not code creep —
  //     per the POLICY above, raw/gz are creep tripwires and are rebaselined
  //     rather than paid for by golfing comments.
  //   → 232 KiB raw (2026-08-01): GC grace-period anchoring fix —
  //     `computeDueAt` drops its `entry.lastModified` anchor, plus the
  //     do-not-reinstate rationale on it and on the `StorageListEntry`
  //     field. Pure comment bytes: the code got SMALLER (one parameter
  //     and one `??` gone), and min-gz — the minified hard ceiling, where
  //     comments are stripped — measured 20239, DOWN 13 B from the 20252
  //     recorded in the note above. Measured 236768 raw / 74313 gz (gz
  //     still 439 B under). Rebaselined per the POLICY rather than golfing
  //     the warning that keeps the bug from being reintroduced.
  //   → 233 KiB raw / 74 KiB gz (2026-08-01): `/v1/since` cursor generation
  //     discriminator (#73) — the `cursor.ts` codec, `CurrentJson.generation`
  //     and its `assertCurrentJson` guard, and `mintGeneration`.
  //     Comment/JSDoc dominated, as the axis split shows: raw and gz crossed
  //     while min-gz (the hard ceiling, comments stripped) stayed 176 B under.
  //     `cursor.ts` imports only `errors.ts`, already present in every
  //     closure, so no new module was dragged in. Measured 238198 raw /
  //     74840 gz / 20304 min-gz.
  //   → 235 KiB raw (2026-08-01): the rewritten `Writer#readPreImage`
  //     docstring (#74). The old docstring claimed a `log_seq_start` bound
  //     the loop never had; the replacement carries the subrequest
  //     derivation for the new descent budget and states plainly which
  //     stale keys the walk no longer cleans up. Almost pure comment
  //     bytes — the code delta is one `Math.max` and one loop bound.
  //     `PREIMAGE_SCAN_MAX_GETS` itself contributes 0 B to every closure:
  //     it is tree-shaken and the folded literal is inlined at the use
  //     site. gz (75716, 60 B under) and min-gz (20340, 140 B under — the
  //     hard ceiling, comments stripped) both stayed UNDER, the signature
  //     of a comment-dominated change. Measured 240194 raw / 75716 gz /
  //     20340 min-gz. Rebaselined per the POLICY rather than golfing the
  //     prose that stops the false bound from being reintroduced.
  //   → 239 KiB raw (2026-08-02): GC stale-log rotation cursor. Sized for
  //     the whole branch — `GcPending.log_scan_cursor` and the shared
  //     `mergeRotationCursor` land in this commit, the `gc.ts` module JSDoc
  //     rewrite lands in the next one, and both are measured here so the
  //     baseline is written once rather than revised mid-branch.
  //     Comment-dominated, and the axis split says so: against the branch
  //     base (240194 raw / 75716 gz / 20340 min-gz) raw moves +4351 while
  //     min-gz — the hard ceiling, comments stripped — moves +18 and stays
  //     122 B under its unchanged 20 KiB budget. gz also stays under, so
  //     only the raw tripwire is rebaselined here.
  //     Measured 244545 raw / 77477 gz / 20358 min-gz.
  { entry: "index.js", raw: 239 * 1024, gz: 76 * 1024, minGz: 20 * 1024 },
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
  //   → 57 KiB raw (2026-07-04): rolldown 1.1.0→1.1.3 toolchain bump pulled
  //     by `pnpm dedupe`. Measured 57403 raw; gz/min-gz under.
  { entry: "auth.js", raw: 57 * 1024, gz: 15 * 1024, minGz: 9 * 1024 },
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
  //     prior 321 KiB). Rebaseline raw +1 KiB. See docs/adr/003-layout-versioning-cordon.md.
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
  //   → raw +2 KiB / gz +1 KiB / min-gz +1 KiB (2026-06-25): HTTP error
  //     message policy now scrubs storage/server diagnostics by code+origin,
  //     logs the full original error server-side, and preserves predicate
  //     InvalidConfig guidance for raw HTTP callers. Opaque manifest pointers
  //     also reach the read path. Measured: 345775 raw / 102837 gz / 35038 min-gz.
  //   → raw +1 KiB (2026-06-25): PR review follow-up replaces duplicated
  //     defaulted switches and prefix-based InvalidConfig exposure with one
  //     exhaustive policy table plus a typed request-boundary marker.
  //     Measured: 346767 raw; gz/min-gz remain under.
  //   → raw +2 KiB (2026-06-30): adding the ./s3 rolldown input re-chunks
  //     shared modules, nudging this closure over the prior 339 KiB budget.
  //     Measured: 347346 raw.
  //   → raw +3 KiB / gz +1 KiB / min-gz +1 KiB (2026-07-01): pre-release dep
  //     sweep to latest — @logtape/logtape 2.1.3→2.2.2 (via the observability
  //     chunk) + hono 4.12.25→4.12.27. Deliberate upstream upgrades, not code
  //     creep; the min-gz bump is the honest cost of the newer logtape closure.
  //     Measured: 352012 raw / 104287 gz / 35958 min-gz.
  //   → 346 KiB raw / 103 KiB gz (2026-07-04): maintenance env-parse
  //     consolidation into the shared `maintenance` chunk + rolldown
  //     1.1.0→1.1.3 from `pnpm dedupe`. Measured 354182 raw / 104921 gz;
  //     min-gz under.
  //   → 348 KiB raw / 104 KiB gz (2026-07-06): host-config coexistence —
  //     configureObservability now checks getConfig() and skips (with a meta
  //     notice) rather than reset a host app's LogTape config, and the
  //     ownership marker is namespaced to "@gusto/baerly-storage" (un-guessable
  //     so a host can't trip the destructive reset). Flows through the
  //     observability chunk; the namespaced literal + guard JSDoc nudge gz over.
  //     Measured 355931 raw / 105574 gz; min-gz (−659) under. Per the POLICY,
  //     raw/gz are creep tripwires → rebaseline rather than golf the guard.
  //   → 349 KiB raw (2026-07-07): @logtape/logtape 2.2.2→2.2.4 — upstream fix
  //     for the configure() exit-listener leak (dahlia/logtape#192, issue #40)
  //     now unregisters the prior dispose hook before registering a new one,
  //     adding a few hundred bytes to the observability closure. Deliberate
  //     dep bump, not code creep. Measured 356664 raw; gz/min-gz under.
  //   → 350 KiB raw (2026-07-15): dep sweep — hono 4.12.27→4.12.30 patch.
  //     Deliberate upstream bump, not code creep. Measured 358079 raw;
  //     gz/min-gz under.
  //   → 352 KiB raw / 105 KiB gz (2026-08-01): floor-monotonicity admission
  //     guard in `casUpdateCurrentJson` — rejects a CAS that lowers
  //     `log_seq_start`, which `assertCurrentJson` cannot see (it needs both
  //     sides of the transition) — plus `compact()`'s seq-option validation
  //     covering the fold CAS that bypasses that helper, and the JSDoc for
  //     both. gz needed the bump: it sat 260 B under before this change, so
  //     the mostly-comment delta crossed the axis. min-gz (the hard ceiling,
  //     comments stripped) stays 315 B under. Measured 359799 raw / 106796 gz
  //     / 36549 min-gz. Deliberate safety + doc change; raw/gz rebaselined
  //     rather than golfing the comments.
  //   → 359 KiB raw / 107 KiB gz (2026-08-01): `/v1/since` cursor generation
  //     discriminator (#73). This closure owns the handler, so it takes the
  //     whole change: the `cursor.ts` codec, `decodeCursor` shape validation,
  //     the generation comparison and its rationale comment, and the
  //     `pollOnce` split that carries the manifest generation out to
  //     `next_cursor` without a second `current.json` read. min-gz stays
  //     under, but only by 43 B — the next change through this closure should
  //     expect to argue about it rather than assume headroom. Measured
  //     366541 raw / 109305 gz / 36821 min-gz.
  //   → 361 KiB raw / 108 KiB gz (2026-08-01): the rewritten
  //     `Writer#readPreImage` docstring and its descent budget (#74).
  //     This closure pulls in the writer via `constants.ts` + the server
  //     barrel, so it takes the whole delta. Measured 368659 raw / 110218
  //     gz / 36858 min-gz.
  //     min-gz did NOT move, and that was the deciding constraint on the
  //     change rather than an afterthought. An earlier draft counted the
  //     walk's give-up on `db.write.index_cleanup_errors_total`; that
  //     `if` plus its labelled `ctxMetrics().counter` call measured +15 B
  //     min-gz, which put this closure 13 B OVER the 36 KiB hard ceiling.
  //     Golfing was measured and does not reach — the label string, a
  //     shorter `step` value, and hoisting the floor are all 0 B, because
  //     the metric name already appears 3x in the chunk and deflate
  //     absorbs the rest. The counter was dropped instead of rebaselining
  //     min-gz, and it was the right call on its own merits: at a budget
  //     this small the give-up path is the COMMON case, so the counter
  //     was noise that would have swamped the two steps on that series
  //     that do signal a failure.
  //     ⚠️ min-gz now clears by 6 B (36858 / 36864). The 43 B note above
  //     is now a 6 B note. This is a hair-trigger: the next change
  //     through this closure — including one that only adds a
  //     `console.warn` string — will trip it, and the honest fix at that
  //     point is to shrink the closure, not to take the KiB. Do not read
  //     the surviving 36 KiB line as headroom.
  //   → 365 KiB raw / 110 KiB gz / 37 KiB min-gz (2026-08-02): GC stale-log
  //     rotation cursor, sized for the whole branch. Measured 373010 raw /
  //     112018 gz / 36883 min-gz, against a branch base of 368659 / 110218 /
  //     36858. The note above predicted this closure would have to argue
  //     rather than assume headroom (it was 6 B under on min-gz), and this
  //     is that change.
  //
  //     min-gz is the axis that needs the argument. It moves +25 B, which
  //     crosses the old 36 KiB ceiling by 19 B — so this rebaseline is
  //     required, not discretionary. The spend is a second rotation cursor:
  //     an optional field, a merge branch, a validator arm, and the log
  //     phase's examined/last-key bookkeeping. It is partly paid for up
  //     front — the branch OPENS by deleting `listBounded` (`listWindow`
  //     supersedes it, and it was the worse shape besides, draining the wire
  //     and truncating client-side instead of pushing `maxKeys` down), which
  //     returns minified kernel before any cursor work is spent. +25 B net
  //     is what survives that.
  //
  //     Taking the full KiB rather than trimming to fit is deliberate. A
  //     hard ceiling left at single-digit-bytes of headroom is a coin-flip
  //     gate: min-gz is deterministic within one environment but drifts a
  //     few bytes across them — esbuild desync is exactly why CI reports
  //     min+gz instead of failing on it — so a 6 B budget passes for whoever
  //     measured it and fails for the next person. The 1005 B now free is
  //     headroom, not spend; treat the next crossing as this closure's real
  //     argument.
  { entry: "http.js", raw: 365 * 1024, gz: 110 * 1024, minGz: 37 * 1024 },
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
  //   → raw +5 KiB / gz +1 KiB / min-gz +1 KiB (2026-07-01): pre-release dep
  //     sweep — @logtape/logtape 2.1.3→2.2.2. This subpath is the thinnest
  //     wrapper over logtape, so the newer logtape closure lands here most
  //     visibly. Deliberate upstream upgrade, not code creep.
  //     Measured: 98776 raw / 27034 gz / 12477 min-gz.
  //   → raw +2 KiB / gz +1 KiB (2026-07-06): host-config coexistence — the
  //     getConfig() ownership check + skip-and-warn path in configureObservability,
  //     plus the namespaced "@gusto/baerly-storage" marker literal and its guard
  //     JSDoc (comments ship un-stripped). Measured 100568 raw / 27690 gz; min-gz
  //     (−701) under. Rebaseline the raw/gz creep tripwires per the POLICY.
  //   → raw +1 KiB (2026-07-14): pickLevel now classifies canonical lines by
  //     wire status (4xx incl. a lost-CAS 409 Conflict → warn, not error), and
  //     its contract comment + the level-mapping docstring ship un-stripped.
  //     Measured 101630 raw; gz (−726) and min-gz (−622) both comfortably under.
  //     Rebaseline the raw creep tripwire per the POLICY (don't golf comments).
  { entry: "observability.js", raw: 100 * 1024, gz: 28 * 1024, minGz: 13 * 1024 },
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
  //   → raw +2 KiB (2026-06-30): adding the ./s3 rolldown input re-chunks
  //     shared modules, nudging this closure over the prior 122 KiB budget.
  //     Measured: 125023 raw.
  //   → 125 KiB raw / 39 KiB gz / 12 KiB min-gz (2026-07-04): the
  //     consolidated cross-host `parseMaintenanceEnv` helper now lives in
  //     this shared chunk (previously 3 copies across the host adapters).
  //     The min-gz +34 is genuinely-new justified code, NOT creep — per the
  //     POLICY above min-gz is the hard ceiling, and this is a real single-
  //     source-of-truth win for the BAERLY_MAINTENANCE_* contract. Also
  //     rolldown 1.1.0→1.1.3 from `pnpm dedupe`. Measured 127151 raw /
  //     38915 gz / 11298 min-gz.
  //   → 127 KiB raw (2026-08-01): floor-monotonicity work — `compact()`'s
  //     seq-option validation (this closure owns the compactor) and the
  //     `casUpdateCurrentJson` guard, plus JSDoc on both. Measured 129227 raw
  //     / 39688 gz / 11471 min-gz; gz (248 B) and min-gz (817 B) both stay
  //     under, only the raw tripwire moves.
  //   → gz 39→40 KiB (2026-08-01): dropping `StorageListEntry.lastModified`
  //     replaced the field with a longer do-not-reinstate JSDoc block on the
  //     type, and `computeDueAt` likewise. Both are `/** */` blocks, which
  //     rolldown ships; the CODE shrank (a parameter, a `??`, and three
  //     adapter assignments gone). Measured 129693 raw / 39898 gz / 11454
  //     min-gz. That left gz 38 B under a hard-gated axis — a hair-trigger
  //     for whoever edits a comment near this closure next — so the gz
  //     tripwire moves even though it had not tripped. min-gz, the real
  //     shipped-cost ceiling where comments are stripped, is 834 B under and
  //     FELL 17 B on this change. Per the POLICY above: comment-dominated,
  //     so rebaseline rather than golf the warning that keeps a
  //     seven-day-grace bug from being reintroduced.
  //     Same commit, no budget move needed: index.js 236837 raw (731 B
  //     under), http.js 360265 (183 B), cloudflare.js 432978 (174 B),
  //     dev.js unchanged.
  //   → 128 KiB raw (2026-08-01): `/v1/since` cursor generation discriminator
  //     (#73). This closure does not touch cursors; it moves only because it
  //     shares `current-json.js`, which gained the `generation` field, its
  //     guard, and `mintGeneration`. gz (695 B) and min-gz (776 B) both stay
  //     under; only the raw tripwire moves. Measured 130752 raw / 40265 gz /
  //     11512 min-gz.
  //   → 133 KiB raw / 42 KiB gz (2026-08-02): GC stale-log rotation cursor,
  //     sized for the whole branch. This closure owns `gc.ts`, so it takes
  //     the whole module-JSDoc rewrite. Measured 135346 raw / 42148 gz /
  //     11538 min-gz, against a branch base of 130995 / 40364 / 11528. The
  //     axis split identifies this as documentation rather than code creep:
  //     raw +4351, gz +1784, but min-gz (the hard ceiling, comments
  //     stripped) only +10, staying 750 B under its unchanged budget.
  { entry: "maintenance.js", raw: 133 * 1024, gz: 42 * 1024, minGz: 12 * 1024 },
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
  //     rebaseline). See docs/adr/003-layout-versioning-cordon.md.
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
  //   → raw +9 KiB / gz +2 KiB / min-gz +2 KiB (2026-06-24): WS5 T6 anonymous
  //     GET /v1/spec route — pulls runtime-spec-FV6ikMXW.js (7.62 kB raw incl.
  //     baerly.spec.json IR) into the cloudflare adapter bundle. The subpath keeps
  //     it out of the kernel barrel (index.js unaffected). Measured: 410063 raw /
  //     122866 gz / 42545 min-gz. Budgets carry the policy ~1 KiB headroom (the
  //     gz axis in particular: 121 KiB clears 122866 by ~1 KiB, vs 14 B if pinned
  //     to 120 KiB — too tight against this closure's known ambient drift).
  //   → raw +2 KiB (2026-06-25): same request-path error scrub/log policy and
  //     opaque manifest_pointer digest as http.js, pulled through the Worker
  //     adapter aggregator. Measured: 413601 raw; gz/min-gz remain under.
  //   → raw +1 KiB / gz +1 KiB (2026-06-25): same exhaustive policy-table
  //     follow-up as http.js. The gz axis crossed by 17 B; keep the clear
  //     table rather than byte-golfing policy metadata.
  //     Measured: 414593 raw / 123921 gz; min-gz remains under.
  //   → raw +2 KiB (2026-06-30): MemoryStorage fail-closed guard pulled through
  //     the protocol barrel into the Worker aggregator (measured 416161 raw);
  //     gz/min-gz remain under. Same safety logic as the index.js bump above.
  //   → raw +3 KiB / gz +1 KiB (2026-06-30): `assertValidStorageKey` reaches the
  //     r2-binding + s3-http closures (the raw `Storage` key-namespace guard).
  //     Stacks on top of the fail-closed guard above; the two guards' minified
  //     error strings together pushed min-gz +31 B past the 43 KiB HARD ceiling
  //     (44063), so — per the POLICY, which forbids rebaselining min-gz — the
  //     key-guard's (test-unasserted) error message was tightened to shrink the
  //     closure rather than raise the ceiling. Post-trim measured 418893 raw /
  //     125590 gz / 44028 min-gz; min-gz clears 43 KiB by 4 B. Only the raw/gz
  //     creep tripwires are rebaselined.
  //   → min-gz +1 KiB (2026-07-01): adding the ./s3 rolldown input re-chunks
  //     shared modules, and this closure's min-gz — already only 4 B under the
  //     43 KiB ceiling on main — crosses it (measured 44194). The bytes are real
  //     shipped code reshuffled across chunk boundaries by a new entry point, not
  //     golf-able waste, so per the POLICY (cf. the index.js fail-closed bump)
  //     min-gz rebaselines. raw/gz stay under main's bounds (419336 / 125799).
  //   → raw +1 KiB / gz +1 KiB (2026-07-01): the injected-storage feature adds
  //     the resolveWorkerStorage helper + the ResolvedState resolve-once plumbing
  //     in worker.ts — genuinely new code in the Worker aggregator. raw crosses
  //     the 410 KiB bound and gz the 123 KiB bound (measured 420142 raw /
  //     126038 gz); min-gz is 44325, still under the 44 KiB set above.
  //   → raw +4 KiB / gz +1 KiB (2026-07-01): pre-release dep sweep —
  //     @logtape/logtape 2.1.3→2.2.2 (via the observability chunk) + hono
  //     4.12.25→4.12.27, both in this aggregator's closure. Only the raw/gz
  //     creep tripwires move; min-gz (measured 45027) stays under 44 KiB.
  //   → min-gz +1 KiB (2026-07-03): the snapshot `body.docs` array-shape guard
  //     in snapshot.ts (`loadSnapshotAsMap` → BaerlyError("InvalidResponse", …),
  //     added in 95648be2) reaches this closure via the maintenance/compactor
  //     subgraph. Measured 45063, +7 past the 44 KiB min-gz line. Bisect
  //     confirmed this guard is the sole cause (every commit after it is
  //     docs/changeset-only and byte-neutral); it slipped onto main because CI
  //     runs min-gz report-only. The bytes are a real, intentional validation
  //     guard whose actionable error message is kept verbatim per the repo's
  //     error-quality UX bar — golfing the string is a dead end anyway (gzip
  //     already dedupes the shared `compact: snapshot …` prefix; the cost is the
  //     guard's control flow, not its text). So the tripwire rebaselines rather
  //     than degrade the message. raw/gz remain comfortably under their 415/125
  //     KiB bounds (only min-gz crossed).
  //   → 417 KiB raw (2026-07-04): maintenance env-parse consolidation into
  //     the shared `maintenance` chunk + rolldown 1.1.0→1.1.3 from `pnpm
  //     dedupe`. Measured 426799 raw; gz/min-gz under.
  //   → 419 KiB raw / 126 KiB gz (2026-07-06): host-config coexistence — the
  //     configureObservability skip-and-warn path (observability chunk) plus the
  //     worker's `observability: false` opt-out guard + JSDoc. Measured 428259 raw
  //     / 128281 gz; min-gz (−811) stays under. Rebaseline the raw/gz tripwires.
  //   → 420 KiB raw (2026-07-07): @logtape/logtape 2.2.2→2.2.4 — upstream fix
  //     for the configure() exit-listener leak (dahlia/logtape#192, issue #40)
  //     adds the dispose-hook unregister path to the observability closure.
  //     Deliberate dep bump, not code creep. Measured 429325 raw; gz/min-gz under.
  //   → 421 KiB raw / 127 KiB gz (2026-07-15): dep sweep — hono 4.12.27→4.12.30
  //     patch in this aggregator's closure. Deliberate upstream bump, not code
  //     creep. Measured 430785 raw / 129071 gz; min-gz under. Only the raw/gz
  //     creep tripwires move.
  //   → 423 KiB raw (2026-08-01): floor-monotonicity admission guard in
  //     `casUpdateCurrentJson` plus `compact()`'s seq-option validation
  //     (same change as http.js above; shared current-json + maintenance
  //     chunks). Measured 432505 raw / 129632 gz / 45580 min-gz; gz (416 B)
  //     and min-gz (500 B) both stay under, only raw moves. Deliberate
  //     safety change.
  //   → 430 KiB raw / 130 KiB gz (2026-08-01): `/v1/since` cursor generation
  //     discriminator (#73) — same change as http.js above, reaching this
  //     aggregator through the shared http + current-json chunks. min-gz
  //     stays 239 B under. Measured 439542 raw / 132296 gz / 45841 min-gz.
  //   → 432 KiB raw / 131 KiB gz (2026-08-01): the rewritten
  //     `Writer#readPreImage` docstring and its descent budget (#74) —
  //     same change as http.js above, reaching this aggregator through the
  //     shared constants + server chunks. Measured 441808 raw / 133274 gz /
  //     45878 min-gz. min-gz clears by 202 B here, so only the raw/gz creep
  //     tripwires move. This closure has more slack than http.js because
  //     the delta is comment-dominated and it carries more non-kernel code
  //     to amortise it against — do not infer http.js is comfortable from
  //     this line; see its own ⚠️ note above.
  //   → 436 KiB raw / 133 KiB gz (2026-08-02): GC stale-log rotation cursor,
  //     sized for the whole branch. Measured 446159 raw / 135096 gz / 45913
  //     min-gz, against a branch base of 441808 / 133274 / 45878 — raw
  //     +4351, gz +1822, min-gz +35 and still 167 B under its unchanged
  //     budget. gz takes the full KiB rather than the 72 B that would have
  //     cleared it, for the same coin-flip reason argued on http.js.
  //   → 425 KiB raw / 129 KiB gz / 44 KiB min-gz (2026-08-02): budgets move
  //     DOWN. `packages/adapter-cloudflare/src/worker.ts` imported
  //     `renderDevLanding` from the `@baerly/dev` barrel, and the barrel
  //     re-exports `LocalFsStorage`, so rolldown chunked the entire Node-only
  //     local-fs closure — `node:crypto`, `node:fs/promises`, `node:os`,
  //     `node:path` — into every deployed Worker for the sake of one HTML
  //     string. `dev-landing.ts` has no imports at all, so giving it its own
  //     `@baerly/dev/dev-landing` subpath drops the whole closure out of this
  //     aggregator. Measured 433454 raw / 131424 gz / 44135 min-gz against a
  //     branch base of 446159 / 135096 / 45913 — a 12705 / 3672 / 1778 B win
  //     on all three axes. Budgets tighten to lock the win in rather than bank
  //     it as silent headroom.
  //
  //     Worth noting what the base was: on the line above, raw had 305 B of
  //     headroom and min-gz 167 B. This entry was one ordinary comment edit
  //     from firing on two axes, and the code responsible for that pressure
  //     could not run under Workerd in the first place.
  //
  //     Tightened to roughly a KiB above each measured axis, not to the
  //     nearest boundary. Per the POLICY raw/gz are creep tripwires: one that
  //     fires on ordinary prose reports noise, and the next author rebaselines
  //     it reflexively, which is how a tripwire stops being read. The
  //     regression these lock in is the ~12 KiB raw / ~3.6 KiB gz barrel drag
  //     above, so 1746 B raw / 672 B gz of slack still catches it with margin.
  //     min-gz keeps 921 B: that axis is the HARD ceiling and the one worth
  //     holding tight.
  //
  //     The barrel drag itself is caught structurally rather than by bytes —
  //     see the `dist/cloudflare.js` Workerd-builtin closure assertion below,
  //     which is what lets these two axes stay diagnostic rather than
  //     load-bearing.
  { entry: "cloudflare.js", raw: 425 * 1024, gz: 129 * 1024, minGz: 44 * 1024 },
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
  //   → raw +2 KiB (2026-06-30): `assertValidStorageKey` reaches the LocalFsStorage
  //     closure (the raw `Storage` key-namespace guard) with its full JSDoc +
  //     self-explaining error message. Measured 40341 raw / 14447 gz. This dev-only
  //     bundle has no min-gz axis, so gz is its tightest tripwire; rebaselined
  //     gz 14→15 KiB rather than golf the doc/error (see the POLICY on index.js).
  //   → 41 KiB raw (2026-08-01): floor-monotonicity work — this closure pulls
  //     the `current-json` chunk, so it carries the `casUpdateCurrentJson`
  //     guard and its expanded JSDoc. Measured 41442 raw / 14808 gz; gz stays
  //     552 B under (no min-gz axis on this entry). Comment-dominated
  //     rebaseline, not code creep.
  //   → 42 KiB raw (2026-08-01): `/v1/since` cursor generation discriminator
  //     (#73). This closure pulls the `current-json` chunk, so it carries the
  //     `generation` field, its `assertCurrentJson` guard, and
  //     `mintGeneration` (which `ensureTable` now calls). Measured 42789 raw
  //     / 15304 gz; gz stays 56 B under — tight, so the next dev-closure
  //     change should expect to move it. Comment-dominated rebaseline.
  //   → 43 KiB raw / 16 KiB gz (2026-08-01): review follow-up on the same
  //     change — `assertCurrentJson`'s `generation` guard now pins the
  //     lowercase-hex charset (matching `/v1/since`'s `GENERATION_RE`, so
  //     the manifest validator and the wire validator cannot drift) and
  //     carries the rationale comment for it. Measured 43032 raw /
  //     15400 gz — the +56 B the note above predicted, plus the guard.
  //     No min-gz axis on this entry; comment-dominated, per POLICY not
  //     golfed to fit.
  //   → 44 KiB raw (2026-08-02): `LocalFsStorage.put`'s EXDEV fix — the
  //     shared `tempPathFor` staging helper, and the JSDoc explaining why
  //     the temp must be a sibling of its destination rather than live in
  //     `os.tmpdir()`. Comments ship un-stripped here, so most of the +1111
  //     is that prose; per POLICY it is not golfed to fit, and cutting it
  //     would delete the reason the code is shaped this way. Measured 44143
  //     raw / 15835 gz — raw was 111 B over and moves, gz stays 549 B under
  //     and does not.
  //   → 51 KiB raw / 19 KiB gz (2026-08-02): serializing every
  //     `LocalFsStorage` mutation of a key — the `key-lock.ts` per-key async
  //     mutex that makes the `ifMatch` read-compare-write atomic, `realpath`
  //     canonicalization of the lock key, and the JSDoc scoping the
  //     single-process guarantee (plus the recorded `delete`-vs-`put`
  //     divergence against a not-yet-created symlinked root, and the note
  //     that `toLowerCase()` approximates Unicode case folding rather than
  //     implementing it).
  //
  //     Unlike most rebaselines above this is NOT comment-dominated: it is
  //     real shipped control flow, and this closure is the right place for
  //     it to land. Worth noting where it does NOT land — `cloudflare.js`
  //     used to pick this code up through the `@baerly/dev` barrel and no
  //     longer does, so a Worker pays nothing for any of it.
  //
  //     Measured 51125 raw / 18385 gz, both landing ~1 KiB clear. This entry
  //     has NO min-gz axis precisely because it never reaches a browser, so
  //     both axes here are pure creep diagnostics on a dev/self-host
  //     surface, and per POLICY the docstrings are not golfed to fit them.
  { entry: "dev.js", raw: 51 * 1024, gz: 19 * 1024 },
  // Worker-safe S3 entry — `S3HttpStorage` + `sigV4Signer` + the
  // `aws4fetch` SigV4 client + `@rgrove/parse-xml` XML parser.
  // Intended for cross-account R2 / non-R2 S3 from a Cloudflare
  // Worker; the `./cloudflare` subpath excludes this closure so
  // R2-binding consumers don't pay for it.
  // Budget history:
  //   → 160 KiB raw / 47 KiB gz / 25 KiB min-gz (2026-07-01): initial
  //     baseline. Closure: S3HttpStorage + sigV4Signer + the aws4fetch SigV4
  //     client (emitted as its own shared chunk) + fast-xml-parser, plus the
  //     assertValidStorageKey key-namespace guard from main (the key-* chunk
  //     reaches the s3-http closure). Measured: 163298 raw / 47023 gz /
  //     25100 min-gz. raw/gz are sized with headroom over the chunk-boundary
  //     overhead that the separate aws4fetch chunk carries; min-gz (the hard
  //     ceiling, the real shipped-to-browser cost) clears 25 KiB.
  //   → raw +7 KiB / gz +2 KiB / min-gz +1 KiB (2026-07-01): pre-release dep
  //     sweep floated fast-xml-parser's transitive deps — strnum 2.3.0→2.4.1
  //     and @nodable/entities 2.1.0→2.2.0. (fast-xml-parser itself is held at
  //     5.8.0: 5.9.3 inflated this closure's min-gz ~25%, over the hard ceiling,
  //     and we can't shrink a third-party closure — see the exact pin in
  //     packages/adapter-node/package.json.) The residual here is the honest
  //     cost of the newer strnum/entities; min-gz clears 26 KiB by 661 B.
  //     Measured: 170745 raw / 49358 gz / 25963 min-gz.
  //   → raw −87 KiB / gz −24 KiB / min-gz −14 KiB (2026-07-02): replaced
  //     fast-xml-parser with @rgrove/parse-xml (adapter-node). @rgrove/parse-xml
  //     is a zero-dep, safe-by-design XML parser (no entity-expansion surface);
  //     it is dramatically smaller than fast-xml-parser + its transitive closure
  //     (strnum, @nodable/entities). Measured: 81041 raw / 25085 gz / 11421 min-gz.
  //     All three axes rebaselined for the parser swap.
  //   → gz 26 KiB (2026-07-15): adding the ./gcs rolldown input re-chunks the
  //     shared modules s3.js and gcs.js now co-own (http-transport, key, time,
  //     constants, errors) and nudges the s3.js gz closure up ~625 B (measured
  //     26225 vs the old 25600 ceiling). Same shared-chunk boundary shift the
  //     ./s3 notes on other entries record; raw/min-gz unaffected — a tripwire
  //     rebaseline, not a shipped-cost change.
  { entry: "s3.js", raw: 81 * 1024, gz: 26 * 1024, minGz: 12 * 1024 },
  // gcs.js: the curated `@gusto/baerly-storage/gcs` family barrel
  // (GcsHttpStorage + goog4Signer). Closure = the GCS native-XML `Storage`
  // impl + GOOG4 signer + shared http-transport / key-namespace / time /
  // constants / errors chunks + `@rgrove/parse-xml` (list-response parsing).
  //   → baseline (2026-07-15): new subpath. Measured 76506 raw / 24902 gz /
  //     9636 min-gz. Smaller than s3.js (81/26/12) because the GOOG4 signer
  //     uses WebCrypto + the shared `sha256` helper rather than pulling
  //     `aws4fetch` — confirmed aws4fetch-free in this closure. Budgets set
  //     at the next KiB boundary above each measured axis; min-gz (the hard
  //     ceiling) clears 10 KiB.
  { entry: "gcs.js", raw: 75 * 1024, gz: 25 * 1024, minGz: 10 * 1024 },
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

// Absolute paths of every chunk in `entry`'s static-import closure,
// sorted for deterministic concatenation order.
function closureFiles(entry: string): string[] {
  const distDir = resolve(__dirname, "../../dist");
  const entryAbs = resolve(distDir, entry);
  if (!existsSync(entryAbs)) {
    throw new Error(`dist/${entry} missing — run \`pnpm build\` before \`pnpm test\``);
  }
  const seen = new Set<string>();
  collectClosure(entryAbs, seen);
  return [...seen].toSorted();
}

// Raw + gzipped closure size. Pure fs + zlib, NO esbuild — so the
// raw-only callers (the inline-dep-creep raw ceiling + the import
// allowlist guard) never invoke the minifier. The consumer-cost
// `min+gz` axis is the only one that needs esbuild; it lives in the
// separate async `measureMinGz` below so a minifier flake can't sink a
// test that only reads `.raw`. Both take a pre-resolved `files` list so
// a test that needs both axes walks the closure once.
function measureClosure(files: string[]): {
  raw: number;
  gz: number;
  files: string[];
} {
  const distDir = resolve(__dirname, "../../dist");
  const raw = files.reduce((sum, f) => sum + statSync(f).size, 0);
  const gz = gzipSync(Buffer.concat(files.map((f) => readFileSync(f)))).length;
  return { raw, gz, files: files.map((f) => f.replace(`${distDir}/`, "")) };
}

// `min+gz` minifies each chunk with esbuild (the minifier most consumer
// bundlers — Vite/esbuild — actually run), concatenates, then gzips.
// This is the consumer-facing artifact proxy: the lib ships UNMINIFIED,
// so neither `raw` nor unminified-`gz` is what a consumer pays once
// their bundler re-minifies. CONSERVATIVE UPPER BOUND: per-file syntax
// minify only, NOT the cross-module tree-shaking / scope-hoisting a real
// consumer bundler does, so the real shipped cost is ≤ this number.
async function measureMinGz(files: string[]): Promise<number> {
  const minified: string[] = [];
  for (const file of files) {
    minified.push(await minifyChunk(readFileSync(file, "utf8"), file));
  }
  return gzipSync(Buffer.concat(minified.map((c) => Buffer.from(c)))).length;
}

// min+gz minifies each chunk with esbuild, whose shared service flakes
// under CI's 2-vCPU contention: a `transform` intermittently reports a
// bogus "<stdin>:N: ERROR: X is not declared in this file" on perfectly
// valid input (it surfaces the chunk's bare re-export names). It is
// load-dependent (passes on roughly half of CI runs and always locally)
// and is NOT a stale-service-state bug — it recurs on a freshly-`stop()`ed
// service and across all retries, so neither retrying nor recreating the
// service fixes it. Rather than fight esbuild under contention, min+gz is
// hard-gated LOCALLY only (where esbuild is reliable) and skipped entirely
// in CI (see the call site); the deterministic raw/gz axes gate everywhere.
//
// The retry is a light smoother for a one-off local transient, scoped to
// the esbuild call ONLY. Budget assertions are deterministic functions of
// the committed dist/ bytes, so a real over-budget or closure-leak
// regression still fails locally on the first and every attempt. Each
// failure is logged (not swallowed) so a flake still leaves a breadcrumb;
// the final throw names the offending file instead of a bare esbuild error.
async function minifyChunk(source: string, file: string, attempts = 3): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { code } = await transform(source, { loader: "js", minify: true });
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

describe("bundle size", () => {
  for (const { entry, raw, gz, minGz, skip } of BUDGETS) {
    test.skipIf(skip)(`dist/${entry} closure stays within budget`, async () => {
      // Walk the static-import closure once; both axes read the same list.
      const files = closureFiles(entry);
      const measured = measureClosure(files);
      // Only the consumer-cost axis needs esbuild, and only for entries
      // that declare a ceiling. esbuild flakes under CI's 2-vCPU contention
      // (see minifyChunk), so min+gz is HARD-GATED locally (the pre-commit
      // bundle-size hook, where esbuild is reliable) and skipped entirely in
      // CI — it neither gates nor reports there, so running it would only
      // pay the flaky esbuild cost for nothing. `process.env.CI` is set by
      // the CI runner and unset for the local hook, so this splits cleanly.
      const skipMinGz = IS_CI;
      const minGzMeasured =
        minGz !== undefined && !skipMinGz ? await measureMinGz(files) : undefined;
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
      const minGzLine =
        minGzMeasured !== undefined
          ? formatBundleSizeLine({
              entry,
              kind: "min-gz",
              measured: minGzMeasured,
              budget: minGz ?? 0,
              chunks: measured.files,
            })
          : undefined;
      if (process.env["BUNDLE_SIZE_REPORT"]) {
        console.log(rawLine);
        console.log(gzLine);
        if (minGzLine) {
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
      // min+gz gates locally only: skipped in CI, so minGzMeasured is
      // undefined there and this axis never enters the budget assertion.
      if (minGzMeasured !== undefined && minGzLine) {
        axes.push({ kind: "min-gz", measured: minGzMeasured, budget: minGz ?? 0, line: minGzLine });
      }
      const over = axes.filter((a) => a.measured > a.budget);
      const report = over
        .map((a) => {
          const kib = Math.ceil(a.measured / 1024);
          return `${a.line}\n    → rebaseline ${a.kind}: ${kib} * 1024 (= ${kib * 1024}, clears ${a.measured})`;
        })
        .join("\n");
      // Carry the POLICY in the failure output itself, so it is read at the
      // moment it matters instead of only living in the comments above. The
      // guidance is axis-aware: min-gz is a hard ceiling, raw/gz are tripwires.
      const policy = over.some((a) => a.kind === "min-gz")
        ? "min-gz is the HARD ceiling — the real shipped-to-browser cost after a " +
          "consumer bundler minifies. Over on min-gz is a genuine regression: " +
          "investigate the closure and shrink it, do NOT just rebaseline."
        : "raw/gz are creep tripwires, NOT hard limits. If this size change is " +
          "intentional, rebaseline the KiB line above with a dated baseline note. " +
          "Do NOT trim JSDoc / comments / error-message text or golf identifiers " +
          "to fit — comments ship un-stripped, but doc + error quality outweigh a " +
          "few bytes.";
      expect(
        over.length,
        `${over.length} axis/axes over budget for dist/${entry}:\n${report}\n\n  POLICY: ${policy}`,
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
    const measured = measureClosure(closureFiles("index.js"));
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
  // string. Measured with that import reintroduced, all three byte budgets
  // on this entry still PASSED: the drag was invisible on every axis, and
  // only became a symptom later when unrelated growth pushed min-gz over.
  // `scripts/lint-package-layers.mjs` cannot see it either — its `allowNode`
  // gate reads a package's own source, and no `node:` specifier ever
  // appeared in `packages/adapter-cloudflare/`.
  //
  // Asserting on the artifact is what closes that gap, because the artifact
  // is where a transitive drag becomes observable. It also means the raw/gz
  // creep tripwires above do not have to carry this weight — per the POLICY
  // they are diagnostics, and a budget tight enough to catch a barrel drag
  // would fire on an ordinary JSDoc edit instead.
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
    const distDir = resolve(__dirname, "../../dist");
    const offenders: string[] = [];
    for (const file of closureFiles("cloudflare.js")) {
      for (const m of readFileSync(file, "utf8").matchAll(NODE_SPECIFIER_RE)) {
        const spec = m[1]!;
        if (WORKERD_LOADABLE_BUILTINS.has(spec)) {
          continue;
        }
        offenders.push(`${file.replace(`${distDir}/`, "")} → ${spec}`);
      }
    }
    expect(
      offenders,
      `dist/cloudflare.js closure may import only [${[...WORKERD_LOADABLE_BUILTINS].join(", ")}]; found: ${offenders.join(", ")}. A Node builtin here means Node-only code was dragged into the Worker bundle — usually by importing a barrel that re-exports it. Import the leaf module instead (cf. \`@baerly/dev/dev-landing\` in packages/adapter-cloudflare/src/worker.ts)`,
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
  const RUNTIME_DEP_ALLOWLIST = new Set(["@rgrove/parse-xml", "aws4fetch", "hono", "jose"]);
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
      const measured = measureClosure(closureFiles(entry)).raw;
      expect(
        measured,
        `${entry} raw closure ${measured} B exceeds inline-dep-creep ceiling ${raw} B`,
      ).toBeLessThanOrEqual(raw);
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
  const pkgRoot = resolve(__dirname, "../..");
  const distDir = resolve(pkgRoot, "dist");
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

describe("spec artifact emission", () => {
  test("dist/baerly.spec.json is emitted and schema-shaped", () => {
    const distDir = resolve(__dirname, "../../dist");
    const path = resolve(distDir, "baerly.spec.json");
    expect(existsSync(path)).toBe(true);
    const ir = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(ir["specVersion"]).toBe("1");
    expect(Array.isArray(ir["errorCodes"])).toBe(true);
    expect((ir["errorCodes"] as unknown[]).length).toBe(14);
  });
});
