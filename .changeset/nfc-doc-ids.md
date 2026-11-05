---
"@gusto/baerly-storage": minor
---

**Breaking:** a document `_id` must now be in Unicode Normalization Form C
(`id === id.normalize("NFC")`). `insert` with a caller-supplied `_id`,
`replace`, their HTTP routes (`POST`, `PUT`), and `baerly admin restore`
refuse any other `_id` with `InvalidConfig` (HTTP 400) before writing
anything. SDK-minted UUIDv7 ids are ASCII and always
pass. Ids that differ only by case (`A` / `a`) or by compatibility form
(`ﬁ` / `fi`) are still distinct.

R2 stores canonically-equivalent keys as one object (NFC `é` and NFD
`e` + U+0301 list back as one key), and index marker keys embed the raw
`_id`. Two documents whose ids differed only by normalization therefore
shared one index marker: an indexed `where` returned the wrong row, and a
stale-marker delete for one de-indexed the other.

Rows already stored under a non-NFC `_id` keep working for reads: `get`,
`where`, and indexed `where` return them, and `delete` removes them.
`update` and `replace` refuse them, because they would write new index
markers under the non-NFC id. To keep such a row writable, insert a copy
under `id.normalize("NFC")`, then delete the original. On R2, if a
collection already holds two rows whose ids are canonically equivalent,
their shared marker cannot tell them apart; read both rows by `_id` and
re-insert each under a distinct NFC id. An NDJSON export that contains a
non-NFC `_id` must have that id normalized before `baerly admin restore`
accepts it.
