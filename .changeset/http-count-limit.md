---
"@gusto/baerly-storage": patch
---

HTTP `count()` now honors `limit`, as the server SDK's `count()` does: `client.collection("tickets").limit(3).count()` returns at most 3 instead of the full count. `GET /v1/count` accepts `&limit=<n>` and validates it as the list route (`GET /v1/c/:collection`) does, so a `limit` that is not a non-negative integer is a `SchemaError` (400).
