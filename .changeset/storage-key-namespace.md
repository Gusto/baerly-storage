---
"@gusto/baerly-storage": patch
---

Reject `.` / `..` / empty object keys at the Storage boundary

Every `Storage` adapter (`MemoryStorage`, `S3HttpStorage`, `r2BindingStorage`,
`LocalFsStorage`) now validates the key on `get` / `put` / `delete` and throws
`BaerlyError("InvalidConfig")` when the key is empty or has a `.` or `..`
segment in its `/`-delimited path. Such keys can't be addressed over the S3/R2
HTTP API: RFC 3986 dot-segment removal rewrites `<bucket>/.` to the bucket root
before the request is signed, so a naive PUT fails as a confusing bucket-root
`403` instead of a clear error. The check runs client-side, before any network
call, so every backend rejects identically and the behavior ports cleanly to
other languages.

**What changed**

- `get` / `put` / `delete` on all adapters reject `""`, `.`, `..`, and any key
  with a `.` or `..` path segment, with `InvalidConfig`. `list(prefix)` is
  unaffected — a prefix rides the `?prefix=` query component, where `.` / `..`
  are harmless.
- The 1024-byte full-key ceiling is still enforced on the write path
  (`assertKeyWithinLimit`), where multi-segment keys are assembled.

**Migration**

- No action for normal use. The kernel never emits these keys, and
  caller-controlled segments (`_id`, `collection`, `app`, `tenant`) are already
  screened one layer up. If you call a `Storage` adapter directly with a bare
  `.` / `..` / empty key, catch `BaerlyError` and check `code === "InvalidConfig"`.
