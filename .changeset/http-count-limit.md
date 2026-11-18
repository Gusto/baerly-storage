---
"@gusto/baerly-storage": patch
---

HTTP `count()` now honours `limit`, matching the server SDK: the client sends `limit` on `GET /v1/count`, which parses and validates it as the list route does.
