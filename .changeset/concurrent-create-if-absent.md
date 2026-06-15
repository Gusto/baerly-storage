---
"@gusto/baerly-storage": patch
---

Make `LocalFsStorage` create-if-absent atomic, and add a concurrent
create-if-absent check to `baerly doctor --bucket`.

The writer's log-append commit already relies on `If-None-Match:"*"`
create-if-absent admitting **exactly one winner** under concurrency: log
entries are written create-if-absent and a `412` means a peer won that
sequence number. `LocalFsStorage` previously implemented create-if-absent as
a read-existence + `writeFile`/`rename`, a TOCTOU race that could admit two
winners under concurrent writes — so two writers could each believe they
appended the same log entry. It now uses an atomic `link(2)` exclusive create
(same-directory temp; `EEXIST` ⇒ `Conflict`), so concurrent create-if-absent
has exactly one winner. Internal temp files are hidden from
`LocalFsStorage.list()`.

`baerly doctor --bucket` gains an `ifNoneMatch-concurrent` check: it races N
concurrent create-if-absent writes and confirms at most one wins (more than
one ⇒ the backend is not linearizable and the commit path would split-brain).
Transient non-`Conflict` losers are reported as inconclusive, not as a
linearizability failure. The same property is asserted for every shipped
storage adapter by the conformance suite.
