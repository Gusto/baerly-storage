---
"@gusto/baerly-storage": minor
---

Cloudflare Workers can now use S3-compatible storage over HTTP instead of
a native R2 binding, as an opt-in path. New Worker-safe
`@gusto/baerly-storage/s3` subpath exports `S3HttpStorage` + `sigV4Signer`
(closure has no `node:` builtins), and `baerlyWorker` accepts an optional
`storage` in its factory options (defaulting to the `env.BUCKET` R2
binding). `BaerlyEnv.BUCKET` is now optional so an S3-only Worker need not
declare an R2 binding. `sigV4Signer` fails fast with `InvalidConfig` when
`accessKeyId`, `secretAccessKey`, or `region` is empty or whitespace-only
(e.g. a blank or accidentally-spaced wrangler `var`) rather than signing
with blank credentials — or a malformed empty-region SigV4 scope — and
drawing an opaque 403.

This path ships at the same support tier as AWS-via-`S3HttpStorage`:
credential-gated, operator-owned production validation. CI guards the
closure under workerd on two levels — a bundle probe that it stays
`node:`-free (loads in a Worker) and an in-isolate wire test that
`S3HttpStorage` + `sigV4Signer` actually run there (signing, XML parse,
request/response plumbing) against an in-memory S3 stub. CI does not drive
a real S3 endpoint from workerd; verify yours with `baerly doctor
--bucket` before relying on it. Note `baerly deploy` / `doctor
--target=cloudflare` still expect an R2 binding in `wrangler.jsonc`.
