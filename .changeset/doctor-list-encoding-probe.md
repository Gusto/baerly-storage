---
"@gusto/baerly-storage": minor
---

`baerly doctor --bucket` now also checks that the bucket's LIST returns keys exactly as written. It puts two throwaway objects whose keys hold `%` (including `%2F`, `%25`, and a bare `%`), spaces, `+`, `&<>"'`, and a non-ASCII letter under a fresh `__baerly_list_probe__/` prefix, lists them, and compares the listed keys byte-for-byte. A mismatch is an error (exit 2) naming the likely cause — keys left URL-encoded, decoded twice (the backend ignores `encoding-type=url`), or decoded wrongly — because app, tenant, and collection names may hold those characters. The probe makes six storage calls, deletes its objects even when a step fails, and reports a sentinel it could not delete as a warning naming the key.
