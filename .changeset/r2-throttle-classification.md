---
"@gusto/baerly-storage": patch
---

On the Cloudflare R2 binding, R2's same-key rate limit (error `10058`, one write
per second per key) is now retried as a throttle, with the longer throttle
backoff, rather than as a transient failure. A throttled commit reads its log
slot back: when a concurrent writer took the slot, the commit moves on to the
next slot; an own entry is adopted. R2 does not document that error `10058`
proves an unapplied write, so an empty or unreadable slot remains
`AmbiguousCommit`, including when a later retry was definitively rejected.

A Workers "Too many subrequests" error from the R2 binding is no longer retried,
since every later call in the same invocation is refused too. When no earlier
attempt has an uncertain outcome, a commit refused this way fails with a
retriable `NetworkError` when its slot is empty or its readback fails, since no
attempt applied or can still apply.
