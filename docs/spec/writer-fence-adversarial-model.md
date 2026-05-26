---
title: Writer-fence adversarial model
audience: spec
summary: Failure envelope of the two-phase fence-claim protocol under absent, delayed, forged, and non-monotonic Date headers.
last-reviewed: 2026-05-26
tags: [protocol, fence, claim, adversarial-model, patent-c1]
related: [sync-protocol.md, causal-consistency-checking.md, log-entry-shape.md]
---

# Writer-fence adversarial model

This document is the written failure envelope of the two-phase
fence-claim protocol implemented in
[`packages/protocol/src/coordination/current-json.ts`](../../packages/protocol/src/coordination/current-json.ts)
(the `claimWriter` function), and verified against in
[`packages/protocol/src/coordination/current-json.test.ts`](../../packages/protocol/src/coordination/current-json.test.ts).

The mechanism: promote a writer to a new generation epoch over an
eventually-consistent object store by issuing **two** conditional
PUTs. The first bumps the integer `writer_fence.epoch` field with
`claimed_at` set to the empty string (the "claim time unknown"
sentinel). The second overwrites the record with `claimed_at`
filled in from the **trusted** `StoragePutResult.serverDate`
value — extracted from the storage server's HTTP `Date` response
header on the first PUT. Any concurrent writer landing between
the two PUTs loses on the second CAS while the durable epoch bump
survives.

## Threat model

An adversary controls:

1. **The network between client and storage.** Arbitrary delay,
   reorder, drop, and replay of any individual HTTP request /
   response. Cannot forge a CAS success on the storage server,
   which is assumed honest.
2. **Peer writers.** Any number of concurrent writers may issue
   `claimWriter` calls on the same `current.json` key with
   arbitrary owner identifiers. Peers are not assumed honest —
   they may attempt to mint a stamp identical to another peer's.
3. **The local clock on every client.** Each writer's `new Date()`
   may disagree with every other writer's local clock by up to
   `LAG_WINDOW_MILLIS` (5000 ms; see
   [`packages/protocol/src/constants.ts`](../../packages/protocol/src/constants.ts)).
   The kernel deliberately never reads `Date.now()` to populate
   `claimed_at`; this section enumerates why.
4. **The storage server's `Date` response header.** Optional under
   S3 specification. Some adapters surface it, some do not. Even
   where surfaced, the value can be omitted on a per-request basis,
   can lag behind real time, or can advance non-monotonically
   across requests (after server-side NTP step).

An adversary does NOT control:

1. The storage server's CAS arbitration. If two PUTs race with the
   same `If-Match: <etag>` precondition, the storage server picks
   exactly one winner; the loser receives a 412.
2. The `Storage` interface contract: `put` is atomic with respect
   to the returned `etag` and `serverDate`. Implementations that
   violate this — for example, returning the wrong etag — break
   correctness of the entire kernel, not just `claimWriter`.

## Invariants the two-phase fence-claim preserves

Under the threat model above, every observable execution of
`claimWriter` satisfies:

- **I1. Monotonic epoch.** `writer_fence.epoch` is strictly
  increasing over the lifetime of `current.json`. Bumps happen
  only inside `claimWriter`; the increment is built into the
  provisional PUT body before it is signed for CAS, so a peer
  landing between read and PUT loses cleanly.
- **I2. Durable epoch bump.** If `claimWriter` returns
  successfully OR throws `Conflict` from the *stamp* PUT (not the
  provisional PUT), the epoch bump from the provisional PUT is
  durable. A reader observing `writer_fence.epoch === N` after a
  *stamp* loss sees `claimed_at: ""`, which it MUST treat as
  "claim time unknown" and proceed — the empty-string sentinel
  is the contract.
- **I3. Server-clock provenance.** Every non-empty `claimed_at`
  string ever observable on disk is exactly the ISO-8601 encoding
  of some `StoragePutResult.serverDate` value returned by the
  storage server during a *successful* CAS PUT. No client's
  `Date.now()` ever leaks into `claimed_at`. Verified by the
  `narrative: single-PUT records client clock; two-phase records
  server clock (patent C1)` test in `current-json.test.ts`.
- **I4. Uniqueness of `(epoch, claimed_at)`.** No two successful
  `claimWriter` returns ever carry the same `(epoch, claimed_at)`
  tuple unless one is a retry continuation of the other's
  provisional PUT (the rare case where the stamp PUT lost,
  `claimed_at` remained `""`, and a subsequent claim succeeded).
  Verified by the `two-phase: (epoch, claimed_at) tuples are distinct and only carry server-clock values` fast-check property in `current-json.test.ts`.

## Failure modes

Each row enumerates a hostile or non-cooperative storage-server
behavior, what the two-phase fence-claim observes, and which of
invariants I1–I4 above is preserved or compromised.

| Failure mode | What `claimWriter` observes | I1 | I2 | I3 | I4 | Notes |
|---|---|:-:|:-:|:-:|:-:|---|
| **F1. Server omits `Date` header** (memory adapter; some bare-metal proxies; R2 binding in some configurations) | First-PUT result has `serverDate: undefined`. `claimWriter` skips the stamp PUT and returns the record with `claimed_at: ""`. | ✓ | ✓ | ✓ | ✓ | The empty-string sentinel is the contract; readers MUST NOT parse it. The epoch bump is durable, and the fence's safety property derives from the epoch (per I2), not from `claimed_at`. |
| **F2. Server lies about `Date`** (compromised proxy or hostile load balancer) | First-PUT result carries a forged `serverDate`. `claimWriter` stamps the forgery. | ✓ | ✓ | ✗ | ✓ | I3 is compromised — `claimed_at` no longer reflects the real wall clock — but the protocol's *safety* derives from I1 (monotonic epoch), which is unaffected. The patent claim does not assert that the storage server is honest; it asserts that the *clock used* is the server's, not the client's. A compromised proxy is outside the asserted defended envelope; see "What is NOT defended" below. |
| **F3. Peer wins between PUTs 1 and 2** (concurrent claim, or any concurrent CAS write to `current.json`) | Provisional PUT succeeds; peer's write invalidates the etag; stamp PUT fails with `Conflict`. `claimWriter` throws `Conflict`. | ✓ | ✓ | ✓ | ✓ | The patent's central claim — the loser's epoch bump is durable, `claimed_at` remains `""` (treated as "unknown"). The next reader sees the bumped epoch and proceeds; the next claimant builds on that durable bump. Verified by the `two-phase: peer landing between PUTs loses on stamp; epoch bump survives durably` test. |
| **F4. Stamp PUT receives 412** (race with another concurrent writer's `casUpdateCurrentJson`) | Identical to F3. | ✓ | ✓ | ✓ | ✓ | Indistinguishable from F3 at the `Storage` seam; both surface as `Conflict`. |
| **F5. Client crashes between PUTs 1 and 2** (process kill, network partition, hard timeout) | The provisional PUT is durable; no stamp ever lands. A subsequent reader observes `epoch: N+1, claimed_at: ""`. | ✓ | ✓ | ✓ | ✓ | Identical observable state to F1 and F3 from the reader's perspective. The empty-string sentinel does the work; no recovery scan is needed. |
| **F6. Server advances `Date` non-monotonically** (NTP step across requests; clock jumps backwards) | Successive `claimWriter` returns may carry `claimed_at` values whose ISO-8601 strings are not monotonically increasing. | ✓ | ✓ | ✓ | ✓ | The protocol does NOT promise monotonic `claimed_at`; safety is on `epoch` (which is integer-monotonic by construction). `claimed_at` is informational telemetry; readers MUST NOT use it to order claims. |
| **F7. Storage adapter never surfaces `serverDate`** (some test harnesses, future bindings) | Every `claimWriter` call returns `claimed_at: ""`. | ✓ | ✓ | ✓ | ✓ | Degenerate but safe. The fence still functions; `claimed_at` is debug-only. |
| **F8. Bounded clock skew up to `LAG_WINDOW_MILLIS`** (NTP-synchronized but not lockstep) | Multiple peers' local clocks disagree by ≤ 5000 ms; the server's clock is the single shared reference. | ✓ | ✓ | ✓ | ✓ | The patent's adversarial bound. The single-PUT counter-example breaks I3 and I4 here; the two-phase protocol does not. The two-phase side is verified by the `two-phase: (epoch, claimed_at) tuples are distinct and only carry server-clock values` fast-check property; the single-PUT counter-example breaking I3 is verified deterministically by the `narrative: single-PUT records client clock; two-phase records server clock (patent C1)` test. |

Pinned by `packages/protocol/src/coordination/current-json.test.ts` §"lying-Date adversary: invariants I1–I3 hold under any bounded Date adversary" (`FC_NUM_RUNS=100` default, verified at 10 000). The property drives a fresh `current.json` through `SkewedClockStorage` under three named bounded `Date` adversaries — `"backward-jump"` (strictly-decreasing `serverDate`), `"repeated"` (pinned `serverDate`), and `"non-monotonic"` (oscillating `serverDate` within ±10 min) — and asserts that every observable execution preserves I1 (epoch monotonicity), I2 (server-clock provenance: every non-empty `claimed_at` is in the adversary-handed set), and I3 (stamp idempotency within an epoch). I4 from the invariant list is structurally subsumed by I3 on the in-test observation cadence (one read per attempt); the dedicated I4 surface remains pinned by the bounded-skew `two-phase: (epoch, claimed_at) tuples are distinct and only carry server-clock values` property in the same file.

## What is NOT defended

The two-phase fence-claim is a **safety** mechanism over the
shared `current.json` control object; it is not a substitute for
authentication, integrity, or transport security. In particular:

- **A compromised storage server can forge any value** — including
  `serverDate`. The patent claim is "the clock used is the
  server's, not the client's," not "the server's clock is
  trustworthy." Defending against a compromised storage server
  requires signed responses, cryptographic timestamps, or a
  separate notary — none of which are in scope.
- **A compromised proxy in front of the storage server** can
  rewrite the `Date` header. Same envelope as the previous bullet.
- **A correlated clock attack on every peer simultaneously** —
  e.g. an adversary that controls every client's NTP source and
  coerces all local clocks to identical wrong values — is not
  directly threatening, since the protocol ignores local clocks
  for `claimed_at`. It can degrade other parts of the kernel
  (lag-window checks in `sync-protocol.md`), but not the fence
  claim.
- **Replay attacks against the storage server** — e.g. replaying
  an old `current.json` write that the storage server has
  forgotten — require a versioned bucket or write-once semantics.
  The kernel uses versioned-bucket mode where available; the
  fence claim assumes the storage server retains its current
  object honestly.

These are the same exclusions the broader kernel makes; this
document re-states them so the fence claim's envelope is not
misread as broader than it is.

## Why two-phase is non-obvious

A naive implementer composing the WriterFence shape from its
documented fields — `epoch: number`, `owner: string`, `claimed_at:
string` — and the documented `Storage` interface — `put(key,
body, { ifMatch }) → Promise<{ etag }>` — arrives at the
**single-PUT** variant: read the record, build the new fence with
`claimed_at = new Date().toISOString()`, write it back with
`If-Match`. This is the "obvious composition of known elements"
rejected by the §103 (non-obviousness) framework — and is the
variant implemented by the `claimWriterSinglePut` helper in the
patent C1 counter-example test.

The single-PUT variant fails the soundness invariant **I3
(server-clock provenance)** under bounded clock skew: every
client's local clock is, by hypothesis, off by up to
`LAG_WINDOW_MILLIS` from the server's, so the recorded
`claimed_at` is not anchored to any clock the other peers share.
Two peers can mint **identical** `claimed_at` strings while
the storage server's actual clock disagrees with both. The
two-phase variant breaks this by writing the record **before** it
knows what `claimed_at` will be, then overwriting itself once the
server's clock is observable on the first PUT's response.

The non-obviousness lives in the realization that a clock value
the protocol needs to record can only be observed **as a side
effect** of a CAS PUT that has already committed. The patent
claim is for the specific computer-implemented step:

> extract `claimed_at` from the HTTP `Date` response header on a
> conditional PUT that has already committed the epoch bump, then
> write the extracted value back through a second conditional PUT
> whose precondition is the etag of the first PUT.

## Prior-art differentiation

Three well-known systems implement a related primitive ("commit
+ bump a generation counter under CAS"). None implement the
two-phase server-clock extraction:

| System | Mechanism | What differs from C1 |
|---|---|---|
| **Google Spanner TrueTime** | Dedicated GPS + atomic-clock hardware in every datacenter; commit timestamps drawn from `TT.now()` after a "commit wait" interval bounds the uncertainty. | Requires dedicated hardware (Spanner cannot run on commodity object storage). The fence-claim mechanism runs over any S3-compatible storage with **zero** dedicated infrastructure. Spanner's clock is a *bounded local* clock; C1's clock is *the storage server's response*, not the writer's. |
| **AWS DynamoDB conditional writes** | Server-side conditional update with a CAS expression. The server computes the result and stamps a server-side timestamp on the record. | The timestamp lives on the *server side* of a vendor-proprietary API. C1 runs over a generic S3 PUT and *extracts* the timestamp from a standard HTTP response header — it does not require server-side computation, server-side conditional logic beyond `If-Match`, or vendor-proprietary API surface. |
| **FoundationDB `recoveryCount`** | A monotonically-increasing recovery generation tracked on the cluster state, stamped at recovery time by an in-process coordinator. | FoundationDB's `recoveryCount` is bumped by a process that *has* a coordinator; C1 has no coordinator. The closest analog in C1 is the *epoch* field alone — but C1 additionally extracts the server's commit-time clock and writes it back through a second conditional PUT, an operation FoundationDB does not perform. |
| **IsleDB `writer_fence`** (the project this kernel borrowed the *name* from) | A monotonically-bumped writer-fence epoch on `manifest/CURRENT`, stamped at claim time from the writer's local clock. | IsleDB uses the **local** clock for the claim timestamp — the single-PUT variant. The two-phase server-clock extraction is C1's contribution. |

None of these prior-art systems extract the storage server's HTTP
`Date` response header as the *trusted* clock for a claim
timestamp, and none of them write that extracted value back
through a second conditional PUT to durably stamp it. The
two-phase pattern is C1's specific computer-implemented step.

See also: `prior-art.md` for the IDS-shaped consolidated
differentiation.

### Differentiation from mps3 (Date header used for clock correction)

mps3 (`github.com/endpointservices/mps3`, MIT, ©2023 Endpoint Services,
public since 2023-08-20) is third-party OSS authored by Tom Larkworthy
and Taktile's automated build account; `baerly-storage` is a fork of
the public mps3 repository with no prior arrangement with the upstream
author. mps3 uses the HTTP `Date` header returned by S3 as a
*client-side clock-correction input* — clients accumulate observed
`Date` values to estimate the trusted wall-clock for their own use, but
the `Date` value is never written back into a durable storage object as
a provenance field. mps3's two-step write (content + manifest + `touch
last_change`) embeds a *client-minted* timestamp in the manifest
filename; the server clock is never committed.

The mechanism in `claimWriter`
(`packages/protocol/src/coordination/current-json.ts`, lines 296–399)
differs by **atomically capturing the storage server's `Date` response
header as a durable provenance field** on the fence record itself,
established via an etag-guarded second CAS that any concurrent peer
loses. The two-PUT protocol forces the timestamp written to be one the
server attested to in a previous response, not one the writer client
made up. This is the load-bearing inventive step distinguishing C1 from
the mps3 prior-art baseline and from the broader S3-leader-election
literature (Morling 2024; AWS conditional-writes launch 2024-11) which
uniformly embed client-supplied timestamps.
