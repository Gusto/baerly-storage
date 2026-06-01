---
title: Mutation testing
audience: maintainer
summary: "Manual StrykerJS mutation testing scoped to the protocol kernel: pnpm test:mutate."
last-reviewed: 2026-06-01
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

Output (all under gitignored `reports/mutation/`):
- A clear-text mutation-score table per file in the terminal.
- A machine-readable `mutation.json` (mutation-testing-elements schema).
- An HTML report at `protocol.html` — a renderer over that same JSON;
  open it in a browser to see each surviving mutant inline in the source.

### Agent-readable survivor list

The HTML report is poor for LLMs and tedious for a kill loop. `mutation.json`
is the real artifact — the HTML is just a view of it. `pnpm mutate:survivors`
(`scripts/mutation-survivors.mjs`) parses it into a terminal worklist grouped
by file, worst-first, listing each `Survived` / `NoCoverage` mutant as
`status  file:line  MutatorName → replacement`, and exits non-zero while any
remain. Scope a single file with `--file <substr>`. The `json` reporter is
wired in `stryker.config.mjs`; `incremental: true` lets a per-file re-run
(`pnpm exec stryker run --mutate "<path>"`) reuse cached results so the loop
is seconds, not minutes.

## Reading the report

Each file gets a mutation score = killed / (killed + survived + no-coverage).
Run `pnpm mutate:survivors` (or open the HTML report) and look at **survived**
mutants: each is a specific edit the tests did not catch. Either add an
assertion that kills it, or — if the mutant is genuinely equivalent (no
observable behavior change) — retire it with a documented
`// Stryker disable next-line <MutatorName>: <reason>` on the line above.
Equivalent mutants are an inherent noise floor; the disable comment's reason
*is* the record of why it is unkillable.

### Coverage-first workflow

A `NoCoverage` mutant is, by definition, a line no test executes — and
`pnpm test:coverage:protocol` (v8 coverage scoped to the kernel) finds those
in seconds, where mutation spends minutes mutating code no test runs. So the
cheap order is: close coverage gaps first, then mutation-test, so the slow
pass only ever works the `Survived` residual (covered-but-unasserted) — the
signal coverage is blind to. Property tests (`@fast-check/vitest`) are the
best mutant-killer for boundary/relational logic: one invariant checked
against a brute-force oracle kills a whole family of `<`/`<=`/`===` mutants
at once.

### Two recurring equivalence patterns

When a survivor looks equivalent, it is almost always one of these — verify
before suppressing, and cite the specific reason:

1. **Redundant guard caught downstream.** A short-circuit type/range check
   whose rejected inputs are caught by a later check with the *same* error
   code (e.g. `typeof x !== "number" || !Number.isInteger(x)` — the `typeof`
   half is redundant because `Number.isInteger` already rejects non-numbers;
   or a guard around a loop/block whose body is a no-op for the guarded-out
   case). Forcing such a guard to `false` is equivalent; forcing it to `true`
   is usually *killable* (valid inputs then misbehave) and stays tested — but
   Stryker can't disable one direction of a `ConditionalExpression`, so a
   line-level disable that also covers the killable direction is fine as long
   as another mutator on the same logic is killed by a real assertion.
2. **ES2025 class-field define.** This repo compiles with `target: ES2025`,
   so a declared optional field `readonly foo?: T;` is *define*-emitted: the
   own property exists (valued `undefined`) on every instance. Therefore
   `"foo" in instance` is always `true`, and a constructor guard
   `if (foo !== undefined) this.foo = foo` is a genuinely equivalent mutant
   when forced to `true` (assigning `undefined` over an already-`undefined`
   field changes nothing). Don't try to kill it with an `"in"` test — suppress
   it.

To confirm a suppression isn't masking something killable, strip the disable
comments and re-run the scoped mutation: the survivors that reappear should be
*exactly* the equivalent directions, with the killable directions still shown
as killed.

## Constants policy

`constants.ts` is a special case: a mutant on a constant only dies if a test
asserts that constant's exact value. Pin a value with a test **only when it
is an off-process contract** — observed on the wire, in the bucket, or by
another implementation (content-types, schema-version numbers, key
prefixes/separators, the base-32 alphabet, magic filenames, operator-facing
error strings that `baerly doctor` matches). For **internal tuning** values
(budgets, ceilings, timeouts, grace periods, buffer sizes) the exact number
is not a contract — asserting it would be a tautological change-detector that
mirrors the source — so retire those mutants with a
`// Stryker disable next-line <MutatorName>: internal tuning value …` instead
of a test.

## Current baseline

As of 2026-06-01, the protocol kernel scores **93.04% overall** (95.13%
counting only covered mutants), across ~1740 mutants — up from 70.44% /
78.10%. The exact percentage drifts by a fraction of a point run-to-run as
timeout-classified mutants shift with machine timing — treat these as a
baseline, not a fixed target.

These seven logic-dense files were hardened to **100%** (every non-equivalent
mutant killed; genuine equivalents documented with `// Stryker disable`):
`query/_internals.ts`, `errors.ts`, `coordination/gc-pending.ts`,
`constants.ts`, `query/validate.ts`, `query/satisfiable.ts`, and
`coordination/current-json.ts`.

Remaining gaps (deferred lower-value tail, ~114 mutants) — surface them any
time with `pnpm mutate:survivors`:

- `query/matches.ts` (25), `storage/probe-cas.ts` (25),
  `storage/memory.ts` (17), `query/normalize.ts` (15),
  `query/builder.ts` (9), `json.ts` (7), `types.ts` (7), `time.ts` (4),
  `query/wire.ts` (2), `app-config.ts` (1), `hashing.ts` (1), `log.ts` (1).

These are starting points for raising test quality, not a gate.

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
