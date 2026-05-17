# Followups: next batch

Open items consolidated from three retired followup files
(`minor-findings.md`, `dx-first-touch-banner.md`,
`obs-context-lift.md`) after the
`validated-followups-2026-05-16` worktree shipped its share. Resolved
entries got their commits cited in that worktree's commit log and are
dropped from this page.

Sections group by area; one entry per item with provenance, status,
effort hint, and the load-bearing detail. Pick items off this list in
future branches; flip an entry to `STATUS: resolved (<sha>)` inline
when shipped, then prune.

## adapter-cloudflare cache

Surfaced during T07 implementation review on the
`validated-followups-2026-05-16` worktree.

### 1. `LIST_KEY_INDEX` outer Map has no cap on (tenant, table) pairs

**STATUS: deferred until multi-tenant memory pressure shows up.**
**Effort:** S (~0.25d once the cap shape is decided).

Per-table cap is 256 with insertion-order eviction
(`packages/adapter-cloudflare/src/cache.ts:55-74`), but the **outer**
`Map<string, Map<string, Timer>>` keyed by `(tenant, table)` grows
unbounded in tenant count. Worst-case at 10K dormant tenants is
~50 MB until per-entry TTLs fire 60 min later. A hard outer cap with
LRU eviction would make the worst case bounded rather than
time-bounded.

### 2. `CACHE_TTL_MS` duplicates the `max-age=3600` literal

**STATUS: deferred; bundle into next cache-touching branch.**
**Effort:** S (<0.25d).

`packages/adapter-cloudflare/src/cache.ts:62` defines
`CACHE_TTL_MS = 3600 * 1000` and the JSDoc says it "MUST match" the
`max-age=3600` Cache-Control literal set on `cache.put`, but they
aren't derived from a shared constant. A single source of truth (or a
regression test asserting drift) would prevent silent breakage when
one is tuned.

## Observability / canonical line

### 3. Seed inserts bypass canonical-line emission (doc nudge)

**STATUS: working-as-designed; doc nudge only.**
**Effort:** S (<0.25d).

The helpdesk's seed callback runs inside the `baerlyDev()` plugin's
`ready` promise (`packages/dev/src/vite-plugin.ts:48`) and calls
`db.table().insert()` directly via the JS API. The HTTP router's
per-request observability middleware
(`packages/server/src/http/router.ts:115-178`) only fires for `/v1/*`
requests — direct `Db` calls from server-side code have no HTTP
context to wrap, so no canonical line.

The verification plan originally proposed using seed inserts as a
calibration gate for the "3 Class A ops per logical write" claim.
That doesn't work — calibration has to come from the first curl POST
against `/v1/t/:table`. No code change needed; just a sentence in
`docs/contributing/conventions/observability.md` so the next person
who reaches for canonical lines as a verification proxy isn't
surprised.

### 4. Manual TTY visual smoke (pre-publish checklist)

**STATUS: pre-publish checklist; not a code change.**
**Effort:** N/A — manual run.

Automated tests cover the pretty-sink render shape end-to-end
(`packages/server/src/observability/logger.test.ts`,
`tests/integration/observability.test.ts:155-191`,
`packages/adapter-cloudflare/src/cache-status.test.ts`), but a human
at a real terminal hasn't confirmed:

- ANSI color rendering (status-code colorization in
  `packages/server/src/observability/logger.ts:264-272`)
- Column alignment on a real terminal width
- The `⚙` glyph fallback to `* ` in `CI` envs / non-TTY

To run when prepping for publish:

```sh
cd examples/helpdesk && pnpm dev
# In a second terminal, hit a few routes; visually inspect the lines.
```

The Node helpdesk renders `class_a=N class_b=N` but never `cache=…`
(no cache layer). The Cloudflare side via `wrangler dev` is JSON-only
(no TTY), so its visual smoke is "JSON line carries `cache_status`
correctly," which automated tests already prove.

### 5. `prettyConsoleSink` lazy extraction

**STATUS: deferred; `observability.js` budget has comfortable headroom.**
**Effort:** M (~0.5d).

`packages/server/src/observability/logger.ts:208-339` carries the
canonical-line renderer + `picocolors` import. `prettyConsoleSink` is
only selected when `resolveSink` (`logger.ts:168`) picks
`"console-pretty"` — TTY-only default in Node, never in Workers.

Extract `prettyConsoleSink` + `renderCanonical` to a sibling file
(`packages/server/src/observability/logger-pretty.ts`) and
lazy-`await import()` it inside `resolveSink` when needed. Apps that
always run JSON (production Workers) drop the picocolors closure from
their bundle. Expected savings: ~3–5 KiB gz.

Defer until adding new sink machinery or until the
`observability.js` budget (100 KiB raw / 36 KiB gz at
`tests/integration/bundle-size.test.ts:83`) tightens.

### 6. `baerly stats` CLI

**STATUS: deferred; design questions open.**
**Effort:** L (≥1.5d once design is decided).

Operators get the trailing-24h Class A rollup today by piping the
canonical line into CloudWatch / Workers Analytics / Datadog —
documented at `docs/guide/observability.md` §Sinks.
`docs/about/cost-model.md:48,159` now qualifies the references as
"planned."

Reopen if an operator actually asks for a built-in rollup. Open
questions:

- **Where does it read from?** Local rotating JSON / SQLite log of
  canonical lines, or query an external sink? A local store adds a new
  failure mode just to demo the rollup.
- **Where does it ship?** Sibling to `inspect` / `admin compact` in
  `packages/cli/src/`, or a separate `@baerly/stats` package?

Graduation thresholds (50M Class A ops/mo sustained 7d, write-amp
> 6, > 5 GB stored) at `docs/about/cost-model.md:159-161` remain real
operator guidance regardless of surfacing.

### 7. Recorder gating is a soft contract on `_total` suffix

**STATUS: monitoring item; leave as-is unless a real mis-registration ships.**
**Effort:** S to document; L to enforce at the type level.

`packages/server/src/observability/recorder.ts:96-103` gates the
`_total` append with `row.name.endsWith("_total")`. String test, not
a typed convention. If a future emitter registers a counter named
`events_with_total_suffix` the gate incorrectly skips the append.

Probability is low — every kernel counter currently emits with the
Prometheus suffix already, and the comment at `recorder.ts:97-101`
documents the convention. A stricter contract — require emitters to
register without `_total` and have `summarize()` always append — would
re-open the original bug surface. Type-level enforcement
(``name: `${string}` /* not ending in _total */``) is impractical in
TS; not worth the template-literal-type tax.

## DX / examples / dev orchestration

Items 8–10 are design-level DX questions that need a brainstorming
session before implementation, not a fix-it ticket. Listed together
because items 8 and 10 touch the same `examples/*-cloudflare/`
surface.

### 8. `baerly dev` does not orchestrate `apps/web/`

**STATUS: deferred — L-effort design question.**
**Effort:** L (workspace orchestration design + implementation).

`baerly dev` (`packages/cli/src/dev.ts`) only boots the Node API
listener over `LocalFsStorage`. For `examples/minimal-node-railway/`
and `examples/minimal-node-docker/` the root `package.json` has
`"dev": "baerly dev"`, so the React `apps/web/` workspace is **not**
started by `pnpm dev`. A user opens the banner's
`http://localhost:3000` URL, hits a 401 JSON page, then either reads
the example's README or gives up.

Options to weigh in brainstorming:

- Have `baerly dev` detect `apps/web/package.json` and concurrently
  run `vite` from that directory, then thread the vite URL into
  `printDevBanner({ primaryUrl: ... })`.
- Or document in each example's README that `pnpm dev` is API-only
  and ship a second script (`pnpm dev:web`, or a top-level
  `concurrently` wrapper).

The load-bearing design choice: should `baerly dev` be a workspace
orchestrator at all?

### 9. `helpdesk-cloudflare` could adopt the banner / log helpers

**STATUS: deferred; revisit next time the example is touched.**
**Effort:** S–M (~0.5d, depends on wrapper shape).

`examples/helpdesk-cloudflare/` runs under wrangler, not a Node
`http.Server`. `printDevBanner` (or a thin wrapper that takes the
wrangler URL plus the vite URL) would improve first-touch UX.
Related to item 10 — same workspace, related fix.

### 10. Cloudflare-side examples have `[ELIFECYCLE]` noise on Ctrl-C

**STATUS: deferred; blocked on `@cloudflare/vite-plugin` adoption.**
**Effort:** M (~0.5d once the plugin is wired).

`examples/helpdesk-cloudflare/` and `examples/minimal-cloudflare/`
still run `pnpm --parallel vite + wrangler`, so they exhibit the same
`[ELIFECYCLE]` / `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` noise on Ctrl-C
that the Node-side helpdesk had before the `helpdesk-single-vite`
branch. The fix shape is **different** there — the right tool is
`@cloudflare/vite-plugin`, which runs the Worker inside workerd
inside Vite (genuine single process). The Node-side `baerlyDev()`
plugin from `@baerly/dev/vite` isn't a fit (different runtime, no
`http.Server`).
