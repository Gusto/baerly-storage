---
title: Storage compatibility
audience: spec
doc_type: current-contract
summary: Which S3-compatible stores baerly-storage supports, and the conditional-write features it depends on.
last-reviewed: 2026-06-30
tags: [protocol, s3]
related: [s3-xml-escaping-cases.md]
---

# Storage compatibility

Which S3-compatible stores baerly-storage supports (see
[Support tiers](#support-tiers) below), and the minimal S3 API surface
the protocol depends on.

## S3 API surface used

### `PUT and GET /<bucket>/<key>`

The basic S3 API is very simple and intuitive. You use a HTTP `PUT <endpoint>/<bucket>/<key>` to set a file, and `GET <endpoint>/<bucket>/<key>` to retrieve it later. It is the obvious API if you wanted namespaced storage over a RESTFul interface.

### Response headers: `etag`, `date`, `x-amz-version-id`, `LastModified`

There are additional features using standard HTTP features like `etag` which help with network efficiency. S3 returns the `Date` which is useful for as an authoritative clock source. There are also additional features like versioned objects which help with lifecycle management of resources. And `LastModified` which records the time the write was performed. Every vendor I have tested supports etags on `GET` requests but not object versioning (e.g. Cloudflare R2 doesn't).

### `GET /<bucket>?list-object-v2&prefix=<PREFIX>`

To list the objects you `GET <endpoint>/<bucket>` which returns XML and is ordered and paginated. The result set includes the keys and the etags of the resource. By providing a prefix you target a subset of the buckets contents.

### S3 Strong Consistency Guarantees

S3 states strong consistency between its GET, PUT and list operations.

_After a successful write of a new object, or an overwrite or delete of an existing object, any subsequent read request immediately receives the latest version of the object. S3 also provides strong consistency for list operations, so after a write, you can immediately perform a listing of the objects in a bucket with any changes reflected._ -- [S3 docs](https://aws.amazon.com/s3/consistency/)

This is recent. Until **December 2020**, S3 was only eventually consistent for overwrites and list-after-write. Building a database on S3 meant putting a linearizable metadata service (ZooKeeper, etcd, DynamoDB, FoundationDB) in front of the eventually-consistent blob store to hold the authoritative pointer to "what exists" — which is what Iceberg, Delta Lake, and Snowflake all do. AWS then shipped strong read-after-write for every operation as a changelog entry; Werner Vogels' engineering retrospective on `allthingsdistributed.com` is the readable long-form on what changed. After that, the recipe this protocol uses — immutable log entries plus linearizable conditional object creates, no external catalog — became viable. Iceberg, Delta Lake, Turbopuffer, Litestream, and SlateDB all converged on variants of this shape in the years since.

### S3 is an Immutable Key-Value store with a single index

S3 is an immutable key value store for (potentially very large) binary blobs. The keys are limited in size (1kb), but you can to range queries by prefix query in one direction only.

You cannot update objects in-place — every object is immutable once written. Modern S3 _does_, however, support conditional writes (`If-None-Match: "*"` to create-if-absent, and `If-Match: <etag>` to compare-and-swap), and the protocol depends on them: a commit is a single `If-None-Match: "*"` create on the numbered `log/<seq>` object, and the compactor advances `current.json` with `If-Match` CAS (see [the protocol invariants in sync-protocol.md](sync-protocol.md#protocol-invariants)). So it's tricky getting multiplayer out of this system, but possible thanks to those conditional writes plus the strong consistency guarantees.

## Key namespace

baerly-storage addresses objects by string key over `PUT` / `GET` /
`DELETE <endpoint>/<bucket>/<key>`. A **valid key** is:

- **non-empty**;
- at most **1024 bytes** of UTF-8 (`MAX_KEY_BYTES` — the S3/R2 hard limit); and
- `/`-delimited, with **no path segment equal to `.` or `..`**.

The dot-segment rule is a **portability invariant, not a vendor quirk.**
RFC 3986 §5.2.4 ("remove dot segments") is mandatory for every conformant
URL parser, so a key whose segment is `.` or `..` is rewritten _before the
request is signed or sent_: `<endpoint>/<bucket>/.` normalizes to
`<endpoint>/<bucket>/` (a bucket-root operation) and
`<endpoint>/<bucket>/..` escapes the bucket entirely. This happens
identically in TypeScript (`new URL` / `fetch`), Go (`net/url`), Rust
(`url`), Python (`urllib`), and any other language a `Storage` port
targets — over the wire it surfaces as a confusing bucket-root
`403 AccessDenied`, never a clear error. So the contract is to reject such
keys **at the boundary**, uniformly, rather than emit an unaddressable
request.

Enforcement is split by layer:

- The **dot-segment / empty-key** rule (the unaddressable cases above) is
  enforced at the **raw `Storage` boundary**: every adapter validates the
  key on `get` / `put` / `delete` and rejects a violation with
  `BaerlyError{code:"InvalidConfig"}` (`assertValidStorageKey` in
  `@baerly/protocol`). This is the `Storage`-level counterpart to the
  higher-level `assertPathSegment` guard, which already screens
  caller-controlled key _segments_ (`_id`, `collection`, `app`, `tenant`).
  The cross-adapter "key namespace" block in
  `defineStorageConformanceSuite` asserts each backend rejects `.` and `..`
  identically — **a language port MUST reproduce that rejection to
  conform.**
- The **1024-byte ceiling** is enforced on the **write path**, where
  multi-segment keys are assembled (`assertKeyWithinLimit` at the writer's
  PUT sites), rather than at the `Storage` boundary — per-segment caps
  don't bound the assembled sum, and this keeps the boundary guard free of
  a UTF-8 length pass on every call.

The kernel itself never _emits_ a `.` / `..` or over-length key; both
guards exist so a misuse fails fast and identically everywhere instead of
surfacing as an opaque provider 400/403.

> **A `list` _prefix_ is not a key.** The prefix passed to `Storage.list`
> rides the `?prefix=` query component, where `.` / `..` are harmless on
> AWS S3 and R2. (MinIO's gateway is stricter — it validates the prefix as
> a POSIX path too — which is why the MinIO conformance run pins a
> `.`-free prefix arbitrary.) Only _keys_, which become path segments, are
> constrained by the dot-segment rule.

## Status → `BaerlyErrorCode` mapping

A `Storage` port translates object-store HTTP status codes into the
kernel's `BaerlyError` codes. The authoritative sources are the
`errorCodes[]` table in `packages/server/spec/baerly.spec.json` (which
carries each code's canonical `httpStatus` and `retriable` hint) and the
S3-status → code mapping in `packages/adapter-node/src/s3-http.ts`. A
language port MUST reproduce the mapping below to conform.

Two subtleties are load-bearing:

- **`404` on a plain `GET` is _not_ an error.** A missing key resolves to
  `null` (`Storage.get` returns `Promise<StorageGetResult | null>`), never
  a thrown `BaerlyError`. The kernel's forward-probe tail discovery ("first
  `404` = tail") depends on this: a missing `log/<seq>` must surface as
  `null`, not an exception. (`s3-http.ts` `get`: `case 404: return null`.)
- **`409` vs `412` on a conditional create diverge by intent.** A `409
  ConditionalRequestConflict` on an `If-None-Match: "*"` create means the
  write was _contended_ and may not have landed, so it maps to a
  **retryable** `NetworkError` — the single-write-commit writer re-probes
  and either wins or sees `412`. A direct `Conflict` there would adopt-read
  a possibly-absent entry. (`s3-http.ts` `put`: the `409 && ifNoneMatch ===
  "*"` branch.)

| Condition (over the wire / at the boundary)                    | `BaerlyError.code` | Nominal `httpStatus` | Retriable | Source                                                              |
| -------------------------------------------------------------- | ------------------ | -------------------- | --------- | ------------------------------------------------------------------- |
| `GET` / `HEAD` `404` (missing key)                             | _(none — `null`)_  | —                    | —         | `s3-http.ts` `get` `case 404: return null`                          |
| `PUT` with `If-Match` sees `412`                               | `Conflict`         | 409                  | Yes       | `s3-http.ts` `put` `res.status === 412`; spec.json `Conflict`       |
| `PUT` with `If-Match` sees `404` (MinIO's stale-CAS shape)     | `Conflict`         | 409                  | Yes       | `s3-http.ts` `put` `404 && ifMatch !== undefined`                   |
| `PUT` `If-None-Match: "*"` sees `409` (contended create)       | `NetworkError`     | 502                  | Yes       | `s3-http.ts` `put` `409 && ifNoneMatch === "*"`                     |
| Any verb sees `403`                                            | `AccessDenied`     | 403                  | No        | `s3-http.ts` `403` branches; spec.json `AccessDenied`               |
| Any verb sees `429` or `5xx` (retries exhausted)               | `NetworkError`     | 502                  | Yes       | `s3-http.ts` `429 \|\| status >= 500` branches; spec.json           |
| Unparseable / unexpected success body or missing `ETag`        | `InvalidResponse`  | 502                  | No        | `s3-http.ts` `InvalidResponse` branches; spec.json                  |
| Empty key or a `.` / `..` path segment (rejected pre-request)  | `InvalidConfig`    | 400                  | No        | `assertValidStorageKey`; spec.json `InvalidConfig`; see [Key namespace](#key-namespace) |

The `Conflict` code has a nominal `httpStatus` of `409` and is marked
`retriable: true` in `baerly.spec.json` (CAS lost — the writer re-reads and
retries). `NetworkError` is `retriable: true` (`httpStatus` `502`);
`AccessDenied`, `InvalidResponse`, `NotFound`, and `InvalidConfig` are all
`retriable: false`. A `DELETE` against a missing key throws nothing at all
— see clause 1 below.

## Storage behavioral contract

These are the behaviors a `Storage` port MUST honour, as asserted by
`defineStorageConformanceSuite` in
`packages/protocol/src/storage/conformance.ts`. They are numbered so a
porter can cite a specific clause.

1. **`delete` MUST be idempotent.** Deleting a key that does not exist MUST
   resolve successfully (return `undefined`), NOT throw. (`s3-http.ts`
   treats `200` / `204` / `404` on `DELETE` as success; conformance:
   _"delete is idempotent on a missing key"_.)
2. **`get` of a missing key MUST return `null`.** It MUST NOT throw a
   `NotFound` / `BaerlyError`. (Conformance: _"get of missing key returns
   null"_.)
3. **`list("")` MUST enumerate the entire namespace.** An empty prefix is a
   whole-bucket scan; every stored key MUST be yielded. (Used by the
   suite's own `deleteAllOnce` teardown and the _"returns the current etag
   for each entry"_ case, both listing `""`.)
4. **`startAfter` MUST be strict-exclusive.** When `list(prefix, {
   startAfter })` is given, the `startAfter` key itself MUST NOT be
   returned — only keys strictly greater than it. (Conformance: _"startAfter
   is exclusive"_ and the _"startAfter:k yields strict suffix of lex-sorted
   keys"_ property.)
5. **`list` results MUST be sorted by UTF-8 byte order, NOT UTF-16.** For
   BMP characters the two agree, but they diverge for supplementary-plane
   characters (surrogate pairs): a UTF-16 code-unit sort orders an emoji
   _before_ a high-BMP private-use character, while UTF-8 byte order — what
   S3 / R2 use on the wire — orders it _after_. A port that sorts with its
   native string comparator will pass the ASCII property tests yet be
   silently wrong here. The fixed witness vector is the conformance case
   _"keys sort by UTF-8 byte order, not UTF-16 (supplementary-plane
   divergence)"_.
6. **`maxKeys` MUST cap the yielded count** to the first `maxKeys` keys in
   sort order. (Conformance: _"maxKeys caps the result"_.)
7. **Body round-trip MUST be byte-exact at the size boundaries.** A `0`-byte
   body and a 1 MiB (`1048576`-byte) body MUST `put` then `get` back
   byte-for-byte. (Conformance: _"round-trip exactly 0 bytes"_ …
   _"round-trip exactly 1048576 bytes"_, capped by `maxBodyBytes`.)

### Out of scope for a `Storage` port

Range-GET (partial-object reads via `Range:`) and delimiter-based listing
(`?delimiter=` with `CommonPrefixes`) are intentionally OUT OF SCOPE — the
kernel never issues them, so "unsupported" here means "deliberately not
required," not "forgotten."

### ETag opacity

The `ETag` string is **opaque**. A port MUST compare it byte-for-byte —
**including any surrounding quotes** — and round-trip it unchanged; it MUST
NOT strip quotes, lowercase, or otherwise normalize the value. The
`ifMatch` CAS contract (see [conditional writes](#s3-is-an-immutable-key-value-store-with-a-single-index))
depends on this: the writer passes back the exact `etag` string returned by
a prior `put`, and the store must match it verbatim. The conformance suite
pins this by asserting `get(...).etag === put(...).etag` exactly, and by
passing quoted literals such as `"deadbeef"` (with the quotes) straight
through the `ifMatch` path.

## Support tiers

baerly-storage's commit path creates-if-absent the numbered `log/<seq>`
object with `If-None-Match: "*"` (that create IS the commit — there is no
`current.json` CAS on the commit path); the compactor advances
`current.json` with `If-Match`. A store is _supported_ only if it
honours those conditional writes. Run `baerly doctor --bucket=<uri>` to
live-probe a bucket's conditional-write support before relying on it;
exit 2 means the verbs aren't honoured — do not deploy. Cloudflare
`baerly deploy` can run this same probe when passed
`--probe-bucket=<uri>` and aborts before deploying if that opt-in
preflight fails. Self-hosted Node deployments run the doctor command
manually because there is no generic deploy wrapper.

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
> conformance paths assert the same property where they run: native R2
> in PR CI, MinIO in the local dev stack, and cloud S3-compatible
> endpoints in credential-gated runs.

> **Deployment-topology rule — no negative caching in front of the
> log/CAS path.** The log and CAS requests must reach the object-store
> API **directly**, never through a negative-caching CDN or proxy. A
> cached `404` on a `log/<seq>` that was just created would corrupt the
> reader's forward-probe ("first 404 = tail"), hiding a committed
> entry. Object-store APIs are themselves strongly consistent
> (post-2020); this constrains what you put _in front of_ them, not the
> store.

| Tier              | Stores                        | What it means                                                                                                                                                                                                                                                                                                                |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier 1**        | Cloudflare R2, AWS S3         | Supported. R2's native `r2BindingStorage` adapter is PR-CI gated by `pnpm test:adapter-cloudflare`; R2 and AWS through `S3HttpStorage` are covered by credential-gated `pnpm test:conformance` runs, not by fresh-checkout PR CI.                                                                                            |
| **Tier 1.5**      | MinIO                         | Dev / local conformance harness (`pnpm dev:storage`, `pnpm test:minio`, `pnpm test:adapter-node`). Conditional writes — including bare-`*` create-if-absent — are verified against the pinned local MinIO; not a production target we promise.                                                                               |
| **Unsupported**   | GCS (S3-interop), Azure Blob  | `gcsStorage` exists as an S3-interop factory, but GCS documents S3 `If-Match` / `If-None-Match` as read-scoped and baerly-storage does not emit native `x-goog-if-generation-match`, so GCS is unsupported for database use unless a live probe and conformance run prove otherwise. Azure Blob is not an S3 API and has no adapter. |
| **Anything else** | other S3-compatible endpoints | Run `baerly doctor --bucket`. **Green ⇒ the conditional verbs are honoured — should work, you own production validation. Red ⇒ won't.**                                                                                                                                                                                      |

> **R2's `list` is eventually consistent — and that's fine here.** Unlike
> AWS S3 (strongly consistent for list since Dec 2020) and the local MinIO
> dev stack, Cloudflare R2's S3 `ListObjectsV2` is *eventually* consistent:
> list-after-write and list-after-delete can lag by a short window. This
> does **not** weaken the protocol. The commit/read path never lists — a
> commit is a conditional `log/<seq>` create, and readers discover the tail
> by forward-probe `GET` ("first 404 = tail"), both strongly consistent on
> R2; `list` is used only by idempotent maintenance enumeration (compaction
> / GC), which re-runs to convergence. The practical consequence is in
> testing: the credential-gated `pnpm test:conformance` run against real R2
> exercises `list`/read-back assertions through a bounded poll
> (`eventuallyConsistentList` in `defineStorageConformanceSuite`) instead of
> asserting a single immediate snapshot over the wire. AWS S3, MinIO, and
> the native R2 binding assert immediately.

### S3 (over HTTP) from a Cloudflare Worker

A Worker normally uses a native R2 binding (`r2BindingStorage`, wired by
default in `baerlyWorker`). When the approved bucket is AWS S3 or a
cross-account R2 — i.e. there is no in-account binding — inject
`S3HttpStorage` instead. Import it from the Worker-safe
`@gusto/baerly-storage/s3` subpath (its closure has no `node:` builtins;
`@gusto/baerly-storage/node` does and will not bundle):

```ts
import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";
import { S3HttpStorage, sigV4Signer } from "@gusto/baerly-storage/s3";
import config from "../../baerly.config.ts";

export default baerlyWorker((env) => ({
  config,
  storage: new S3HttpStorage({
    endpoint: env.S3_ENDPOINT, // e.g. https://s3.us-east-1.amazonaws.com
    bucket: env.S3_BUCKET,
    sign: sigV4Signer({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
    }),
  }),
}));
```

The commit protocol requires exactly-one-winner create-if-absent
(`If-None-Match: "*"`) and `If-Match` CAS. Native R2 bindings guarantee
this; over the S3 HTTP API you inherit the *endpoint's* conditional-write
and consistency behavior, so this path is only as strong as the backend
you point it at. Cost trade-off: the `/s3` closure carries `aws4fetch` +
`fast-xml-parser`; a same-account binding avoids both.

**Support tier.** This path is opt-in and sits at the same tier as
AWS-via-`S3HttpStorage`: credential-gated, with production validation you
own. Its wire behavior is verified under Node (against MinIO and, in
credential-gated runs, real S3 / R2). Under workerd, CI covers it on two
levels: `tests/integration/s3-worker-safe.test.ts` proves the
`@gusto/baerly-storage/s3` closure *bundles* `node:`-free (it loads in a
Worker), and `tests/integration/s3-worker-wire.test.ts` proves it *runs*
in a real Workerd isolate — `S3HttpStorage` + `sigV4Signer` drive a
put / get / CAS / list round-trip through an in-memory S3-shaped `fetch`
stub, exercising aws4fetch's WebCrypto signing, `fast-xml-parser`, and the
`Request`/`Response` plumbing in-isolate. What CI does **not** do is drive
a *real* S3 endpoint from workerd (TLS + the endpoint's own
conditional-write semantics); that is the manual e2e recipe in
`manual-e2e/README.md`. Run `baerly doctor --bucket=<uri>` against your
endpoint before relying on it.

**Deploy tooling still assumes R2.** `baerly deploy` and
`baerly doctor --target=cloudflare` walk `wrangler.jsonc`'s `r2_buckets[]`
and will flag a missing binding — they do not yet understand an S3-only
Worker. Keep (or intentionally omit) the R2 binding with that in mind, and
validate the S3 endpoint with `baerly doctor --bucket=<uri>` rather than
the target-scoped `doctor`.

**Credentials posture.** A same-account R2 binding needs no secret. This
path instead requires long-lived static cloud credentials
(`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) stored as Worker secrets;
scope them to the one bucket and treat them like any other deployed
secret. `sigV4Signer` covers static credentials only — for rotating /
temporary credentials, pass your own `(req) => Promise<Request>` signer to
`S3HttpStorage`.

## Per-provider conditional-write matrix

Dated because provider behaviour drifts — re-verify before relying on a
non-Tier-1 row.

| Provider         | `If-None-Match: "*"` (create-if-absent)                                                    | `If-Match: <etag>` (CAS)         | How established                                       | Verified |
| ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------- | -------- |
| AWS S3           | Yes                                                                                        | Yes                              | Credential-gated `pnpm test:conformance`; S3 docs     | 2026-06  |
| Cloudflare R2    | Yes                                                                                        | Yes                              | PR-CI native R2 adapter; credential-gated S3-HTTP run | 2026-06  |
| MinIO            | Yes (baerly-storage emits a bare `*`)                                                      | Yes                              | Local dev-stack conformance (`MINIO=1`)               | 2026-06  |
| GCS (S3-interop) | Not over the S3 path — the header is read-scoped; writes need `x-goog-if-generation-match` | Same — read-scoped on S3 interop | Factory exists; provider XML-API docs; unsupported    | 2026-06  |
| Azure Blob       | n/a (not an S3 API)                                                                        | n/a                              | No adapter                                            | 2026-06  |

> **Tracking note (GCS):** because GCS scopes `If-None-Match` to reads
> over the S3 path, its **concurrent** create-if-absent
> exactly-one-winner behavior is moot and **unverified** — if a future
> native GCS adapter ever emits `x-goog-if-generation-match`, that
> adapter must pass the `ifNoneMatch-concurrent` probe before GCS can
> leave the Unsupported tier.

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
