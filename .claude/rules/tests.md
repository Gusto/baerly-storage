---
description: Conventions for tests under src/__tests__/
appliesTo: src/__tests__/**
---

# Test rules

## Test runner
- vitest. Import from `"vitest"`:
  ```ts
  import { test, expect, describe, beforeAll, afterEach } from "vitest";
  ```
- Don't import from `"bun:test"`, `"jest"`, or `"mocha"`.

## File layout
- Tests go in `src/__tests__/<topic>.test.ts`. The `.test.ts` suffix is
  what `vitest.config.ts` discovers (`include: ["src/**/*.test.ts"]`).
- Helper modules without test calls (e.g. `consistency.ts`) drop the
  `.test.ts` suffix.
- One topic per file. Don't pile unrelated suites into one file.

## IndexedDB
- `import "fake-indexeddb/auto";` at the top of any test that exercises
  IndexedDB-backed behavior (operationQueue, manifest restore, mps3 with
  `offlineStorage`).

## Property-based tests
- See `src/__tests__/randomized.test.ts` and `consistency.test.ts` for
  the patterns. Write one when behavior depends on operation *ordering*
  (interleaved writes, replay, partial failures) — not for pure
  functions.

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

## Network-dependent tests
- Tests that hit the network expect Minio at `http://127.0.0.1:9102`.
  Bring it up with `pnpm dev:storage` before running them.
- `conformance.test.ts` needs cloud credentials in `credentials/`
  (gitignored). It'll fail to load without those files — that's expected.

## Performance
- `pnpm test` should stay under ~30s on a developer laptop. Prefer
  `await Promise.resolve()` ticks or short intervals (≤50ms) over
  `setTimeout` in tests.
- Don't add `.only` to commits — vitest will silently skip everything
  else.
