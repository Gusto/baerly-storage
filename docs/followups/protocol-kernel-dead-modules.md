# Protocol kernel: delete post-feature-removal residue and speculative scaffolding

**Severity: MEDIUM. Pure cleanup; no behaviour change.**

`@baerly/protocol` is the implementation-private kernel
(`packages/protocol/package.json:5`: "Internal protocol kernel
— implementation detail of @baerly/server. Not a public API").
Deletion freedom is real — no external consumer can reach these
symbols. Two themes:

1. **Syncer-deletion residue.** Commit `1711ee1` (2026-05-11)
   *feat!: delete src/ and repoint publish at @baerly/server*
   removed a 538-line `src/syncer.ts`. Several constants and most
   of `time.ts` were live consumers; they were orphaned but never
   removed.
2. **Speculative scaffolding.** Helpers added without a caller in
   the visible git history — bloom-filter b64 helpers, `OMap`,
   the non-spec `json.ts` operators (`diff`, `fold`, `clone`).
   Built ahead of features that didn't land.

Total cleanup: ~200 LoC + 4 small test blocks.

---

## 1. Dead constants in `packages/protocol/src/constants.ts`

| Constant | Line | Consumers outside `constants.ts` |
|---|---|---|
| `MANIFEST_LIST_LOOKAHEAD_MILLIS` | 28 | 0 |
| `SYNCER_CLOCK_SKEW_MAX_RETRIES` | 103 | 0 |
| `MEM_CACHE_CAPACITY` | 136 | 0 (only a JSDoc `@link` from `MAX_PARALLEL_LOG_READS` at L119) |
| `ORPHAN_MANIFEST_GRACE_MILLIS` | 158 | 0 (only a JSDoc `@link` from `GC_GRACE_PERIOD_MILLIS` at L228) |

JSDoc on all four references the now-deleted `Syncer` class
(`@see syncer.ts`, etc.).

`SESSION_ID_LENGTH` (L52) has 3 live consumers in
`packages/server/src/server-writer.ts:49,359,435` — **keep it**.

**Action:**

- Delete the four dead constants.
- Strip the stale `@link MEM_CACHE_CAPACITY` from
  `MAX_PARALLEL_LOG_READS` (L119) and the
  `Distinct from ORPHAN_MANIFEST_GRACE_MILLIS` paragraph from
  `GC_GRACE_PERIOD_MILLIS` (L228-233).
- Leave `SESSION_ID_LENGTH` alone.

---

## 2. `time.ts:adjustClock` + `measure` + `dateToSecs` + `AdaptiveClockConfig`

`packages/protocol/src/time.ts`:

- `AdaptiveClockConfig` (L10-14) — interface used only by
  `adjustClock`.
- `dateToSecs` (L21-23) — single consumer:
  `packages/protocol/src/time.test.ts:2`.
- `measure` (L25-28) — referenced only inside `adjustClock`.
- `adjustClock` (L30-72) — 0 callers anywhere. The current
  `S3HttpStorage` constructor (`packages/protocol/src/storage/s3-http.ts:164-172`)
  takes no `adaptiveClock` or `clockOffset` option.

These were the syncer's adaptive-NTP-replacement; killed when
`src/syncer.ts` died in `1711ee1`.

**Live exports to keep:** `timestamp` (manifest-key generation),
`delay` (used by `S3HttpStorage` retry).

**Action:**

- Delete `AdaptiveClockConfig`, `adjustClock`, `measure`,
  `dateToSecs`.
- Delete `packages/protocol/src/time.test.ts` — its only
  imports are `dateToSecs` and (transitively) `adjustClock`.
- If a future S3HttpStorage retry-jitter test needs a `delay`
  smoke test, write it fresh.

---

## 3. `hashing.ts` bloom-filter b64 helpers

`packages/protocol/src/hashing.ts`:

- Type `b64` (L3) — 0 production callers.
- `toB64` (L5) — 0 production callers.
- `fromB64` (L7) — 0 production callers.
- `or` (L9) — 0 production callers.
- `inside` (L17) — 0 production callers.

Only `packages/protocol/src/hashing.test.ts` (the `b64/uint`
block at L6-11 and the `or and inside` block at L35-61) refers to
these. The version-id generator `versionFromContent` (L49) is
the only live consumer of `hashing.ts` — used by
`packages/server/src/server-writer.ts:54,581` and
`packages/server/src/gc.ts:62,451,466`.

These helpers predate the workspace carve and were scaffolding
for a bloom-filter feature that never shipped.

**Action:**

- Delete `toB64`, `fromB64`, `or`, `inside`, type `b64`.
- Trim `hashing.test.ts` to keep only the `versionFromContent`
  describe block (L13-33).
- Consider renaming `hashing.ts` → `version.ts` (post-trim it
  only houses `versionFromContent`). Optional — separate decision.

---

## 4. `o-map.ts`: `OMap` never had a real consumer

`packages/protocol/src/o-map.ts:1` defines `OMap<K,V>`. Barrel
re-exports it at `packages/protocol/src/index.ts:7` (`export *
from "./o-map.ts"`), but:

- `@baerly/server`'s barrel does NOT re-export it (no external
  reach).
- `grep -rn OMap packages/ tests/ examples/ bench/ manual-e2e/`
  finds zero consumers outside `o-map.test.ts`.
- Single-touch since the `mps3 → baerly-storage` rename — never
  had a real consumer in the visible history.

**Action:**

- Delete `packages/protocol/src/o-map.ts`.
- Delete `packages/protocol/src/o-map.test.ts`.
- Remove L7 from `packages/protocol/src/index.ts`.

---

## 5. `json.ts:diff` / `fold` / `clone`

`packages/protocol/src/json.ts`:

- `merge` (L16) — **live, keep**. Spec-mandated RFC-7386 patch.
  Used by `packages/server/src/query.ts:481` and
  `tests/integration/export-smoke.test.ts:3`.
- `diff` (L60) — 0 external callers. Only
  `packages/protocol/src/json.test.ts` imports it.
- `fold` (L47) — 0 callers anywhere outside its own test.
  Mentions in `packages/server/src/query.ts:734,853` are
  comments, not calls.
- `clone` (L9) — 0 callers anywhere. (`Response.clone()` hits
  elsewhere are DOM API, unrelated.)

`diff` had a real bugfix at `3c14e31 fix(json): diff() walks
union of keys, not parallel index` predating the workspace carve
— a feature that didn't land in the new shape. `fold` and
`clone` are similar speculative scaffolding.

**Action:**

- Delete `diff`, `fold`, `clone` from `json.ts`.
- Trim the matching describe blocks from `json.test.ts`. Keep
  the `merge` block — it pins spec conformance and the
  prototype-pollution defence (`FORBIDDEN_MERGE_KEYS`) that
  `query.runUpdate` relies on.
- Keep all type exports (`JSONArrayless*`, `JSONValue`,
  `JSONObject`).

---

## Verification

After each section:

- `pnpm verify` — typecheck + lint pass.
- `pnpm test` — all default-project tests pass.
- `pnpm test:randomize FC_NUM_RUNS=2000` (optional) — confirm
  the property cascade still terminates cleanly.

Order the sections in any order; each is independent. Sections
1 and 2 are the highest-confidence (clear residue commit);
sections 3-5 are slightly more speculative-feeling but the audit
found zero callers.

## Out of scope

- `claimWriter` and `WriterFence.lease_until` in
  `packages/protocol/src/coordination/current-json.ts` —
  documented reserved-for-future on `@baerly/server`'s public
  barrel (`packages/server/src/index.ts:101-104`). Deletion is a
  public-API change. Defer to a dedicated public-API-pruning
  workstream.
