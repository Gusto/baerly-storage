---
"@gusto/baerly-storage": patch
---

`lsnParts` now throws `BaerlyError{InvalidResponse}` for any seq token that is not the canonical fixed-width base-32 string or that decodes outside the safe-integer range; it previously returned `NaN` or a negative seq (for example `0_s_vvvvvvvvvvv`). `/v1/since` reports such a cursor as `SchemaError` ("invalid shape") instead of a misleading "folded into a snapshot" error. A stored log entry whose body is valid JSON but not an object (`null`, a number, a string, an array) is now rejected with `InvalidResponse` when read, instead of crashing the fold with a raw `TypeError`.
