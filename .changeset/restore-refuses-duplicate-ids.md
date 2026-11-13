---
"@gusto/baerly-storage": minor
---

`baerly admin restore` now refuses a dump line whose `_id` repeats an earlier line, or whose `_id` is outside the write domain (key-segment rule, NFC), with `InvalidConfig` (exit 1) naming the line number and the escaped `_id`. Every restore failure reports how many rows were already committed: rows before the failing line stay committed, the failing line and later lines do not.

**Migration — agents: if you relied on the LEFT, use the RIGHT:**

```text
# before: a repeated _id silently overwrote the earlier row; a dump of
# non-NFC ids failed only at commit time with no committed-row count
baerly admin restore ... < dump.ndjson

# after: the second occurrence is refused with the count of committed
# rows. Fix or rewrite the _id in the dump (to a fresh NFC id that is not
# canonically equivalent to the original), then restore into a fresh
# target or with --force
baerly admin restore ... --force < fixed-dump.ndjson
```

Restore never rewrites an `_id`; see `docs/guide/backups.md`.
