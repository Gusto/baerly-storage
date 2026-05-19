# `r2-binding-storage` maps errors by regex on `e.message`

**Severity: MEDIUM. Silent regression hazard. CF's binding error
messages are platform-implementation, not contract — the next
miniflare/workerd version that reword them will cause every
classified error to map to the catch-all `NetworkError` in
production. Add a guard test.**

`packages/adapter-cloudflare/src/r2-binding-storage.ts:174,177`:

```ts
if (/auth|permission|forbidden/i.test(msg)) return mapToAccessDenied(...);
if (/not.*found|no.*such.*bucket/i.test(msg)) return mapToNotFound(...);
// falls through to NetworkError
```

Two regex matches on `e.message`. Both classifications are
load-bearing — `AccessDenied` and `NotFound` map to different
HTTP statuses and very different user-facing messages.

The CF Workers Runtime team has not committed to error-message
stability for R2 binding errors. Any wording change in a future
miniflare or workerd version silently breaks the classification:
the request still fails, but with the wrong (generic)
`NetworkError` instead of the intended `AccessDenied` /
`NotFound`. A user hitting it sees "Network error" instead of
"Forbidden" — no signal anything is wrong with the adapter.

## Two ways to fix

### Long-term: typed binding errors

When CF Workers types ship typed binding errors (a discriminated
union or a `code` field on `R2Error`), switch to `error.code ===
"NotFound"` etc. The current regex stops being needed.

This is gated on the CF platform team's roadmap; there's no
self-service fix.

### Today: a guard test

Add a regression test asserting the regex matches the *current*
miniflare error shape. The test fails when miniflare/workerd
rewords the message — *in CI*, not in production:

```ts
// packages/adapter-cloudflare/src/r2-binding-storage.test.ts
import { describe, test, expect } from "vitest";
import { mapBindingError } from "./r2-binding-storage.ts";

describe("r2 binding error mapping (guard against platform reword)", () => {
  test("AccessDenied regex matches current miniflare auth error", async () => {
    // Trigger a real binding error by attempting an unauthorized op
    // (or use a fixture captured from miniflare today).
    const err = await captureCurrentAuthError();
    expect(err.message).toMatch(/auth|permission|forbidden/i);
    expect(mapBindingError(err).code).toBe("AccessDenied");
  });
  test("NotFound regex matches current miniflare not-found error", async () => {
    const err = await captureCurrentNotFoundError();
    expect(err.message).toMatch(/not.*found|no.*such.*bucket/i);
    expect(mapBindingError(err).code).toBe("NotFound");
  });
});
```

The test runs in the `cloudflare-pool` vitest project (miniflare
+ workerd). When CF reworks a message, the matcher fails *here*,
not silently in prod.

## Why not "rewrite to typed errors today"

The CF binding API today returns plain `Error` instances. There's
no typed discriminant to switch on. Hand-rolling a wrapper
(catching every binding call and translating) would double the
adapter's binding surface for a class of error the regex
*currently* catches correctly.

## What this is not

Not a deletion candidate. Not a structural change. Just **insure
the existing behaviour against future platform rewording**. The
fix is one or two test cases; ~30 LoC including helpers.

## Verify after fix

- `pnpm test:adapter-cloudflare` includes the new test cases.
- The tests pass on the current miniflare/workerd pinning in
  `package.json`.
- A future `@cloudflare/vitest-pool-workers` bump that reworks
  the messages will fail this test before any user sees the
  miscategorization.
