---
title: Sync bounds across adapters
audience: adr
summary: ADR 0021 — Sync bounds across adapters.
last-reviewed: 2026-05-12
tags: [decision, adr]
related: [README.md]
---

# 0021 — Sync bounds across adapters

## Status

Accepted (2026-05-11).

## Context

The protocol kernel lives in
[`packages/protocol/`](../../packages/protocol). Four `Storage`
adapters consume it today
([`tests/integration/randomized.test.ts:60-128`](../../tests/integration/randomized.test.ts)
plus the Cloudflare-pool variant at
[`packages/adapter-cloudflare/src/randomized.test.ts`](../../packages/adapter-cloudflare/src/randomized.test.ts)):

- `memory` — `MemoryStorage` shared per bucket; zero infra.
- `local-fs` — `LocalFsStorage` over a fresh tmp dir; zero infra.
- `node-minio` — `S3HttpStorage` against Toxiproxy → Minio with a
  100ms-cadence fault-injection twiddler flipping the proxy.
- `cloudflare-r2` — `r2BindingStorage` against the miniflare R2
  binding under Workerd.

The cascade body in
[`tests/fixtures/randomized-cascade.ts`](../../tests/fixtures/randomized-cascade.ts)
is backend-agnostic: three writer instances all contend on one
`current.json`, each with a per-instance clock offset randomly drawn
from [-1000ms, +1000ms]
([`tests/fixtures/randomized-cascade.ts:221-228`](../../tests/fixtures/randomized-cascade.ts)),
and the test asserts every write-to-read sequence is observably causal
at the row level.

The protocol relies on two clock-skew bounds:

- `LAG_WINDOW_MILLIS = 5000` ms — half-window within which a manifest
  write's embedded timestamp must agree with the server's
  `LastModified` for the write to be accepted by replaying clients
  ([`packages/protocol/src/constants.ts:1-15`](../../packages/protocol/src/constants.ts)).
- `MANIFEST_LIST_LOOKAHEAD_MILLIS = 10000` ms — how far into the
  future the manifest LIST cursor is positioned
  ([`packages/protocol/src/constants.ts:17-28`](../../packages/protocol/src/constants.ts));
  must be ≥ `LAG_WINDOW_MILLIS`.

Two options for what guarantee to publish:

- **Total order across the bucket.** Strong, but requires a
  coordination service or 2PC; both ruled out by the portable
  `(Request) => Response` server contract and
  [ADR-0018](./0018-tenant-cas-isolation.md) (per-collection CAS).
- **Single-key causal consistency, bounded skew, no cross-collection
  ordering.** Matches the per-collection CAS scope
  ([ADR-0018](./0018-tenant-cas-isolation.md)), is verifiable by
  property test, and is the guarantee every prior-art S3-as-DB system
  delivers.

## Decision

The guarantee is single-key causal consistency under bounded clock
skew: for any single `(collection, docId)` pair, every write is
causally observed by every reader within roughly one polling cycle plus
`LAG_WINDOW_MILLIS` (5 s). Across collections — or across `docId`s
within a collection — the protocol provides no ordering beyond what the
underlying `Storage` adapter provides on a single LIST. The bound is
enforced by the property-based cascade in
[`tests/fixtures/randomized-cascade.ts`](../../tests/fixtures/randomized-cascade.ts),
parameterised over the four supported adapters.

The four adapters all satisfy three minimum-contract bullets:

1. **Read-after-write on the same key.** A `put(K)` then `get(K)` from
   the same `Storage` instance returns the just-written value or a
   higher ETag. All four adapters meet this trivially.
2. **CAS via `If-Match` and `If-None-Match: "*"`.** The protocol uses
   both. The contract lives at
   [`packages/protocol/src/storage/types.ts`](../../packages/protocol/src/storage/types.ts)
   and is exercised by the conformance suite at
   [`packages/protocol/src/storage/conformance.ts`](../../packages/protocol/src/storage/conformance.ts).
3. **Eventual consistency on LIST.** A LIST issued after a PUT
   eventually sees the PUT; the cascade does NOT depend on
   read-your-writes LIST consistency, which is why the Toxiproxy
   variant can flip the network 10× per second during the test and
   still pass.

Single-key causal consistency is the strongest guarantee achievable on
S3-compatible storage without a coordination service or 2PC. The
protocol's correctness rests on this bound, the bound rests on the
four adapters meeting the three contract bullets, and the cascade is
the executable specification that proves they do. Cross-collection
ordering is an explicit non-goal; applications that need it fold the
writes through `Db._raw` or graduate to Postgres
([ADR-0013](./0013-export-contract.md)).

## Consequences

- Adding a new `Storage` adapter MUST add a variant to the cascade.
  The variant table at
  [`tests/integration/randomized.test.ts:74-128`](../../tests/integration/randomized.test.ts)
  is the registry; the Workerd-side entry lives in
  [`packages/adapter-cloudflare/src/randomized.test.ts`](../../packages/adapter-cloudflare/src/randomized.test.ts)
  and is not duplicated in the Node-side file.
- Tightening `LAG_WINDOW_MILLIS` below 5000 ms can cause spurious
  rejections on machines that haven't synced NTP; loosening it widens
  the window during which causal ordering can be disturbed by skew.
  The 5000 ms value is the protocol's tolerance; changing it is a
  protocol-breaking change.
- The `MANIFEST_LIST_LOOKAHEAD_MILLIS = 10000` ms cursor lookahead is
  a derived constant; it MUST be ≥ `LAG_WINDOW_MILLIS`, and the
  constraint is asserted at
  [`packages/protocol/src/constants.ts:23-24`](../../packages/protocol/src/constants.ts).
- The cascade asserts NOTHING about cross-collection ordering. An
  application that observes a "happens-after" ordering between two
  collections during a test run is reading test-specific scheduling
  noise, not a protocol guarantee.
- The per-collection CAS scope
  ([ADR-0018](./0018-tenant-cas-isolation.md)) is what makes this
  bound tractable: every commit touches exactly one `current.json`, so
  the cascade's contention model is one-key-per-instance, not
  one-key-per-tenant. The cross-instance clock-skew bound here is the
  complement of the in-bucket dwell window in
  [ADR-0020](./0020-gc-lag-window.md).
- The cascade runs under the Workerd pool via the `cloudflare-pool`
  vitest project; the Node-side variants run under the default
  project. Splitting by project keeps `node:fs/promises` + `aws4fetch`
  out of Workerd and the R2 binding out of plain Node forks
  ([`tests/integration/randomized.test.ts:10-14`](../../tests/integration/randomized.test.ts)).
- Future adapters (AWS Lambda, Bun, Deno, Fly) inherit the bound by
  passing the cascade. Adapters that *cannot* pass — e.g., a
  hypothetical adapter over an eventually-consistent blob store with
  no CAS support — are out of scope by definition.
