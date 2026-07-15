---
'@gusto/baerly-storage': minor
---

Native Google Cloud Storage adapter: `gcsStorage` now drives GCS's own
generation-precondition conditional writes over the native XML API
(`x-goog-if-generation-match`), promoting GCS to a Tier-1 backend.

**Migration.** The `gcsStorage({ bucket, credentials })` signature is
unchanged, so existing callers keep compiling. What changes is the wire
behavior: the factory previously produced an S3-interop client whose
conditional headers GCS silently ignored on writes (it could not
linearize the commit log and was unsupported); it now speaks the native
GCS XML API and gains real create-if-absent + CAS, returning `412 →
Conflict` on a lost write. Credentials remain GCS HMAC interop keys
(`accessKeyId` / `secretAccessKey`). Node host only — no Worker `/gcs`
subpath and no GCP deploy target in v1.
