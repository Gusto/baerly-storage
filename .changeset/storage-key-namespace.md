---
"@gusto/baerly-storage": patch
---

Reject `.` / `..` / empty object keys at the Storage boundary

Every `Storage` adapter (`MemoryStorage`, `S3HttpStorage`, `r2BindingStorage`,
`LocalFsStorage`) now validates each key on `get` / `put` / `delete` and throws
`BaerlyError("InvalidConfig")` for an empty key or one whose `/`-delimited path
has a `.` or `..` segment. Such a key is unaddressable over the S3/R2 HTTP API —
RFC 3986 dot-segment removal rewrites `<bucket>/.` to the bucket root before the
request is signed, so a naive PUT surfaces as a confusing bucket-root `403`
rather than a clear error. The guard runs client-side, before any network call,
so the rejection is identical across backends and portable to a language port.

**What changed**

- `get` / `put` / `delete` on all adapters reject `""`, `.`, `..`, and any key
  containing a `.`/`..` path segment with `InvalidConfig`. `list(prefix)` is
  unaffected — a prefix rides the `?prefix=` query component, where `.`/`..`
  are harmless.
- The full-key 1024-byte ceiling continues to be enforced on the write path
  (`assertKeyWithinLimit`), where multi-segment keys are assembled.

**Migration**

- No action for normal use: the kernel never emits such keys, and
  caller-controlled segments (`_id`, `collection`, `app`, `tenant`) are already
  screened one layer up. If you call a `Storage` adapter directly with a bare
  `.` / `..` / empty key, catch `BaerlyError` with `code === "InvalidConfig"`.
