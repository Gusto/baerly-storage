---
title: Conventions for tests
audience: coder
summary: Test file layout, vitest imports, colocation rules, property-based testing patterns.
last-reviewed: 2026-06-13
tags: [conventions, tests, vitest]
related: [docs.md, "../development.md"]
---

# Test conventions

Conventions for tests across `src/` (colocated unit tests) and `tests/`
(everything else).

## Test runner
- vitest. Import from `"vitest"`:
  ```ts
  import { test, expect, describe, beforeAll, afterEach } from "vitest";
  ```
- Don't import from `"bun:test"`, `"jest"`, or `"mocha"`.

## File layout

vitest discovers via `include: ["src/**/*.test.ts", "tests/**/*.test.ts"]`.
Filenames are kebab-case throughout (e.g. `s3-http.test.ts`).

| Where | What goes there |
|---|---|
| `src/<module>.test.ts` (next to source) | Unit tests with a 1:1 source mapping. The test for `packages/protocol/src/json.ts` is `packages/protocol/src/json.test.ts`. |
| `tests/unit/<topic>.test.ts` | Cross-cutting unit tests with no single source counterpart (e.g. `consistency`, `datatypes`). |
| `tests/<topic>.test.ts` | Cross-cutting suites that don't fit unit/integration cleanly (e.g. `regressions`). |
| `tests/integration/<topic>.test.ts` | Tests that need infrastructure or build artifacts (Minio, credentials, `dist/`). |
| `tests/fixtures/<name>.ts` | Shared helpers without `.test.ts` suffix (won't be picked up as tests). |

One topic per file. Don't pile unrelated suites together.

## Property-based tests

Use `fast-check` via `@fast-check/vitest`. Import `fc` and `test` from
`@fast-check/vitest`; pull `expect`/`describe` from `vitest`. Prefer the
object-form `test.prop({ a, b })` so failure messages name the shrunk
values.

- Pure modules: drive arbitraries through `test.prop`. Example:
  ```ts
  import { fc, test } from "@fast-check/vitest";
  import { describe, expect } from "vitest";

  test.prop({ n: fc.integer() })("abs is non-negative", ({ n }) => {
    expect(Math.abs(n)).toBeGreaterThanOrEqual(0);
  });
  ```
- Stateful classes: model the invariants with `fc.commands` and run the
  sequence via `fc.modelRun` (sync) or `fc.asyncModelRun` (async).
- Failing-seed replay: failure output prints a `seed` and `path`. Paste
  them into `fc.assert(prop, { seed, path })` to reproduce, or just
  rerun the test by name — `@fast-check/vitest` re-seeds automatically
  on a single-test rerun.
- Protocol-level ordering tests (interleaved writes, replay, partial
  failures) still live in `tests/integration/randomized.test.ts`.
- Per-property iteration count comes from `FC_NUM_RUNS` (default 100).
  `pnpm test:randomize` cranks it to 10000 for a single deterministic
  pass.

## Asserting on errors
- Check the `code`, not the message:
  ```ts
  await expect(action()).rejects.toMatchObject({ code: "NetworkError" });
  ```
  or
  ```ts
  try { ... } catch (err) {
    expect((err as BaerlyError).code).toBe("InvalidConfig");
  }
  ```
- Don't string-match on `error.message` — the wording isn't stable.
- Rationale: JSDoc on `BaerlyError` in [`packages/protocol/src/errors.ts`](../../../packages/protocol/src/errors.ts).

## Network-dependent tests
- Tests that hit the network live in `tests/integration/` and expect
  Minio at `http://127.0.0.1:9102`. Bring it up with `pnpm dev:storage`
  before running them.
- `tests/integration/conformance.test.ts` needs cloud credentials in
  `credentials/` (gitignored). It's excluded from the default test
  glob; opt in with `pnpm test:conformance`.

## Performance
- `pnpm test` should stay under ~30s on a developer laptop. Prefer
  `await Promise.resolve()` ticks or short intervals (≤50ms) over
  `setTimeout` in tests.
- Don't add `.only` to commits — vitest will silently skip everything
  else.
- Real-subprocess / real-filesystem **integration** tests (e.g. the
  scaffold + git tests in
  `packages/create-baerly-storage/src/index.test.ts`) should raise their
  timeout to **30s** via
  `vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })` at the top
  of the file. The 5s default (`vitest.config.ts`) is calibrated for
  in-memory / unit tests and gets starved under the parallel fork-pool
  suite — a timeout there is load, not a real hang.
