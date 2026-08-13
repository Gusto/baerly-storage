---
"@gusto/baerly-storage": minor
---

Add `useQuery(callback, deps, { live: false })` for typed React reads
that run initially and when dependencies change without opening a
`/v1/since` subscription. Every `UseQueryResult` state now includes a
stable `refetch()` function; calling it refreshes the current query and
preserves the previous successful data while refreshing or on error.

Live queries now stop and surface non-retriable `/v1/since` failures,
including `Unauthorized`, instead of retrying forever behind stale data.
Retriable transport failures use bounded exponential backoff with jitter,
and dead `SchemaError` cursors continue to re-bootstrap automatically.
