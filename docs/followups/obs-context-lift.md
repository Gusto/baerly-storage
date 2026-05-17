# Followups: obs-context-lift

Loose ends from the observability-context-lift branch (merged into local
`main` on 2026-05-16 at tip `03f5942`). The branch lifted canonical-line
context creation from the router middleware into each adapter, threaded
`cache_status` through the Cloudflare cache wrapper, fixed a recorder
doubled-`_total` suffix bug that silently broke the cost-meter render on
real production lines, and reframed `baerly stats` in the docs.

Pre-existing followups from prior branches still live at
[`dx-first-touch-banner.md`](dx-first-touch-banner.md). Items below are
new.

**Status (2026-05-16):** items 2 and 5 shipped via the
`validated-followups-2026-05-16` worktree (annotated below). Items 1,
3, 4, 6 remain open as **manual checklist** / **bundle-budget watch**
/ **design question** / **monitoring item** respectively.

| # | Finding | Status |
|---|---|---|
| 1 | Manual TTY visual smoke | pre-publish checklist; no code change |
| 2 | `deriveOutcome` duplication | shipped `7e96b52` (+ literal-union narrow `061b101`) |
| 3 | `prettyConsoleSink` lazy extraction | deferred (`observability.js` budget has headroom) |
| 4 | `baerly stats` CLI | deferred (open design questions) |
| 5 | `invalidateOnWrite` ignores query-stringed list URLs | shipped `efdc270` |
| 6 | Recorder soft contract on `_total` | leave as-is unless real mis-registration ships |

**New (surfaced during T07 implementation review, both deferred):**

- **`LIST_KEY_INDEX` outer Map has no cap on (tenant, table) pairs.** Per-table cap is 256 with insertion-order eviction (`packages/adapter-cloudflare/src/cache.ts:55-74`), but the outer Map grows unbounded in tenant count. Worst-case at 10K dormant tenants is ~50 MB until per-entry TTLs fire 60 min later. A hard outer cap with LRU eviction would make the worst case bounded rather than time-bounded. Defer until multi-tenant memory pressure shows up.
- **`CACHE_TTL_MS` duplicates the `max-age=3600` literal.** `cache.ts:62` says they "MUST match" but they aren't derived from a shared constant. A single source of truth (or a regression test asserting drift) would prevent silent breakage when one is tuned. Cheap to add; bundle into next cache-touching branch.

## 1. Manual TTY visual smoke (pre-publish only)

**STATUS: pre-publish checklist** (not a code change).

Automated tests cover the pretty-sink render shape end-to-end
(`packages/server/src/observability/logger.test.ts`,
`tests/integration/observability.test.ts:155-191`,
`packages/adapter-cloudflare/src/cache-status.test.ts`), but a human at
a real terminal hasn't confirmed:

- ANSI color rendering (status code colorization in
  `packages/server/src/observability/logger.ts:264-272`).
- Column alignment on a real terminal width.
- The `⚙` glyph fallback to `* ` in `CI` envs / non-TTY.

To run when prepping for publish:

```sh
cd examples/helpdesk && pnpm dev
# In a second terminal, hit a few routes; visually inspect the lines.
```

The Node helpdesk renders `class_a=N class_b=N` (post-T07 fix) but never
`cache=…` (Node has no cache layer). To see `cache=hit`/`cache=miss`
you'd need to drive the Cloudflare helpdesk through `wrangler dev` —
but that's JSON-only (no TTY), so the visual smoke for that path is
"the JSON line carries `cache_status` correctly," which the automated
tests already prove.

Trivial. Not a code change.

## 2. `deriveOutcome` duplication (three call sites now)

**STATUS: resolved (`7e96b52`, narrowed `061b101`).** Discovered during the validation pass that the router's inline ternary was **NOT** byte-identical to the adapter copies — the adapters had a `error !== undefined && status >= 500 → "error"` short-circuit the router lacked. Decision (per pre-launch directive "fix root causes"): align all three to the adapter shape and extract. New helper at `packages/server/src/observability/derive-outcome.ts`, re-exported from the observability subpath, return type narrowed to `"read" | "committed" | "conflict" | "error"`. Unit test at `derive-outcome.test.ts` pins the 5xx-with-error short-circuit branch the router previously lacked.

The helper `(method, status, error?) => string` lives in three places
verbatim:

- `packages/server/src/http/router.ts:158-165` (inline in the
  standalone-mode `finally` arm).
- `packages/adapter-cloudflare/src/worker.ts:434-439`.
- `packages/adapter-node/src/server.ts:312-317`.

The T01/T02/T03 reviewers each flagged this; the consensus was "wait
for the third call site, then extract in one shot." That third site
landed in T03. Extract to `@baerly/server/observability` (the only
package all three importers already depend on) and re-export from
`packages/server/src/observability/index.ts`. Drop the inline copies.

~0.25d. Pure consolidation, no behavior change. Should land before any
new outcome rule is added — currently the three copies are byte-
identical, but the next divergence is the kind of bug that hides in a
copy-paste.

## 3. `prettyConsoleSink` lazy extraction

**STATUS: deferred** (budget has headroom).

`packages/server/src/observability/logger.ts:208-339` carries the
canonical-line renderer + `picocolors` import. `prettyConsoleSink` is
only selected when `resolveSink` (`logger.ts:168`) picks
`"console-pretty"` — that's a TTY-only default in Node and never in
Workers.

Extract `prettyConsoleSink` + `renderCanonical` to a sibling file
(`packages/server/src/observability/logger-pretty.ts`) and lazy-`await
import()` it inside `resolveSink` when needed. Apps that always run
JSON (production Workers) drop the picocolors closure from their
bundle. Expected savings: ~3–5 KiB gz (T02 code-quality reviewer's
estimate).

Deferred because the `observability.js` budget (100 KiB raw / 36 KiB
gz at `tests/integration/bundle-size.test.ts:83`) has comfortable
headroom today. Revisit when adding new sink machinery or if the
budget tightens.

## 4. `baerly stats` CLI

**STATUS: deferred** (open design questions: where reads from + where ships).

Deferred per the phase decision. `docs/about/cost-model.md:48,159`
now qualifies the references as "planned." Operators get the trailing-
24h Class A rollup today by piping the canonical line into CloudWatch
/ Workers Analytics / Datadog — documented at
`docs/guide/observability.md` §Sinks.

Reopen this if an operator actually asks for a built-in rollup. The
unanswered design questions remain:

- **Where does it read from?** Local rotating JSON / SQLite log of
  canonical lines, or query an external sink? A local store adds a new
  failure mode just to demo the rollup.
- **Where does it ship?** Sibling to `inspect` / `admin compact` in
  `packages/cli/src/`, or a separate `@baerly/stats` package?

The graduation thresholds (50M Class A ops/mo sustained 7d, write-amp
> 6, > 5 GB stored) at `docs/about/cost-model.md:159-161` are real
operator guidance regardless of how they're surfaced and stay
unchanged.

## 5. `invalidateOnWrite` ignores query-stringed list URLs

**STATUS: resolved (`efdc270`).** Took the broader fix path: per-isolate index of `(tenant, table) → Set<keyUrl>` mapped to `setTimeout` handles; `trackListUrl` records every list-URL `cache.put`, `invalidateOnWrite` iterates the index and busts every variant. Cap = 256 entries per `(tenant, table)` with insertion-order eviction; 1h TTL matches the synthetic `max-age=3600`. The Case 3 workaround in `packages/adapter-cloudflare/src/cache-status.test.ts` is gone — the rewritten test warms `?where=...` directly and proves the new invalidation. (See the two new deferred sub-items in the header table: tenant-count outer Map cap, and `CACHE_TTL_MS` shared-source.)

Surfaced while writing T02's `cache-status.test.ts` Case 3.
`packages/adapter-cloudflare/src/cache.ts:151-184` only busts the
exact cache key for the URL the write hit + (for `/:id` writes) the
bare parent list URL. A list URL cached at `/v1/t/<table>?where=…`
is **not** invalidated by a subsequent write — the cache key includes
the query string, but `invalidateOnWrite` only constructs the bare
parent-list key.

The Case 3 test works around this by priming the bare list URL
(`/v1/t/<table>` with no `?where=`) so the test asserts honest
behavior with an inline comment noting the gap.

Real-world impact: clients that filter list reads with `?where=` and
then write get stale list responses until the cache entry's
synthetic `max-age=3600` expires or a write hits the bare URL.

Two paths:

- **Narrow fix:** drop the `search` from the list key when storing
  too, so writes and reads share one key per `(tenant, table)`. Cost:
  one entry per table, but read filtering is client-side anyway.
- **Broad fix:** keep the `?where=` granularity but maintain a
  per-table tag set and bust by tag. Cost: a second `cache.put` per
  read.

~0.5d. Real bug, not pre-launch-blocking (the cache is a best-effort
optimization), but worth a focused ticket.

## 6. Recorder gating is a soft contract

**STATUS: monitoring item** (leave as-is unless a real mis-registration ships).

`packages/server/src/observability/recorder.ts:96-103` now gates the
`_total` append with `row.name.endsWith("_total")`. This is a string
test, not a typed convention. If a future emitter registers a counter
named `events_with_total_suffix` (intentionally or accidentally), the
gate will incorrectly skip the append.

Probability is low — every kernel counter currently emits with the
Prometheus suffix already attached, and the comment at
`recorder.ts:97-101` documents the convention. But a stricter
contract would be: require emitters to register counters without the
`_total` suffix, and have `summarize()` always append. That re-opens
the original bug surface, so prefer this gating approach for now.

If we ever want full safety, the cleanest path is a type-level
constraint: `counter(name: \`\${string}\` /* not ending in _total */,
value: number)`. TypeScript can't express that easily; not worth the
template-literal-type tax. Leave as-is unless a real
mis-registration ships.
