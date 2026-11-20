---
"@gusto/baerly-storage": patch
---

Reading a `current.json`, snapshot or GC pending record whose `schema_version` is a deeply nested array (about 5,000 levels) now rejects with `InvalidResponse` like any other unsupported version. Before, building the error message overflowed the stack and the reader threw a plain `RangeError` with no `code`. The message now names an array or object by type, and truncates a long string and reports its length, instead of echoing the stored value.
