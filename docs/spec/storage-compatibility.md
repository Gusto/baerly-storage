---
title: Storage compatibility
audience: spec
summary: Which S3-compatible stores baerly supports, and the conditional-write features it depends on.
last-reviewed: 2026-06-14
tags: [protocol, s3]
related: [s3-xml-escaping-cases.md]
---

# Storage compatibility

Which S3-compatible stores baerly supports (see [Support tiers](#support-tiers)
below), and the minimal S3 API surface the protocol depends on.

## S3 API surface used

### `PUT and GET /<bucket>/<key>

The basic S3 API is very simple and intuitive. You use a HTTP `PUT <endpoint>/<bucket>/<key>` to set a file, and `GET <endpoint>/<bucket>/<key>` to retrieve it later. It is the obvious API if you wanted namespaced storage over a RESTFul interface.

### Response headers: `etag`, `date`, `x-amz-version-id`, `LastModified`

There are additional features using standard HTTP features like `etag` which help with network efficiency. S3 returns the `Date` which is useful for as an authoritative clock source. There are also additional features like versioned objects which help with lifecycle management of resources. And `LastModified` which records the time the write was performed. Every vendor I have tested supports etags on `GET` requests but not object versioning (e.g. Cloudflare R2 doesn't).

### `GET /<bucket>?list-object-v2&prefix=<PREFIX>

To list the objects you `GET <endpoint>/<bucket>` which returns XML and is ordered and paginated. The result set includes the keys and the etags of the resource. By providing a prefix you target a subset of the buckets contents.

### S3 Strong Consistency Guarantees

S3 states strong consistency between its GET, PUT and list operations.

_After a successful write of a new object, or an overwrite or delete of an existing object, any subsequent read request immediately receives the latest version of the object. S3 also provides strong consistency for list operations, so after a write, you can immediately perform a listing of the objects in a bucket with any changes reflected._ -- [S3 docs](https://aws.amazon.com/s3/consistency/)

This is recent. Until **December 2020**, S3 was only eventually consistent for overwrites and list-after-write. Building a database on S3 meant putting a linearizable metadata service (ZooKeeper, etcd, DynamoDB, FoundationDB) in front of the eventually-consistent blob store to hold the authoritative pointer to "what exists" — which is what Iceberg, Delta Lake, and Snowflake all do. AWS then shipped strong read-after-write for every operation as a changelog entry; Werner Vogels' engineering retrospective on `allthingsdistributed.com` is the readable long-form on what changed. After that, the recipe this protocol uses — immutable log entries plus a single CAS'd pointer object, no external catalog — became viable. Iceberg, Delta Lake, Turbopuffer, Litestream, and SlateDB all converged on variants of this shape in the years since.

### S3 is an Immutable Key-Value store with a single index

S3 is an immutable key value store for (potentially very large) binary blobs. The keys are limited in size (1kb), but you can to range queries by prefix query in one direction only.

You cannot update objects in-place — every object is immutable once written. Modern S3 _does_, however, support conditional writes (`If-None-Match: "*"` to create-if-absent, and `If-Match: <etag>` to compare-and-swap), and the protocol depends on them: a commit is a single `If-None-Match: "*"` create on the numbered `log/<seq>` object, and the compactor advances `current.json` with `If-Match` CAS (see [the protocol invariants in sync-protocol.md](sync-protocol.md#protocol-invariants)). So it's tricky getting multiplayer out of this system, but possible thanks to those conditional writes plus the strong consistency guarantees.

## Support tiers

baerly's commit path creates-if-absent the numbered `log/<seq>` object
with `If-None-Match: "*"` (that create IS the commit — there is no
`current.json` CAS on the commit path); the compactor advances
`current.json` with `If-Match`. A store is _supported_ only if it
honours those conditional writes. Run `baerly doctor --bucket=<uri>` to
live-probe a bucket's conditional-write support before relying on it;
exit 2 means the verbs aren't honoured — do not deploy. `baerly deploy`
runs this probe as a preflight and aborts before deploying a bucket
that fails it.

> **Load-bearing prerequisite — concurrent create-if-absent is
> exactly-one-winner.** Sequential rejection ("`If-None-Match: "*"`
> fails when the key already exists") is necessary but **not
> sufficient**. Because the winning `log/<seq>` create _is_ the commit,
> the backend must guarantee that under N _concurrent_ create-if-absent
> requests for a fresh key, **exactly one** succeeds and the rest get
> `412`. A store that admits two winners produces **split-brain
> commit** — two distinct committed entries at one `seq`. The `baerly
doctor --bucket` probe races K concurrent creates of a fresh key and
> asserts exactly one wins (an `ifNoneMatch-concurrent` sub-check); the
> conformance suite asserts the same property for every shipped adapter
> on every PR.

> **Deployment-topology rule — no negative caching in front of the
> log/CAS path.** The log and CAS requests must reach the object-store
> API **directly**, never through a negative-caching CDN or proxy. A
> cached `404` on a `log/<seq>` that was just created would corrupt the
> reader's forward-probe ("first 404 = tail"), hiding a committed
> entry. Object-store APIs are themselves strongly consistent
> (post-2020); this constrains what you put _in front of_ them, not the
> store.

| Tier              | Stores                        | What it means                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier 1**        | AWS S3, Cloudflare R2         | CI-conformance-gated every PR (`tests/integration/conformance.test.ts` + the adapter conformance suites — R2 via `pnpm test:adapter-cloudflare`), and exercised under contention by the all-to-all single-key cascade in `tests/integration/randomized.test.ts`. Supported.                                                             |
| **Tier 1.5**      | MinIO                         | Dev / CI harness only (`pnpm dev:storage`, `pnpm test:minio`). Conditional writes — including bare-`*` create-if-absent — are verified locally against the pinned MinIO; not a production target we promise, but it passes the conformance suite.                                                                                       |
| **Unsupported**   | GCS (S3-interop), Azure Blob  | GCS's XML / S3-interop API scopes the S3 `If-Match` / `If-None-Match` headers to **reads**; native conditional writes require `x-goog-if-generation-match` (not an S3 header), which baerly does not emit — so lock-free CAS over the plain S3 API is not available on GCS. Azure Blob is not an S3 API at all. Neither has an adapter. |
| **Anything else** | other S3-compatible endpoints | Run `baerly doctor --bucket`. **Green ⇒ the conditional verbs are honoured — should work, you own production validation. Red ⇒ won't.**                                                                                                                                                                                                 |

## Per-provider conditional-write matrix

Dated because provider behaviour drifts — re-verify before relying on a
non-Tier-1 row.

| Provider         | `If-None-Match: "*"` (create-if-absent)                                                    | `If-Match: <etag>` (CAS)         | How established                         | Verified |
| ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------- | --------------------------------------- | -------- |
| AWS S3           | Yes                                                                                        | Yes                              | CI conformance + contention cascade     | 2026-06  |
| Cloudflare R2    | Yes                                                                                        | Yes                              | CI conformance + contention cascade     | 2026-06  |
| MinIO            | Yes (baerly emits a bare `*`)                                                              | Yes                              | dev-stack `pnpm test:minio` conformance | 2026-06  |
| GCS (S3-interop) | Not over the S3 path — the header is read-scoped; writes need `x-goog-if-generation-match` | Same — read-scoped on S3 interop | Provider XML-API docs; unsupported      | 2026-06  |
| Azure Blob       | n/a (not an S3 API)                                                                        | n/a                              | n/a                                     | 2026-06  |

> **Tracking note (GCS):** because GCS scopes `If-None-Match` to reads
> over the S3 path, its **concurrent** create-if-absent
> exactly-one-winner behavior is moot and **unverified** — if a future
> GCS adapter ever emits `x-goog-if-generation-match`, that adapter
> must pass the `ifNoneMatch-concurrent` probe before GCS can leave the
> Unsupported tier.

> Conditional writes are also subject to **per-object / per-prefix
> write-rate limits**. Under single-write commit the high-frequency
> contention is the `log/<seq>` create — distinct keys but one `log/`
> prefix (see the hot-prefix cliff in
> [cost-model.md](../about/cost-model.md)); `current.json` is now only
> compactor-written. GCS documents a limit of roughly one write per
> second to a single object name, which would bottleneck conditional
> writes even if its verbs were honoured over the S3 path. Treat any
> per-object/per-prefix write-rate figure as provider-specific and
> re-verify against the provider's quota docs.

Provider references:

- GCS XML-API conditional requests (`x-goog-if-generation-match`):
  <https://cloud.google.com/storage/docs/xml-api/reference-headers>
- GCS per-object request-rate limits:
  <https://cloud.google.com/storage/docs/request-rate>
- AWS S3 conditional writes (`If-None-Match` / `If-Match`):
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>
- Cloudflare R2 conditional operations:
  <https://developers.cloudflare.com/r2/api/s3/extensions/>
