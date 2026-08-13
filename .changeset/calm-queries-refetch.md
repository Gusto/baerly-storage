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
`refetch()` on any query sharing a stopped subscription clears the error
on all of them, not just the caller.

An HTTP error response carrying no `baerly` error envelope — what a load
balancer, CDN, or service mesh returns when it answers for the server —
is now classified from its status: 5xx becomes a retriable
`NetworkError` rather than a terminal `Internal`. A transient gateway
502 during a rolling deploy therefore backs off and recovers instead of
stopping every live query until remount.
