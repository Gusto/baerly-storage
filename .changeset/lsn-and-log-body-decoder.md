---
"@gusto/baerly-storage": patch
---

`GET /v1/since` reports a cursor whose seq token is not canonical, or decodes outside the safe-integer range, as `SchemaError` ("invalid shape") instead of a misleading "folded into a snapshot" error. A stored log entry whose body is valid JSON but not an object (`null`, a number, a string, an array) is now rejected with `InvalidResponse` when read, instead of crashing the fold with a raw `TypeError`.
