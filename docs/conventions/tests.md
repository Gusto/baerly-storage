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
Filenames are kebab-case throughout (e.g. `operation-queue.test.ts`).

| Where | What goes there |
|---|---|
| `src/<module>.test.ts` (next to source) | Unit tests with a 1:1 source mapping. The test for `packages/protocol/src/json.ts` is `packages/protocol/src/json.test.ts`. |
| `tests/unit/<topic>.test.ts` | Cross-cutting unit tests with no single source counterpart (e.g. `consistency`, `datatypes`). |
| `tests/<topic>.test.ts` | Cross-cutting suites that don't fit unit/integration cleanly (e.g. `regressions`). |
| `tests/integration/<topic>.test.ts` | Tests that need infrastructure or build artifacts (Minio, credentials, `dist/`). |
| `tests/fixtures/<name>.ts` | Shared helpers without `.test.ts` suffix (won't be picked up as tests). |

One topic per file. Don't pile unrelated suites together.

## IndexedDB
- `import "fake-indexeddb/auto";` at the top of any test that exercises
  IndexedDB-backed behavior (operationQueue, manifest restore, mps3 with
  `offlineStorage`).

## Property-based tests
- See `tests/integration/randomized.test.ts` and
  `tests/unit/consistency.test.ts` for the patterns. Write one when
  behavior depends on operation *ordering* (interleaved writes, replay,
  partial failures) — not for pure functions.

## Asserting on errors
- Check the `code`, not the message:
  ```ts
  await expect(action()).rejects.toMatchObject({ code: "NetworkError" });
  ```
  or
  ```ts
  try { ... } catch (err) {
    expect((err as MPS3Error).code).toBe("InvalidConfig");
  }
  ```
- Don't string-match on `error.message` — the wording isn't stable.
- Rationale: [ADR 0003 — Error code discriminant over `instanceof`](../adr/0003-error-code-discriminant.md).

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
