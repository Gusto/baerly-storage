---
"@gusto/baerly-storage": patch
---

Rotate `runGc`'s stale-log LIST so budget-bounded passes reach sub-floor
`log/<seq>.json` keys that were previously unreachable.

Log object keys are unpadded decimal, so lexicographic order is
`0, 1, 10, 100…109, 11, …` — a numeric prefix is not a lexicographic
prefix. The permanently-undeletable live keys at or above
`log_seq_start` therefore interleave with, and routinely sort before,
the stale keys below it. Because the mark phase listed from the
lexicographic beginning on every pass with no persisted position, a
bounded pass could fill its whole budget with live keys and never reach
the stale ones behind them. With `log_seq_start = 100` and keys
`0..999`, the lex-first 20 contain four stale keys; once those are
swept the window is `100–119`, all live, and seqs `2–9` plus `12–99`
are never reclaimed.

Raising the budget does not help, because the failure is the window's
position rather than its size: at 100k keys with `log_seq_start =
50000`, 11.1% of the stale set is unreachable at both `maxMarks = 20`
and `maxMarks = 200`. The fraction depends on where the floor sits, not
on the budget — at `log_seq_start = 10000` it is 99.9%.

`gc/pending.json` gains an optional `log_scan_cursor`, the sibling of
the existing `content_scan_cursor`: each bounded pass resumes
`startAfter` the prior pass's last EXAMINED key and wraps at
end-of-keyspace, so the whole `log/` prefix is covered over a rotation
within the per-pass budget. Unbounded passes always wrap, so from a
cursorless ledger they still cover the whole prefix in one go. Bounded
and cursored are independent axes though: an unbounded pass that
inherits a cursor from a bounded one resumes there and covers only
cursor→end, then wraps so the next pass starts from the beginning. That
is liveness-only and self-healing, and it matches how the existing
`content_scan_cursor` has always behaved.

Additive and optional, so `GC_PENDING_SCHEMA_VERSION` stays `1` and
existing buckets keep working untouched: a ledger with no cursor reads
as "start from the beginning". No public API change.

The rotation depends on two `list` guarantees that are normative in
`docs/spec/storage-compatibility.md` clauses 4 and 6 — `maxKeys` is a
hard total across a port's internal pagination, and `startAfter` is a
strict-exclusive position that resolves against a key the same pass has
already deleted. Both are pinned by the cross-adapter conformance suite
and, where it cannot reach the page boundary, by per-adapter tests.
