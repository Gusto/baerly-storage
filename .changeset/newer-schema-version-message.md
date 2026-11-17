---
"@gusto/baerly-storage": patch
---

An unreadable `schema_version` in `current.json`, a snapshot, or `gc/pending.json` now reports the found and supported versions; a version written by a newer release says to run that release or newer, and the message no longer suggests recreating a bucket.
