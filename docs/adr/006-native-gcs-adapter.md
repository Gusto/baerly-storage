---
title: Native GCS adapter over the XML API
audience: adr
doc_type: adr
summary: ADR 006 — GCS is supported through a native XML-API adapter driving x-goog-if-generation-match, not S3-interop; the object generation is the opaque etag and 412 is the only conflict status.
last-reviewed: 2026-07-14
tags: [decision, adr, storage, gcs]
related: [README.md, "../spec/storage-compatibility.md", "../about/cost-model.md"]
---

# 006 — Native GCS adapter over the XML API

## Status

Accepted (2026-07-14). Live contract:
[spec/storage-compatibility.md](../spec/storage-compatibility.md#native-gcs-xml-api).

## Context

Google Cloud Storage exposes an S3-interoperable endpoint, and
baerly-storage already had a `gcsStorage` factory pointed at it. That
path cannot back the database: **GCS scopes the S3 `If-Match` /
`If-None-Match` headers to reads.** On a write they are silently ignored,
so the commit — a create-if-absent on `log/<seq>` — never fails on a
collision. Under concurrent creates the S3-interop path admits multiple
winners, i.e. split-brain commit at one `seq`. No configuration or live
probe can promote it out of "Unsupported"; the defect is in the endpoint
contract, not the client.

GCS does, however, offer a linearizing primitive on its **native XML
API**: `x-goog-if-generation-match`. A create-if-absent is
`x-goog-if-generation-match: 0`; a compare-and-swap is
`x-goog-if-generation-match: <generation>`. Precondition failure returns
**412**, and every object write returns its new `generation` in
`x-goog-generation`.

## Decision

Support GCS through a **native** `GcsHttpStorage` adapter driving the XML
API, and repoint the `gcsStorage` factory at it. The signature
(`gcsStorage({ bucket, credentials })`) is unchanged.

Four facts are load-bearing:

1. **Generation is the opaque etag.** The kernel treats the `Storage`
   etag as fully opaque — every consumer round-trips it verbatim into
   `ifMatch`, and nothing parses, orders, or compares it. So the adapter
   carries the int64 `generation` there. `put` / `get` throw
   `InvalidResponse` if `x-goog-generation` is absent; the response
   `ETag` (quoted-MD5) is never a fallback, since a wrong token would
   poison the next `ifMatch`.
2. **412-only conflict mapping.** Both create-collision and stale-CAS
   return 412 → `BaerlyError{code:"Conflict"}`. The S3 adapter's
   `409`-contended branch is deliberately absent — GCS has no contended
   status here.
3. **Dynamic `SignedHeaders`.** The transport sets
   `x-goog-if-generation-match` before signing, and the GOOG4-HMAC-SHA256
   signer signs `host` plus every `x-goog-*` header present. A fixed
   signed-header list would leave the precondition header unsigned →
   `403 SignatureDoesNotMatch` on every conditional write. AWS SigV4
   cannot be reused: GCS rejects a request carrying both `x-amz-*` and
   `x-goog-*` headers.
4. **HMAC-key credentials, Node-only (v1).** Authentication uses a GCS
   HMAC interop key (dependency-free WebCrypto signing). Scope is a Node
   host, bring-your-own-bucket — no GCP deploy target and no Worker
   `/gcs` subpath.

**Tier-promotion criteria.** GCS moves to Tier 1 on the same evidence
bar as AWS-via-`S3HttpStorage`: credential-gated conformance (including
"admits exactly one winner under concurrent create-if-absent") plus the
`node-gcs` randomized causal cascade (the multi-writer linearizability
proof), plus a green `baerly doctor --bucket` on a real bucket. It is not
PR-CI gated because the oracle is a live credentialed bucket.

## Consequences

- GCS is a first-class Node backend; the S3-interop path stays
  Unsupported and callers are told to use the native adapter.
- `baerly doctor` recognizes the native path (its three CAS sub-checks
  pass on the 412→Conflict mapping), actively probes Object Versioning
  (warns when enabled), and carries a static soft-delete advisory — the
  soft-delete setting isn't readable over the HMAC/XML API. Both Object
  Versioning and soft-delete turn baerly's GC `DELETE`s into billed
  retained objects.
- The `~1 write/s` per-object rate limit is the documented Tier-1
  caveat. Distinct `log/<seq>` keys are distinct objects, so the cap does
  not bite the commit path; a hotspotting workload draws retryable 429s.
- GOOG4-RSA (service-account) and OAuth/ADC remain the v2 line, gated on
  a dependency-free RSA story.

## Rejected alternatives

- **S3-interop `gcsStorage`.** Read-scoped conditional headers →
  split-brain commit. Structurally impossible, not a tuning problem.
- **Reusing the SigV4 signer.** GCS rejects mixed `x-amz-*` / `x-goog-*`
  requests; a separate GOOG4 signer is required.
- **Falling back to the response `ETag` for the version token.** A
  quoted-MD5 is not the generation; adopting it would poison the next
  CAS. Absent `x-goog-generation` is a hard `InvalidResponse`.
