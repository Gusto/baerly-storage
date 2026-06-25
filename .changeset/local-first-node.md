---
"@gusto/baerly-storage": minor
---

Node apps can now run with zero storage credentials by using the new
`localFsStorage()` factory from `@gusto/baerly-storage/node`. The Node
examples default to local filesystem storage for local development and
promote to S3 or R2 when bucket environment variables are configured.

`localFsStorage()` is a local-dev convenience only — single-process, with
no cross-process CAS and no crash durability — so the Node example servers
fail loud in a detected deployment (`NODE_ENV=production` or a known PaaS)
and require a real bucket: a missing/typo'd bucket aborts startup instead
of running production on non-durable storage. There is deliberately no
opt-in to run local-fs in a deployment; self-hosting without a cloud
bucket, run MinIO on the box or use SQLite + Litestream.
