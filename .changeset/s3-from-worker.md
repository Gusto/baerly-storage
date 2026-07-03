---
"@gusto/baerly-storage": minor
---

Cloudflare Workers can now talk to S3-compatible storage over HTTP instead of a
native R2 binding. This is opt-in; the R2 binding remains the default.

New exports and options:

- New Worker-safe subpath `@gusto/baerly-storage/s3` exports `S3HttpStorage` and
  `sigV4Signer`. Their closure pulls in no `node:` builtins, so it loads in a
  Worker.
- `baerlyWorker` accepts an optional `storage` in its factory options. It
  defaults to the `env.BUCKET` R2 binding.
- `BaerlyEnv.BUCKET` is now optional, so an S3-only Worker need not declare an R2
  binding.

`sigV4Signer` fails fast with `InvalidConfig` when `accessKeyId`,
`secretAccessKey`, or `region` is empty or whitespace-only (for example, a blank
or accidentally-spaced wrangler `var`). This replaces signing with blank
credentials — or building a malformed empty-region SigV4 scope — and drawing an
opaque 403.

This path ships at the same support tier as AWS-via-`S3HttpStorage`:
credential-gated, with production validation owned by the operator. CI guards the
closure under workerd on two levels:

- a bundle probe that it stays `node:`-free (so it loads in a Worker), and
- an in-isolate wire test that `S3HttpStorage` + `sigV4Signer` actually run
  there — signing, XML parse, request/response plumbing — against an in-memory
  S3 stub.

CI does not drive a real S3 endpoint from workerd. Verify yours with `baerly
doctor --bucket` before relying on it. Note that `baerly deploy` and `doctor
--target=cloudflare` still expect an R2 binding in `wrangler.jsonc`.
