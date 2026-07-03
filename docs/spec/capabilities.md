---
title: Storage capabilities — required vs optional
audience: spec
doc_type: current-contract
summary: What a backend MUST support to certify as full Storage (CAS, exactly-one-winner), what is optional, and the planned read-only ReaderStorage tier.
last-reviewed: 2026-06-27
tags: [storage, conformance, capabilities, cas, contract]
related: ["sync-protocol.md", "storage-compatibility.md"]
---

# Storage capabilities — required vs optional

Certification splits capabilities into two groups. The executable
enforcement is `defineStorageConformanceSuite`
(`packages/protocol/src/storage/conformance.ts`); the deploy-time live
probe is `probeCas` (`packages/protocol/src/storage/probe-cas.ts`,
surfaced by `baerly doctor --bucket`).

## Required — production `Storage` certification

A production backend certified as full `Storage` MUST support:

- `get`, `put`, `delete`, `list` per the `Storage` interface
  (`packages/protocol/src/storage/types.ts`).
- `ifMatch` compare-and-swap on `put`.
- `ifNoneMatch: "*"` create-only on `put`.
- `ifNoneMatch` conditional `get` (304-equivalent → `null`).
- **Exactly-one-winner** under concurrent create-if-absent — the
  log-append commit relies on it.
- UTF-8 byte-ordered `list` with `startAfter` + `maxKeys` pagination.
- Correct storage error-code mapping (stale `ifMatch` / existing
  `ifNoneMatch:"*"` / concurrent-create loser → `Conflict` or
  retryable `NetworkError`).

There is **no `supportsCAS` opt-out**. The conformance suite enforces
this (see the comment in `conformance.ts`): a backend that can't pass
the CAS blocks must not ship as `Storage`. A required-capability
failure fails certification — full stop.

The in-tree dev adapters run the same suite under their documented
topology. `LocalFsStorage` is a local/single-process development
adapter: its `ifMatch` behavior is in-process TOCTOU only, so a green
dev conformance run does **not** certify it for multi-process production
use. Production certification means the required capabilities hold
across the backend's real concurrency boundary (processes, isolates, or
regions as applicable).

## Optional

- `supportsAbort` — `AbortSignal` mid-flight cancellation (the one
  capability flag the suite exposes today).
- HTTP long-poll timeout override on `/v1/since`.
- Cache API behavior.
- Adapter convenience features.
- Versioned-object reads where the backend doesn't expose them.

Until the suite grows structured waiver metadata, any **new** optional
skip MUST carry an **owner and an expiry** in the call-site comment next
to the opt-out. A bare boolean opt-out with no owner/expiry trail is a
review defect.

## Planned: `ReaderStorage` (read-only tier)

A read-only implementation (e.g. an analytics-only Python client) need
not implement conditional writes. The planned `ReaderStorage` interface
exposes only `get` + `list` and certifies against a read-only subset of
the conformance suite. **Not yet implemented** — there is one monolithic
`Storage` today. When introduced, write certification stays gated on the
full CAS/race blocks above; `ReaderStorage` certification covers reads
only. This tier is the home for the roadmap's read-only Python
milestones (Tier E, M1–M3).
