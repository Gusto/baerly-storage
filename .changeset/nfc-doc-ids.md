---
"@gusto/baerly-storage": minor
---

**Breaking:** a document `_id` must now be in Unicode Normalization Form C
(`id === id.normalize("NFC")`). `insert` with a caller-supplied `_id`,
`replace`, their HTTP routes (`POST`, `PUT`), and `baerly admin restore`
refuse any other `_id` with `InvalidConfig` (HTTP 400) before writing
that row. Restore commits row by row, so rows before a rejected line are
already written. SDK-minted UUIDv7 ids are ASCII and always
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
markers under the non-NFC id. To keep such a row writable, read it by `_id`
and insert a copy under a fresh NFC id that is not canonically equivalent
to the original (for example, omit `_id` for a UUID), then delete the
original. On R2, copying to the normalized original id before deleting it
would remove the copy's index markers. If a collection already holds two
rows whose ids are canonically equivalent, read both rows by `_id`, copy
each under a fresh NFC id that is not canonically equivalent to either
original, then delete the originals. An NDJSON export that contains a
non-NFC `_id` must have that id normalized before `baerly admin restore`
accepts it; ensure the resulting ids are unique.
