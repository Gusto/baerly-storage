---
"@gusto/baerly-storage": minor
---

Storage requests now retry at one layer, with at most 3 attempts per request.

- `S3HttpStorage` and `GcsHttpStorage` make at most 3 attempts per request, and each `list` page counts as one request. Previously a call could make 9 attempts, and a throttled `list` page up to 90. Backoff is full jitter, with a 1 s base after a throttle (429 or `SlowDown`) and a 50 ms base after other transient failures, capped at 20 s. A `Retry-After` hint still wins, clamped to 20 s.
- The `retries` option now defaults to `2` (was `8`) and also bounds `list` 429s. A value that is not a non-negative integer throws `InvalidConfig`. `backoffMs`, when set, replaces both jitter bases.
- `r2BindingStorage` now retries transient binding failures under the same policy. Previously it made one call.
- The writer sends each log create once. When the outcome is uncertain, it reads the slot back instead of re-sending. A throttled create still fails with a retriable `NetworkError`, and a create whose fate cannot be resolved still fails with `AmbiguousCommit`. A failing commit now issues at most 3 creates and one readback, down from up to 81 creates.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: 8 retries by default, any value accepted
new S3HttpStorage({ ...cfg, retries: 8, backoffMs: 200 });
// after: default retries is 2 (3 attempts). Pass a non-negative integer or omit it.
new S3HttpStorage({ ...cfg });
new S3HttpStorage({ ...cfg, retries: 2 });
// retries: 1.5, -1, or "3" now throws InvalidConfig
```

Raising `retries` above 2 is allowed but multiplies request cost under throttling; add retry in your own caller instead of in the adapter. `backoffMs`, when set, replaces both jitter bases (the 1 s throttle base and the 50 ms transient base), not a single fixed delay.
