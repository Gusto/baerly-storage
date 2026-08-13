# Dead-cursor retry damping — design

**Base:** `fix/react-query-subscriptions` @ `0132d46c`, 2026-08-13.
**Status:** approved.

## Problem

The React subscription pool uses equal-jitter exponential backoff for
retriable `/v1/since` failures. A successful poll resets the attempt counter.
That is correct for an established subscription, but not for the two-request
dead-cursor recovery sequence:

1. a non-empty cursor receives `SchemaError`;
2. the pool invalidates affected queries, clears the cursor, and backs off;
3. an empty-cursor bootstrap succeeds and issues a replacement cursor;
4. a mixed-version peer rejects that replacement cursor; and
5. the sequence repeats.

Resetting after step 3 keeps every rejection in the initial 125–250 ms jitter
window. The previous fixed delay admitted at most one invalidation cycle per
second, so the new behavior can refetch roughly four times as often during a
rolling-deploy oscillation.

## Design

Track whether a dead-cursor recovery is still unproven. Capture the cursor
used for each poll before awaiting the request.

- A normal successful poll resets the retry attempt counter.
- A successful empty-cursor bootstrap that returns a non-empty replacement
  while recovery is unproven keeps the existing attempt counter: it only
  obtained a candidate replacement.
- A successful empty-cursor bootstrap that remains at an empty cursor has no
  replacement left to prove, so it clears recovery state and resets the
  attempt counter.
- A successful poll made with a non-empty replacement cursor proves recovery,
  clears the recovery state, and resets the attempt counter.
- Another `SchemaError` for the replacement cursor keeps recovery unproven and
  advances the existing exponential backoff.
- Transport failures continue using the same retry counter and 250 ms initial
  bound / 10 second cap.

This preserves the fast first dead-cursor recovery while damping repeated
invalidation storms. It adds no public option, dependency, or wire change.

## Verification

Replace the oscillation test's loose request-count ceiling with exact request
times under deterministic maximum jitter. The test must fail when every
empty-cursor success resets the attempt counter and pass when consecutive
replacement-cursor rejections produce increasing delays. Keep the existing
test proving that an ordinary successful poll resets transport backoff.

Run the focused subscription-pool suite, then `pnpm verify:agent`,
`pnpm bundle-sizes`, and `pnpm test:agent`.

## PR description

Replace the ambiguous claim that the branch “preserves bounded retry” with an
explicit statement that retriable transport failures use equal-jitter
exponential backoff with a 250 ms initial bound and 10 second cap, while
dead-cursor recovery retains its bound and damps repeated replacement-cursor
rejection.
