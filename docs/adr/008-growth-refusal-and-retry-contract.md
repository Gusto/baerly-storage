---
title: Growth refusal and retry contract
audience: adr
doc_type: adr
summary: ADR 008 — write-capacity refusals are stateless and preserve foldability; retriability is a pure function of the error code; `CapacityExceeded` is 409 and `MaintenancePending` is 503 + `Retry-After`; each failure kind retries at exactly one layer; the SDK mints `_id` before the first attempt.
last-reviewed: 2026-11-16
tags: [decision, adr, errors, retry, capacity, maintenance]
related:
  [
    README.md,
    002-ephemeral-coordination.md,
    "../spec/sync-protocol.md",
    "../about/graduation.md",
  ]
---

# 008 — Growth refusal and retry contract

## Status

Accepted (2026-11-16). Implemented.

## Decision

Near the serving host's fold ceiling, the kernel refuses growth: an insert or
an update whose row gets larger. Deletes and same-size or shrinking updates
remain admitted unless they would make the pending tail permanently
unfoldable. A write of any kind is refused if it would complete a full fold
pass of consecutive entries whose projected snapshots all exceed the byte
ceiling. A delete or shrink that brings the projection back within the ceiling
can still commit. If the stored snapshot already exceeds the host's fold
ceiling, or the pending tail contains a barrier no fold pass can cross, every
write is refused until the collection moves to a larger host or is exported.
These write refusals do not disable reads; reads retain their own request
bounds.

The refusal is `CapacityExceeded` (HTTP 409, not retriable), or
`MaintenancePending` (HTTP 503 with `Retry-After`, retriable) when folding the
pending tail would free the room for growth. A `MaintenancePending`
refusal dispatches that fold itself. The decision is recomputed on every
request from the head and tail the request already read, and it is never
stored. `BaerlyError.retriable` is membership of the code in `RETRIABLE_CODES`,
with no per-instance override. Each failure kind has one retrying layer. The
storage adapter retries transient storage failures. The HTTP client retries
`MaintenancePending` on every verb, and an envelope-less 5xx, 408 or 429 only
on `GET` and on inserts whose `_id` it minted. The writer, the in-process `Db`
and the server never resend.

Mechanics live in [sync-protocol.md
§Capacity](../spec/sync-protocol.md#capacity-the-commit-time-re-check), [the
one-layer retry rule](../spec/sync-protocol.md#unresolved-create-fate), [§Insert
(SDK-minted replay)](../spec/sync-protocol.md#insert-the-first-i-wins), and the
per-code JSDoc in `packages/protocol/src/errors.ts`. Host moves and export are
in [graduation.md](../about/graduation.md#the-symptom-writes-are-refused-not-data-loss).

## Because

- **Refusals are stateless and preserve foldability.** Nothing about a refusal
  is persisted, so a request is admitted once maintenance or a repairing write
  makes room for it, and there is no state for an operator to clear. This
  matches DynamoDB's item-collection limit, ZFS slop space and Postgres
  anti-wraparound: refuse what makes things worse, early, and keep the repair
  path open. One state is not self-clearing: a collection already past what
  this host can fold at all (for example, one grown on a larger host) refuses
  every write until it moves to a larger host or is exported.
- **Repair stays possible while the tail is still repairable.** A delete or
  shrink that ends an over-ceiling run stays admitted; a non-growing write
  that would make the run uncrossable is refused with `CapacityExceeded`.
  The distinction is covered by the
  [fold-pass refusal tests](../../packages/server/src/capacity.test.ts).
  A refused growth write that a fold would unblock dispatches that fold, and
  near the refusal point the write tick skips its usual trigger, still inside
  the per-pass budget. SlateDB requires the compaction trigger to sit below
  the write stall for the same reason: otherwise the two deadlock.
- **Retriability is fixed per code.** A handler, human or LLM-written, can
  branch on `code` or `retriable` and never needs instance details. Google's
  `code.proto` and AIP-194 define retry semantics per code and split a code
  when two retry meanings collide. The same split here separates
  `WriteConflict` (retriable) from `AlreadyExists` (not).
- **`CapacityExceeded` is 409, not 507 or 503.** RFC 9110 and RFC 4918 define
  503 and 507 as temporary, and AWS and Azure SDKs and Envoy auto-retry them,
  so a refusal that cannot succeed unchanged must use a status generic tooling
  leaves alone. `MaintenancePending` uses 503 because there an automatic retry
  after `Retry-After` is the right behaviour.
- **One layer retries each failure kind.** Stacked retries multiply: three
  attempts at five layers is 243 calls (AWS Builders' Library). On request-
  budgeted hosts, each extra attempt also spends the invocation's storage-call
  budget.
- **The SDK mints `_id` before the first attempt.** A resend of an auto-ID
  insert carries the same `_id` and `mintedId` and replays as `201 { _id }`,
  so retrying cannot add a row. MongoDB drivers and the Firestore SDK mint ids
  client-side, and Stripe's idempotency keys follow the same rule. A
  caller-chosen `_id` stays strict `AlreadyExists`, which protects run-once
  guards.

## Closed paths

- **A permanent 507 read-only state.** Marking a collection full forever,
  with deletes unable to clear it, turns a transient backlog into an outage
  and invites generic tooling to retry a request that cannot succeed.
- **An operator-cleared alarm** (etcd `NOSPACE`). A persisted flag needs
  someone to notice and disarm it, which breaks "Just a Bucket" (zero operator
  infrastructure) and outlives the condition that set it.

## Consequences

- Answers that succeed are identical on every host. A smaller host may refuse
  an operation a larger one serves, and its errors name the app-side remedy,
  never a host setting.
- A batch refused part-way keeps the rows it already committed. There is no
  progress field: the caller re-reads and resumes.
- No end-to-end exactly-once is promised. A caller-`_id` insert, an update or
  a delete that hits a transport failure surfaces it instead of resending, and
  `AmbiguousCommit` stays 409 so nothing auto-retries it.
- Adding a code means choosing its retriability and status once, in
  `errors.ts` and `ERROR_TO_STATUS` (`packages/server/src/http/router.ts`).
