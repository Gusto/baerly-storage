---
"@gusto/baerly-storage": patch
---

On the Cloudflare R2 binding, a write that hits R2's same-key rate limit (error
`10058`, one write per second per key) is now retried as a throttle, with the
longer throttle backoff, rather than as a transient failure. A commit whose
every attempt was throttled now fails with a retriable `NetworkError` instead of
`AmbiguousCommit`, because nothing of it landed. When the throttle hid a lost
race with a concurrent writer, the commit moves on to the next log slot and
succeeds.

A Workers "Too many subrequests" error from the R2 binding is no longer retried,
since every later call in the same invocation is refused too. A commit refused
this way fails with a retriable `NetworkError` instead of `AmbiguousCommit`.
