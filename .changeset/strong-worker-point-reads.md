---
"@gusto/baerly-storage": patch
---

Serve Cloudflare Worker point reads directly from storage so completed PUT, PATCH, and direct SDK writes are visible, including across overlapping reads and query-string variants. Remove the response-body cache and its `cache_status` log field. Repeated reads now pay the storage-backed read cost; request limits, maintenance thresholds, and the supported read envelope stay unchanged.
