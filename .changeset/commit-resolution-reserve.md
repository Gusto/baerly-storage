---
"@gusto/baerly-storage": patch
---

A write now keeps enough of its request's storage budget to resolve its own
commit. Before it writes any index marker, and again before each retry at a
new log slot after losing a race, it checks that the budget still covers
every marker, the commit and the calls that confirm it, and holds that
much so that other work in the same request, such as write-tick maintenance
running in `ctx.waitUntil`, cannot spend it; if the budget is short, it
fails with `CapacityExceeded` (not retriable unchanged) and nothing is
written.
Previously a write could commit with no budget left to confirm it and fail
with `AmbiguousCommit`, and a commit the budget refused before sending was
also reported as `AmbiguousCommit` although nothing had been sent; it is
now `CapacityExceeded`.

A multi-row `.where(...).update()` / `.delete()` that runs out of budget
part-way keeps the rows it committed and commits nothing after the refused
row; re-running it on a fresh request is safe.
