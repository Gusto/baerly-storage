# `@baerly/adapter-cloudflare` cache layer: rework or shrink

**Severity: MEDIUM. ~150 LoC of in-isolate state, a public reset
helper that only tests use, three unused barrel exports, and a
test file whose name overlaps another. All in
`packages/adapter-cloudflare/src/cache*.ts`.**

## 1. LIST-URL index is best-effort test-only state

`packages/adapter-cloudflare/src/cache.ts` (401 LOC) maintains a
module-level `Map<string, Map<string, Timer>>` indexed by
`(table → LIST URL → eviction timer)`. The index exists so writes
can fan out `cache.delete()` to filtered-list variants — i.e.,
when a doc changes, invalidate every `?where=...` LIST URL the
isolate has seen.

Three problems:

- **Best-effort.** Cold isolates have no index hit. Line ~357
  ("belt-and-braces bare-list bust") papers over the gap with a
  blanket-bust of the bare LIST URL.
- **Per-isolate.** CF runs many isolates per worker; only the
  *one* that wrote sees the index, so the other isolates' caches
  of the same LIST URL stay stale until their TTL.
- **Unbounded growth ceiling.** `MAX_KEYS_PER_TABLE = 256`
  (line ~118) caps each table's index entries. Zero test
  coverage on the eviction path — no `MAX_KEYS` reference in any
  test file.

So the index is a half-correct optimization paying ~150 LoC of
maintenance for a benefit that doesn't survive cold-start /
cross-isolate cache scope. The blanket-bust line 357 already
exists as the fallback.

### Fix

**Drop the index.** Make `withReadCache` skip LIST URLs
(`/v1/t/:table` without `:id`) entirely:

- List responses become uncached on the wire (or cached only
  via the CF edge `Cache-Control` header without per-key
  invalidation in the worker).
- Per-doc URL caching (`/v1/t/:table/:id`) is cheap and
  per-key bustable — keep that path.
- Cuts ~150 LoC. Eliminates the per-isolate-divergence concern.
- Removes the need for `MAX_KEYS_PER_TABLE` and its untested
  eviction path.

If filtered-LIST caching ever becomes a real bottleneck, revisit
with a *cross-isolate* solution (e.g. CF KV-backed invalidation
or per-table edge purge) — the current in-isolate map can't
solve that problem and shouldn't pretend to.

## 2. `__resetListUrlIndexForTests` leaks module state via a public reset

`packages/adapter-cloudflare/src/cache.ts:394` exports
`__resetListUrlIndexForTests(): void`. It exists because the
module-level `LIST_KEY_INDEX` map needs to be cleared between
test runs (used by `cache-status.test.ts:26`).

A `__-prefixed` export is the canonical "we know this is wrong;
please don't call it" smell. The fix is structural: either drop
the index entirely (item 1 above), or attach it to a
`WithReadCache` *class instance* so each test gets its own copy.

**Fix:**

- If item 1 lands → the export and the index go away together.
- Otherwise → refactor to `class WithReadCache` with the index
  as an instance field. Tests construct a fresh instance per
  `beforeEach`. Delete the `__reset` helper.

## 3. `cacheKeyFor` / `invalidateOnWrite` / `withReadCache` exported from the main barrel

`packages/adapter-cloudflare/src/index.ts` exports all three.
`baerlyWorker(...)` is the only in-repo caller. Zero hits across
`examples/` or `manual-e2e/` — no template hand-wires them.

These are internal plumbing exposed as if they were a
user-facing API. The published surface is wider than the use
case.

**Fix:** Drop the three names from the public barrel. If
advanced users ever need to hand-wire a cache layer, document a
`@baerly/adapter-cloudflare/cache` subpath then. The agent-facing
barrel stays small.

## 4. Two cache-test files with overlapping names but different scopes

- `packages/adapter-cloudflare/src/cache.test.ts` (271 LoC) —
  cache mechanics (LRU eviction, key derivation, TTL).
- `packages/adapter-cloudflare/src/cache-status.test.ts` (370
  LoC) — *worker-level* integration under real workerd /
  miniflare, testing the canonical-line `cache_status` field
  appended to logs.

Both files start with `cache`; only one is actually a
cache-module test. The second is really a worker test that
happens to assert a cache discriminator.

**Fix:** Rename `cache-status.test.ts` →
`worker-cache-discriminator.test.ts`, and move it next to
`worker.test.ts` if there is one. Discoverability fix only — no
code change.

## Why bundle

All four touch `packages/adapter-cloudflare/src/cache*.ts`. Item
1 is the load-bearing decision (drop the LIST index or not);
items 2 and 3 are downstream of that. Item 4 is a one-line
rename that goes in the same PR.

## Cross-references

- F19 (`adapter-error-envelope-unify.md`) — also touches CF
  worker top-level paths; coordinate if both land in the same
  release.
