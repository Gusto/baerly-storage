---
"@gusto/baerly-storage": minor
---

`baerly admin fsck` now flags an app, tenant, or collection name with an unpaired UTF-16 surrogate (check `names`), and snapshot `_id`s with one (check `ids`), as `warning` findings that exit 4, next to the existing non-NFC name check. 0.7 refuses such names and `_id`s as write targets, so run `fsck` before upgrading to find legacy data that needs migrating. `fsck` does not decode the log, so for `_id`s committed since the last fold use `baerly admin dump --json`, whose `legacy.ill_formed_ids` covers every live row.
