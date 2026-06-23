---
title: Mutation testing
audience: maintainer
summary: "Manual StrykerJS mutation testing scoped to the protocol kernel: pnpm test:mutate."
last-reviewed: 2026-06-23
tags: [testing, mutation, stryker, protocol]
related: ["./conventions/tests.md", "../../CLAUDE.md"]
---

# Mutation testing

Coverage can tell you that a line ran. It cannot tell you whether a test
would notice if that line made the wrong decision. Mutation testing asks that
second question.

StrykerJS makes small edits ("mutants") to the source — flipping `<` to
`<=`, dropping a negation, replacing a return value — then runs the tests. A
mutant that makes a test fail is "killed"; a mutant that leaves the suite
green has survived. A non-equivalent survivor is not a vague score problem.
It is a concrete, reproducible behavior that no test pins down.

## Scope

Mutation testing runs the suite over and over, so it only pays off where each
experiment is cheap and deterministic. For that reason we mutate only the
**pure protocol kernel** (`packages/protocol/src/**`): hashing, JSON
merge-patch, the query algebra, base-32 LSN encoding, log/time helpers. These
modules are logic-dense and run against fast deterministic unit tests with no
external infrastructure.

The server, adapters, and Workerd/Minio-gated suites are deliberately out of
scope. They test important behavior, but they are slower and entangled with
infrastructure, which makes mutation runs both slow and flaky.

## Running it

```sh
pnpm test:mutate
```

This is a **manual, on-demand reporting tool**. It is intentionally NOT part
of `pnpm verify`, `pnpm test`, or CI: a full run mutates well over a thousand
mutants and takes several minutes. Because `thresholds.break: null`, the
command exits 0 regardless of score.

Output:
- A clear-text mutation-score table per file in the terminal.

File artifacts under gitignored `reports/mutation/`:
- A machine-readable `mutation.json` (mutation-testing-elements schema).
- An HTML report at `reports/mutation/protocol.html` — a renderer over that
  same JSON; open it in a browser to see each surviving mutant inline in the
  source.

Config note: `stryker.config.mjs` passes
`testRunnerNodeArgs: ["--js-base-64"]` to the Stryker child-process host.
The vitest runner uses worker threads, and worker threads reject that flag in
`execArgv`; passing it to the host lets the threads inherit Uint8Array base64
support so bytes/hashing mutants are not falsely reported as killed.

### Agent-readable survivor list

After `pnpm test:mutate` has produced `reports/mutation/mutation.json`, treat
that JSON as the source of truth for the kill loop. The HTML report renders
the same JSON, but it is poor for LLMs and tedious to scan.

`pnpm mutate:survivors` (`scripts/mutation-survivors.mjs`) parses the JSON
into a terminal worklist grouped by file, worst-first. Each row shows a
`Survived` / `NoCoverage` mutant as
`status  Lline  MutatorName → replacement`, and the command exits non-zero
while any remain. Scope the mutation run with
`pnpm exec stryker run --mutate "<path>"`; filter the survivor display with
`pnpm mutate:survivors --file <substr>`. The `json` reporter is wired in
`stryker.config.mjs`; `incremental: true` lets the scoped re-run reuse cached
results so the loop is seconds, not minutes.

## Reading the report

Each file gets a mutation score =
(killed + timeout) / (killed + timeout + survived + no-coverage). Stryker
excludes ignored, pending, runtime-error, and compile-error mutants from that
denominator. Use the score as a triage summary, not as the thing to optimize
directly.

Run `pnpm mutate:survivors` (or open the HTML report). If any `NoCoverage`
rows exist, handle those first; otherwise start with **survived** mutants. For
each survivor, make a binary decision: add an assertion that kills it, or
prove that the mutant is equivalent, meaning the edit creates no observable
behavior change. Retire only genuine equivalents with a documented
`// Stryker disable next-line <MutatorName>: <reason>` on the line above.
Equivalent mutants are an inherent noise floor; the disable comment's reason
*is* the record of why it is unkillable.

### Coverage-first workflow

Close `NoCoverage` before chasing `Survived`. A `NoCoverage` mutant means the
mutated range was not executed by any covering test, and
`pnpm test:coverage:protocol` (v8 coverage scoped to the kernel) finds those
ranges in seconds.

Once coverage gaps are closed, the mutation pass spends its time on the
residual that coverage cannot see: covered-but-unasserted behavior. For
boundary and relational logic, property tests (`@fast-check/vitest`) are the
best mutant-killer. One invariant checked against a brute-force oracle can
kill a whole family of `<`/`<=`/`===` mutants at once.

### Two recurring equivalence patterns

Equivalent survivors are the place to be strict. Suppress only when you can
name the mechanism that makes the changed program behave the same. In this
repo, a survivor that looks equivalent is almost always one of these:

1. **Redundant guard caught downstream.** A short-circuit type/range check
   whose rejected inputs are caught by a later check with the *same* error
   code (e.g. `typeof x !== "number" || !Number.isInteger(x)` — the `typeof`
   half is redundant because `Number.isInteger` already rejects non-numbers;
   or a guard around a loop/block whose body is a no-op for the guarded-out
   case). Forcing such a guard to `false` is equivalent; forcing it to `true`
   is usually *killable* (valid inputs then misbehave) and stays tested. Stryker
   cannot disable only one direction of a `ConditionalExpression`, so a
   line-level disable that also covers the killable direction is acceptable
   only when another mutator on the same logic is killed by an explicit
   assertion.
2. **ES2025 class-field define.** This repo compiles with `target: ES2025`,
   so a declared optional field `readonly foo?: T;` is *define*-emitted: the
   own property exists (valued `undefined`) on every instance. Therefore
   `"foo" in instance` is always `true`, and a constructor guard
   `if (foo !== undefined) this.foo = foo` is a genuinely equivalent mutant
   when forced to `true` (assigning `undefined` over an already-`undefined`
   field changes nothing). Suppress that case instead of adding an `"in"` test.

Before committing a suppression, check that it is not hiding something
killable. Temporarily remove the disable comments in the working tree, re-run
the scoped mutation, verify that the survivors are *exactly* the equivalent
directions, then restore the suppression before committing.

## Constants policy

`constants.ts` creates a different question: should a test promise this exact
literal to the outside world? A mutant on a constant only dies if a test
asserts the constant's exact value, so pin a value with a test **only when it
is an off-process contract**: observed on the wire, in the bucket, or by
another implementation (content-types, schema-version numbers, key
prefixes/separators, the base-32 alphabet, magic filenames, operator-facing
error strings that `baerly doctor` matches).

For **internal tuning** values (budgets, ceilings, timeouts, grace periods,
buffer sizes), the exact number is not a contract. Asserting it would only
mirror the source, so retire those mutants with a
`// Stryker disable next-line <MutatorName>: internal tuning value …` instead
of a test.

## Current baseline

As of 2026-06-01, the protocol kernel scores **100.00% overall** (100% on
covered mutants), across ~1600 mutants. Every non-equivalent mutant is killed;
genuine equivalents are documented in-source with
`// Stryker disable next-line <MutatorName>: <reason>`.

Treat that baseline as a regression target, not as a promise that every run
prints the same decimal or mutant count. The exact percentage can drift when
mutants move between detected, undetected, valid, and invalid categories. The
intended steady state is 100%, and a *new* surviving mutant (one not behind a
documented disable) is a test-quality regression to close.

Regenerate the live picture any time with `pnpm test:mutate` then
`pnpm mutate:survivors` (expect `TOTAL Survived=0 NoCoverage=0`). When you add
or change kernel code, run the scoped mutation on the file you touched
(`pnpm exec stryker run --mutate "<path>"`) and kill or document any new
survivor before merging.

> **Stale incremental cache.** `incremental: true` occasionally reports a
> stale `Survived` for a module-level `static` mutant (a top-level
> `const`/arrow/object evaluated at import time) whose covering tests changed.
> If a survivor looks impossible — a constant you clearly assert on — delete
> `reports/mutation/stryker-incremental.json` and re-run before concluding it
> is equivalent. Do **not** suppress a static-mutant survivor without first
> clearing the cache; that masks a killable mutant behind a false equivalence.

## Design notes

- **No TypeScript checker plugin.** Stryker can pre-filter mutants that
  fail to compile via `@stryker-mutator/typescript-checker`, but that
  plugin runs real `tsc`; this repo typechecks with tsgo. Rather than add
  a divergent toolchain, we skip it — a type-invalid mutant runs
  through vitest's esbuild transform and is killed (or survives) on its
  own. The cost is a slightly slower run, not wrong results.
- **Dedicated vitest config.** `stryker.vitest.config.ts` is a flat
  single-project config scoped to protocol unit tests, kept separate from
  the root `vitest.config.ts` so the Workerd `cloudflare-pool` project and
  the whole-repo globs never enter a mutation run.
- **Explicit `vitest-runner` in `plugins`.** Under pnpm's isolated
  `node_modules`, Stryker's default `@stryker-mutator/*` plugin glob does
  not resolve `@stryker-mutator/vitest-runner` from the project root, so
  it is listed explicitly in `stryker.config.mjs`.
