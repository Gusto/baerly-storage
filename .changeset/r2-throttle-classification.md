---
"@gusto/baerly-storage": patch
---

On the Cloudflare R2 binding, R2's same-key rate limit (error `10058`, one write
per second per key) is now retried as a throttle, with the longer throttle
backoff, rather than as a transient failure. A commit whose every attempt was
throttled reads its log slot back: when a concurrent writer took the slot, the
commit moves on to the next slot and succeeds; when the slot is read back as
empty, it fails with a retriable `NetworkError` instead of `AmbiguousCommit`.

A Workers "Too many subrequests" error from the R2 binding is no longer retried,
since every later call in the same invocation is refused too. A commit refused
this way whose slot is read back as empty fails with a retriable `NetworkError`.
