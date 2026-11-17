---
title: Conventions for bundle budgets
audience: coder
summary: The three size axes, the delta gate, the accumulation ratchet, why absolute ceilings are almost never the right tool, and what to do when the gate goes red.
last-reviewed: 2026-11-16
tags: [conventions, bundle-size, performance]
related: [tests.md, "../../architecture.md"]
---

# Bundle budget conventions

`bundle-sizes.json` is the committed record of every measured entry. `pnpm bundle-sizes` compares a fresh build against it.

## The three axes

The library ships **unminified**; a consumer's bundler re-minifies before production. So the unminified numbers are not what anyone pays.

| axis | what it is | status |
| --- | --- | --- |
| `raw` | unminified bytes | diagnostic + cold-start parse proxy |
| `gz` | gzip of unminified bytes | diagnostic; the raw-to-gz gap separates duplicated boilerplate from genuinely new code |
| `min-gz` | esbuild-minify each chunk, then gzip | **the consumer-facing cost.** Conservative upper bound — per-chunk syntax minify only, no cross-module tree-shaking |

Comments and JSDoc ship un-stripped, so they cost `raw` and `gz` but vanish from `min-gz`. **Never trim documentation or error-message text to satisfy `raw`/`gz`.** Doc and error quality outweigh bytes nobody pays.

## The gate

Three checks, each per entry and per axis.

**Delta gate** — fails when an axis grows more than `max(tier%, 256 B)` over its committed baseline. Catches jumps.

| tier      | rate | axes            | applies to                                                |
| --------- | ---- | --------------- | --------------------------------------------------------- |
| `shipped` | 2%   | raw, gz, min-gz | anything that can enter a deployed bundle                 |
| `tooling` | 10%  | raw             | dev/CLI-only surfaces; catches a heavy dep bundled inline |

The 2% rate is derived from this repo's history: measured deltas run at a median of 0.79% and p75 of 1.62%, then jump to 5.15% at p90. 2% sits in that gap. Do not retune it to make a change fit. The underlying series is the 184 dated baseline notes this policy replaced; they live in the history of `tests/integration/bundle-size.test.ts` (`git log -p --follow` it, or read it at `a0a608e0`, the last commit that carried them). A representative slice is replayed as a backtest in `tests/unit/bundle-snapshot.test.ts`.

A known consequence: `gz` is gated at the same rate as `min-gz`, so a comment-dominated change can trip the diagnostic axis while the axis that bills a consumer barely moves. That costs a `--write` and a sentence, which is cheaper than the alternative of leaving prose growth unmeasured. Retune on an accumulated pattern, not on the first change it inconveniences.

**Ratchet** — bounds accumulated growth, which the delta gate cannot: it re-arms at every baseline, so many individually-allowed increments can drift a long way with every commit green. Each tier-gated axis carries a `ratchet` bound in `bundle-sizes.json`, and the gate fails when a measurement exceeds it — or when the bound is stale (below).

Nobody picks the number. `--write` derives it from the measurement as `roundUp(measured × 1.1)` to the next multiple of 256 B (`policy.ratchet`: `headroomPercent`, `roundBytes`; integer arithmetic, so the same build always writes the same bytes), and maintains it in one direction only:

- **missing** → seeded from the current measurement;
- **measurement shrinks** → lowered to the derived value. Until it is, the bound is **stale** and `pnpm bundle-sizes` (and the committed-snapshot test) fails, telling the author to run `--write`. So a win locks in without anyone remembering to tighten: a shrink cannot land unbanked, and a later regrowth back to the old size meets the lowered bound;
- **measurement grows** → never raised. Growth inside the bound passes and leaves it where it is; growth past it fails, and `--write` refuses.

A shrink too small to move the derived value is not stale — the rounding absorbs it, which keeps an incidental few-byte drop from demanding a rebaseline.

The 10% headroom keeps the ratchet from becoming a zero-growth gate: ordinary changes clear the delta gate and rebaseline without touching the bound, and only a sustained walk — several `--write`s' worth — reaches it. Loosening it is then a deliberate edit (see below), never a side effect of regenerating.

**Absolute ceilings** — a hard limit `--write` refuses to cross. Exactly one entry has one, and it is not a size budget: `app-config.js` is capped at 1024 B raw / 512 B gz to assert that the entry has **no runtime closure at all**. It should be 167 B of erased types plus an identity function, and a percentage gate on 167 B would be meaningless. The ceiling encodes a structural fact, so a violation means something real changed in kind.

**No entry carries a ceiling set a round number above its measurement**, and that is deliberate. Such a number cannot be derived and cannot be defended in review — it is a copy of whatever the entry weighed on the day someone wrote it down, and it drifts as the measurement drifts. It also fails in the way this whole policy exists to prevent: it fires on ordinary prose, the next author rebaselines it reflexively, and the gate stops being read.

The two jobs such a ceiling pretends to do are done better elsewhere:

- **Creep** → the delta gate, which is relative and self-rebaselining, plus the ratchet for creep that accumulates across rebaselines. Both are derived from measurements, so neither is a number anyone defends.
- **Composition** → the closure tests in `tests/integration/bundle-size.test.ts`.

This repo has direct evidence for that split. When `packages/adapter-cloudflare/src/worker.ts` imported `renderDevLanding` from the `@baerly/dev` barrel, the barrel re-exported `LocalFsStorage` and rolldown chunked the entire Node-only local-fs closure — `node:crypto`, `node:fs/promises`, `node:os`, `node:path` — into every deployed Worker. **All three byte budgets on `cloudflare.js` passed.** The structural Workerd-builtin assertion is what caught it. Reach for a test, not a number.

The ratchet and the `app-config.js` ceiling are separate fields with separate jobs. `--write` never edits `hardCeiling`, and a raised ratchet does not loosen it. On `app-config.js` the ratchet (256 B, one rounding unit) sits below the ceiling (1024 B raw / 512 B gz), so growth there trips the ratchet first; a ratchet failure on that entry is the early warning, and the ceiling is still the structural assertion behind it.

## When the gate goes red

**A delta violation.** Ask whether the growth is intended. If yes:

    pnpm bundle-sizes --write

and say why in the commit message. That is the whole ritual — do not add a changelog entry to any file. If the growth is _not_ intended, you have found a real regression: look at which chunk joined the closure.

**A stale ratchet.** The entry shrank and the snapshot has not banked it. Run `pnpm bundle-sizes --write` and commit the result; nothing else to decide.

**A ratchet violation.** The entry has grown past the bound `--write` last derived — the smallest size any `--write` has recorded since the ratchet was seeded, plus 10% rounded up to the next 256 B (so more than 10% on small entries: `app-config.js`'s 147 B raw carries a 256 B bound) — across however many rebaselines that took. If the growth is intended, raise the bound by hand: set `entries["<entry>"].ratchet.<axis>` in `bundle-sizes.json` to the value the failure message prints (the measurement plus the standard headroom), run `pnpm bundle-sizes --write` to refresh the baselines, and say in the commit message why the entry is now allowed to be that large. `--write` cannot do the raise for you — that is the point. A bound hand-set above the derived value is pulled back down by the next `--write`, so there is no way to bank extra headroom. Deleting a `ratchet` axis (or the whole `ratchet` object) is the same edit by another route: `--write` reseeds it from the current measurement, exactly as high as a hand raise would set it, so it is equally a deliberate loosening that needs a reason in the commit message. If the growth is not intended, treat it like a delta violation: find what joined the closure.

**A ceiling violation** (only reachable on `app-config.js`). Not clearable by `--write`; the CLI refuses. This one does not mean "too big" — it means the entry acquired a runtime closure it is not supposed to have. Find what got imported. Raising the number is almost certainly the wrong fix.

## Adding a published entry

A new subpath in `publishConfig.exports` must be added to `bundle-sizes.json` with a `tier` and a `note`. A test enforces this, so a new export cannot silently escape gating. `pnpm bundle-sizes --write` then fills in its baselines and seeds its ratchet; until it does, every other mode refuses to run.

## Regenerating a baseline

Never copy `bundle-sizes.json` from another branch or carry an earlier rebaseline forward through a history rewrite — a committed baseline can carry the writing machine's toolchain/lockfile drift on entries your branch never touched, which quietly raises the ceiling on those entries so a genuine regression there lands green. Run `pnpm bundle-sizes --write` fresh on each branch tip, then read the diff and confirm every moved entry is one whose closure you actually changed. An entry moving that you can't explain by your own diff means stale `dist/` or a lockfile difference — fix that first. A carried-over ratchet higher than your build derives shows up as stale, and `--write` lowers it; a carried-over baseline can still hide a regression under the delta gate.

The other direction: `main`'s own committed baseline can itself be stale, not just a branch's. If the gate fails by far more than your diff explains, `git stash` (or WIP-commit) your work, `git reset --hard origin/main`, and run `pnpm bundle-sizes --report` on pure `main` — if main doesn't measure zero against its own committed baseline, that drift predates your branch. Land the refresh as its own `chore` commit with the measured table, then your feature commit on top, so the feature's numbers are attributable to it alone.

## The common regression

A helper co-located with heavy runtime drags that whole module into every closure that imports it. The fix is a zero-import leaf module. This has happened: three resolution-string constants in `constants.ts` pulled a chunk carrying ~10 KiB of kernel-tuning JSDoc into `auth.js`'s closure, +21% raw, until they were moved to `auth-resolution.ts`.
