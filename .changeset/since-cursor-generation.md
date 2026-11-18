---
"@gusto/baerly-storage": patch
---

Give `/v1/since` cursors a generation, so a `baerly admin restore --force` truncation can no longer silently gap a long-poll stream. Before, a pre-restore cursor could resume into the restored collection and skip every restored row beneath it with no error.

`current.json` now carries an opaque `generation` nonce, and a collection that has one hands out cursors of the form `<generation>.<lsn>`. A resume whose generation no longer matches is refused with `CursorExpired` (410; see that entry of this release). `generation` is an optional field of `schema_version: 3`, so existing buckets and cursors keep working; a collection that was never truncated resumes normally.

Cursors are opaque, so no client action is required. The React subscription poll re-bootstraps on the refusal instead of retrying the dead cursor every second. A custom `/v1/since` consumer should back off, then restart with an empty cursor: re-bootstrapping without a delay turns a mixed-version fleet mid-deploy into a hot loop.
