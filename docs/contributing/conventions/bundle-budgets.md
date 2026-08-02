---
title: Conventions for bundle budgets
audience: coder
summary: The three size axes, the delta gate, why absolute ceilings are almost never the right tool, and what to do when the gate goes red.
last-reviewed: 2026-08-02
tags: [conventions, bundle-size, performance]
related: [tests.md, "../../architecture.md"]
---

# Bundle budget conventions

`bundle-sizes.json` is the committed record of every measured entry.
`pnpm bundle-sizes` compares a fresh build against it.

## The three axes

The library ships **unminified**; a consumer's bundler re-minifies before
production. So the unminified numbers are not what anyone pays.

| axis | what it is | status |
| --- | --- | --- |
| `raw` | unminified bytes | diagnostic + cold-start parse proxy |
| `gz` | gzip of unminified bytes | diagnostic; the raw-to-gz gap separates duplicated boilerplate from genuinely new code |
| `min-gz` | esbuild-minify each chunk, then gzip | **the consumer-facing cost.** Conservative upper bound — per-chunk syntax minify only, no cross-module tree-shaking |

Comments and JSDoc ship un-stripped, so they cost `raw` and `gz` but vanish
from `min-gz`. **Never trim documentation or error-message text to satisfy
`raw`/`gz`.** Doc and error quality outweigh bytes nobody pays.

## The gate

**Delta gate** — fails when an axis grows more than `max(tier%, 256 B)` over
its committed baseline. Catches jumps.

| tier | rate | axes | applies to |
| --- | --- | --- | --- |
| `shipped` | 2% | raw, gz, min-gz | anything that can enter a deployed bundle |
| `tooling` | 10% | raw | dev/CLI-only surfaces; catches a heavy dep bundled inline |

The 2% rate is derived from this repo's history: measured deltas run at a
median of 0.79% and p75 of 1.62%, then jump to 5.15% at p90. 2% sits in that
gap. Do not retune it to make a change fit. The underlying series is the 184
dated baseline notes this policy replaced; they live in the history of
`tests/integration/bundle-size.test.ts` (`git log -p --follow` it, or read it
at `a0a608e0`, the last commit that carried them). A representative slice is
replayed as a backtest in `tests/unit/bundle-snapshot.test.ts`.

A known consequence: `gz` is gated at the same rate as `min-gz`, so a
comment-dominated change can trip the diagnostic axis while the axis that
bills a consumer barely moves. That costs a `--write` and a sentence, which
is cheaper than the alternative of leaving prose growth unmeasured. Retune
on an accumulated pattern, not on the first change it inconveniences.

**Absolute ceilings** — a hard limit `--write` refuses to cross. Exactly one
entry has one, and it is not a size budget: `app-config.js` is capped at
1024 B raw / 512 B gz to assert that the entry has **no runtime closure at
all**. It should be 167 B of erased types plus an identity function, and a
percentage gate on 167 B would be meaningless. The ceiling encodes a
structural fact, so a violation means something real changed in kind.

**No entry carries a ceiling set a round number above its measurement**, and
that is deliberate. Such a number cannot be derived and cannot be defended in
review — it is a copy of whatever the entry weighed on the day someone wrote
it down, and it drifts as the measurement drifts. It also fails in the way
this whole policy exists to prevent: it fires on ordinary prose, the next
author rebaselines it reflexively, and the gate stops being read.

The two jobs such a ceiling pretends to do are done better elsewhere:

- **Creep** → the delta gate, which is relative and self-rebaselining.
- **Composition** → the closure tests in
  `tests/integration/bundle-size.test.ts`.

This repo has direct evidence for that split. When
`packages/adapter-cloudflare/src/worker.ts` imported `renderDevLanding` from
the `@baerly/dev` barrel, the barrel re-exported `LocalFsStorage` and rolldown
chunked the entire Node-only local-fs closure — `node:crypto`,
`node:fs/promises`, `node:os`, `node:path` — into every deployed Worker. **All
three byte budgets on `cloudflare.js` passed.** The structural
Workerd-builtin assertion is what caught it. Reach for a test, not a number.

> The accumulation hole is real and currently unplugged: the delta gate
> re-arms at each new baseline, so many individually-allowed increments can
> drift a long way. The intended fix is a **ratchet** — `--write` lowers a
> bound when a measurement drops and refuses to raise it, so wins lock in
> automatically and every loosening is a deliberate, reviewed edit. Tracked
> separately; it is a mechanism change, not a number.

## When the gate goes red

**A delta violation.** Ask whether the growth is intended. If yes:

    pnpm bundle-sizes --write

and say why in the commit message. That is the whole ritual — do not add a
changelog entry to any file. If the growth is *not* intended, you have found a
real regression: look at which chunk joined the closure.

**A ceiling violation** (only reachable on `app-config.js`). Not clearable by
`--write`; the CLI refuses. This one does not mean "too big" — it means the
entry acquired a runtime closure it is not supposed to have. Find what got
imported. Raising the number is almost certainly the wrong fix.

## Adding a published entry

A new subpath in `publishConfig.exports` must be added to
`bundle-sizes.json` with a `tier` and a `note`. A test enforces this, so a new
export cannot silently escape gating.

## The common regression

A helper co-located with heavy runtime drags that whole module into every
closure that imports it. The fix is a zero-import leaf module. This has
happened: three resolution-string constants in `constants.ts` pulled a chunk
carrying ~10 KiB of kernel-tuning JSDoc into `auth.js`'s closure, +21% raw,
until they were moved to `auth-resolution.ts`.
