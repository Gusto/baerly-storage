---
"@gusto/baerly-storage": minor
---

Node apps can now run with zero storage credentials by using the new
`localFsStorage()` factory from `@gusto/baerly-storage/node`. The Node
examples default to local filesystem storage for single-node local runs
and promote to S3 or R2 when bucket environment variables are configured.
