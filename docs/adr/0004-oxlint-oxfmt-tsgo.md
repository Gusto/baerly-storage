# 0004 — oxlint / oxfmt / tsgo over the JS-native trio

## Context

Standard TypeScript projects use ESLint (lint), Prettier (format), and
`tsc` (typecheck). All three are mature, well-integrated, and slow —
ESLint and `tsc` in particular dominate verify-time on cold starts and
in CI.

We run `pnpm verify` (typecheck + lint) on every pre-commit. Slow
verify is a tax that compounds across every commit, every agent
iteration, every CI build that we don't have today but might.

## Decision

Use the Rust-implemented alternatives:

- `oxlint` for linting.
- `oxfmt` for formatting.
- `@typescript/native-preview` (`tsgo`) for typechecking — a Go
  reimplementation of `tsc`.

Same configuration model (TypeScript + linting rules), same outputs,
order-of-magnitude faster runtime.

## Consequences

- `pnpm verify` is fast enough to feel like nothing on commit.
- We're on prerelease toolchain. `tsgo` is `@typescript/native-preview`
  (versioned by date); `rolldown` and `vitest 4` are also pre-1.0/recent
  majors. Breakage risk is real but contained — we pin major versions
  in [`package.json`](../../package.json) and update deliberately.
- Some ecosystem rules don't have oxlint equivalents yet
  (`format:check` is currently red on ~20 pre-existing files because
  oxfmt's defaults differ from prior Prettier output). The
  CLAUDE.md "Verification" table flags this.
- If the Rust tooling stalls, fall back to ESLint + Prettier + `tsc`
  is straightforward — the codebase doesn't depend on plugin shapes
  unique to either side.
- Aligns with the broader bundler choice (`rolldown`, also Rust-based).
