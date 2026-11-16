## When NOT to use this package

On Cloudflare Workers, do NOT use `@baerly/adapter-node`'s S3-credentials factory — use `r2BindingStorage` from `@gusto/baerly-storage/cloudflare` (the native R2 binding). This package is for Node hosts that talk to an S3-compatible endpoint over HTTP.

## Credentials

All four storage factories (`s3Storage`, `r2Storage`, `minioStorage`, `gcsStorage`) take a single `credentials` field: static keys or an async provider. The shipped recipe owns the examples (static, EKS Pod Identity / IRSA, your own provider, `@aws-sdk/credential-providers`), the GCS HMAC note, and the expiration and refresh rules: [`packages/server/RECIPES.md`](../server/RECIPES.md#recipe--storage-credentials-on-node), installed as `node_modules/@gusto/baerly-storage/dist/RECIPES.md`.
