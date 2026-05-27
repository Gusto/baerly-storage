# Cut scaffold test infrastructure (notes.test.ts + vitest devDeps)

**Status: REJECTED.** Kept under load-bearer exception #2
(empirical LLM ergonomics): pre-installed `vitest` + a single
round-trip test reduce zero-shot context burn — LLMs reach for
tests by default, and unsubsidised `pnpm install vitest` makes
lower-powered models burn context on tooling instead of code.

See `docs/about/thesis.md` §"What we keep even when it looks like ceremony"
and `docs/followups/promote-surface-admission-adr.md` test #6.

## Original analysis (preserved for context)

**Severity: MEDIUM. Pre-launch cut. DevDeps that exist only to
make `pnpm verify:examples` happy; teach the agent that prototype
baerly comes with a test harness pre-installed.**

Every scaffold ships an identical ~15-line round-trip test, a
standalone `vitest.config.ts` (which exists specifically to dodge
the Cloudflare Vite plugin), plus `vitest` + `happy-dom` +
`@types/node` in devDeps.

- `/Users/eric.baer/workspace/baerly-storage/examples/*/src/notes.test.ts`
- `/Users/eric.baer/workspace/baerly-storage/examples/*/vitest.config.ts`
- `/Users/eric.baer/workspace/baerly-storage/examples/*/package.json`
  (devDependencies blocks)

## The case for cutting

This is the canonical "devDeps that exist only to make
`pnpm verify:examples` happy" pattern. Each scaffold's `pnpm verify`
runs `typecheck && test`, where `test` runs *one* trivial
round-trip the kernel already covers in `tests/unit/`.

The thesis explicitly rejects ceremony — "an agent to generate
the *ceremony* of a real service that the operator never sees"
(thesis §"What this is"). Shipping `vitest@^4.1.5` +
`happy-dom@^20.9.0` + a hand-tuned `vitest.config.ts` (with
comments about pool/environment incompatibilities) teaches the
agent that a prototype-tier baerly app comes with a test harness
pre-installed.

The duplicated tests are also nearly byte-identical across all
four scaffolds — pure maintenance load with no consumer outside
`pnpm verify:examples`.

## What to do

1. Delete `notes.test.ts` from each scaffold's `src/`.
2. Delete `vitest.config.ts` from each scaffold root.
3. Drop `vitest`, `happy-dom`, and (if unused) `@types/node` from
   each scaffold's devDependencies.
4. Drop the `test` script from each scaffold's `package.json`.
5. Reduce each scaffold's `pnpm verify` to `typecheck` only.
6. Drop the `test` row from each scaffold's AGENTS.md
   verification table (if present).

## What gets harder after

- A user who wants to add a test writes `pnpm add -D vitest` and
  one config file. **Acceptable** — well-documented vitest
  pattern.
- The `pnpm verify:examples` gate becomes a typecheck-only gate.
  **Acceptable** — typecheck is the load-bearing check; the
  hello-world round-trip test was theater.

## Notes

Pairs naturally with `cut-scaffold-minimal-variants.md` — cutting
the minimals halves the surface this cut touches.

## Related cuts

- Part of the **scaffold weight** theme.
