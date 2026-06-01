---
title: Mutation testing
audience: maintainer
summary: "Manual StrykerJS mutation testing scoped to the protocol kernel: pnpm test:mutate."
last-reviewed: 2026-05-31
tags: [testing, mutation, stryker, protocol]
related: ["./conventions/tests.md", "../../CLAUDE.md"]
---

# Mutation testing

Mutation testing measures **test quality**, not coverage. StrykerJS makes
small edits ("mutants") to the source — flipping `<` to `<=`, dropping a
negation, replacing a return value — then runs the tests. A mutant that
makes a test fail is "killed"; one that survives means no test asserts on
that behavior. A surviving mutant is a concrete, reproducible test gap.

## Scope

We mutate only the **pure protocol kernel** (`packages/protocol/src/**`):
hashing, JSON merge-patch, the query algebra, base-32 LSN encoding,
log/time helpers. These modules are logic-dense, have no I/O, and run
against fast deterministic unit tests — the regime where mutation testing
has the best signal-per-second. The server, adapters, and Workerd/Minio-
gated suites are deliberately out of scope: they are slower and entangled
with infrastructure, which makes mutation runs both slow and flaky.

## Running it

```sh
pnpm test:mutate
```

This is a **manual, on-demand tool**. It is intentionally NOT part of
`pnpm verify`, `pnpm test`, or CI — a full run mutates ~1700 mutants and
takes several minutes, far past the budget of the per-commit gate. It
exits 0 regardless of score (`thresholds.break: null`); it reports, it
does not gate.

Output:
- A clear-text mutation-score table per file in the terminal.
- An HTML report at `reports/mutation/protocol.html` (gitignored) — open
  it in a browser to see each surviving mutant inline in the source.

## Reading the report

Each file gets a mutation score = killed / (killed + survived + no-coverage).
Open the HTML report and look for **survived** mutants: each one is a
specific edit the tests did not catch. Either add an assertion that kills
it, or — if the mutant is genuinely equivalent (no observable behavior
change) — leave it; equivalent mutants are an inherent noise floor of the
technique, not a bug to fix.

## Current baseline

As of 2026-05-31, the protocol kernel scores **70.44% overall** (78.25%
counting only covered mutants), across 1742 mutants. The exact percentage
drifts by a fraction of a point run-to-run as timeout-classified mutants
shift with machine timing — treat these as a baseline, not a fixed target.
Lowest scorers worth attention:

- `packages/protocol/src/errors.ts` — 10% (error classes are exercised
  only incidentally; almost nothing asserts on their shape)
- `packages/protocol/src/constants.ts` — 25% (constants are used
  indirectly but no test asserts their specific values)
- `packages/protocol/src/query/_internals.ts` — 47% (internal query
  algebra helpers, partial coverage)
- `packages/protocol/src/coordination/gc-pending.ts` — 56% (GC state
  machine; CAS/write paths exercised only lightly at this layer)

These are starting points for raising test quality, not a gate.

## Design notes

- **No TypeScript checker plugin.** Stryker can pre-filter mutants that
  fail to compile via `@stryker-mutator/typescript-checker`, but that
  plugin runs real `tsc`; this repo typechecks with tsgo. Rather than add
  a divergent toolchain, we skip it — a type-invalid mutant just runs
  through vitest's esbuild transform and is killed (or survives) on its
  own. The cost is a slightly slower run, not wrong results.
- **Dedicated vitest config.** `stryker.vitest.config.ts` is a flat
  single-project config scoped to protocol unit tests, kept separate from
  the root `vitest.config.ts` so the Workerd `cloudflare-pool` project and
  the whole-repo globs never enter a mutation run.
- **`--js-base-64` lives in `testRunnerNodeArgs`, not vitest `execArgv`.**
  `bytes.ts` / hashing use `Uint8Array.{toBase64,fromBase64}`, gated behind
  the V8 `--js-base-64` flag on Node 24. Stryker's vitest-runner forces a
  `worker_threads` pool, and worker threads reject that flag as an
  `execArgv` value (`ERR_WORKER_INVALID_EXEC_ARGV`). So the flag is set
  via `testRunnerNodeArgs` in `stryker.config.mjs` on the runner host
  process, which the worker threads inherit. Without it, the base64 paths
  would throw and their mutants would report as false "killed".
- **Explicit `vitest-runner` in `plugins`.** Under pnpm's isolated
  `node_modules`, Stryker's default `@stryker-mutator/*` plugin glob does
  not resolve `@stryker-mutator/vitest-runner` from the project root, so
  it is listed explicitly in `stryker.config.mjs`.
