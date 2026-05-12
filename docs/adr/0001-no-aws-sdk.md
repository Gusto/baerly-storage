# 0001 — No AWS SDK

## Context

Baerly talks directly to S3-compatible HTTP endpoints (S3, R2, Backblaze,
Minio). The obvious dependency would be `@aws-sdk/client-s3` (the modular
v3 SDK). It's well-maintained, fully typed, and battle-tested.

But Baerly is intentionally a *clientside* library — it ships into a user's
web app bundle. `@aws-sdk/client-s3` plus its required peers
(`@aws-sdk/credential-providers`, `@aws-sdk/s3-request-presigner`,
`@smithy/*`) lands at hundreds of KB even after tree-shaking, and brings
in HTTP middleware, signing pipelines, and error hierarchies that we
don't use. Most of it exists to support the long tail of AWS services
this library does not call.

## Decision

Roll a minimal S3 client over `aws4fetch` (one of the smallest AWS
SigV4 implementations). Define our own subset of the S3 wire types
inline rather than pulling them from the SDK. Parse XML responses
with `@xmldom/xmldom` (already needed for ListObjectsV2; re-using
for everything S3 returns).

## Consequences

- The runtime footprint stays tiny. The full third-party set is
  `aws4fetch`, `idb-keyval`, `@xmldom/xmldom`. CLAUDE.md's anti-pattern
  list flags adding any new dependency.
- We carry a small but real maintenance cost: when S3-compatible
  vendors return non-standard XML, we write the workaround
  (see [`docs/s3-xml-escaping-cases.md`](../s3-xml-escaping-cases.md)).
- Type safety for S3 operations is whatever the inlined wire types
  cover. Missing fields are added on demand.
- Implementation:
  [`packages/protocol/src/storage/s3-http.ts`](../../packages/protocol/src/storage/s3-http.ts),
  [`packages/protocol/src/xml.ts`](../../packages/protocol/src/xml.ts).

If we ever need a feature that's hard to implement against raw HTTP
(e.g. multipart-upload with retries and signed presigned URLs across
regions), reconsider — but only for the specific feature, not as a
wholesale replacement.

## Amendment — 2026-05-10

The original implementation lived in a single thin HTTP-client class
under `src/`, with inputs typed against an AWS-SDK-shaped command
surface defined in a sibling types file. Both have been folded into
[`packages/protocol/src/storage/s3-http.ts`](../../packages/protocol/src/storage/s3-http.ts)
as the `S3HttpStorage` impl of the `Storage` interface, completing
the carve into the vendorless protocol package. Auth is now plugged
in via a `sign(req)` callback so SigV4 (`aws4fetch`) stays out of
the protocol package's "pure modules, no I/O" boundary; consumers
choose the signer.
