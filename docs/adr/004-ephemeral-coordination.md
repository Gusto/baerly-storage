---
title: Ephemeral coordination
audience: adr
summary: ADR 004 — coordination runs in request-bounded compute, not in a persistent process.
last-reviewed: 2026-05-28
tags: [decision, adr, runtime-model]
related: [README.md, "../about/thesis.md", "../spec/sync-protocol.md", 001-tenant-cas-isolation.md, 002-api-surface-lock.md]
---

# 004 — Ephemeral coordination

## Status

Accepted (2026-05-26).

## Context

Most multi-writer databases ship a persistent coordinator. Apache
Iceberg requires a catalog service. Delta Lake on S3 requires a
DynamoDB lock table. Apache Hudi requires HMS or an equivalent
metastore. SlateDB ships a long-lived writer and a long-lived
compactor. turbopuffer runs a query+indexer fleet. Convex,
PlanetScale, Turso, and Neon each ship at minimum a Pageserver
or equivalent always-on process. The default assumption in the
multi-writer-on-object-storage design space is that coordination
needs a daemon.

Baerly does not. The kernel is sized to fit inside a single
Cloudflare Worker invocation (50-subrequest budget,
~30-second wall-clock) or a single Lambda invocation, with no
process kept alive between requests. The deploy posture follows:
the only persistent component is the bucket. Idle apps cost zero
runtime; cold starts read correctly the same as warm ones.

[ADR-001](001-tenant-cas-isolation.md) already records the
downstream consequence: "A true server-vended lease with peer
revocation would require a coordination service or sticky
routing; the portable `(Request) => Response` server contract
rules both out." This ADR makes the upstream principle
load-bearing: the portable handler contract isn't an
implementation accident; it's the property the rest of the
system is shaped around.

## Decision

Coordinate exclusively via the conditional-write primitives that
S3, R2, GCS, and Azure Blob all expose (`If-Match` /
`If-None-Match` against an ETag). Three mechanisms make this
sufficient:

1. **Two-phase fence with server timestamp.** Writers observe a
   server-attested clock before committing; lying client clocks
   cannot manufacture causal ordering. The `writer_fence` lives
   in `current.json`
   ([`packages/protocol/src/coordination/current-json.ts`](../../packages/protocol/src/coordination/current-json.ts));
   `claimed_at` carries `StoragePutResult.serverDate`, never a
   local clock. See [ADR-001](001-tenant-cas-isolation.md) and
   the bounded-clock-skew assumption (`LAG_WINDOW_MILLIS = 5000`)
   in [`docs/spec/sync-protocol.md`](../spec/sync-protocol.md).
2. **Manifest-LAST commit with self-session adoption on 412.**
   The CAS on `current.json` is the single linearization point.
   Sessions that lose the race adopt the winner's manifest
   without rolling back their own log entries; the adoption
   decision is gated on a per-commit random session id that no
   adversary with bucket-write access can forge (see
   [`packages/server/src/log-conflict-adoption.ts`](../../packages/server/src/log-conflict-adoption.ts)
   and `tryAdoptOwnSessionLogEntry`).
3. **Bounded-budget cron maintenance.** Compaction and GC each
   run as one pass inside a single cron tick, sized to fit
   inside the platform's subrequest budget. The
   `CLOUDFLARE_FREE_TIER` profile in
   [`packages/server/src/maintenance.ts`](../../packages/server/src/maintenance.ts)
   carries the bounded-tick arithmetic; larger backlogs are
   paced across ticks, not spilled into a long-lived process.

## Consequences

**Positive.** No on-call surface — there is no process for an
operator to babysit. Idle apps cost zero runtime; only the
bucket's storage line item accrues. The kernel is portable
across any FaaS runtime that ships a fetch-shaped handler and a
cron trigger (Workers, Lambda, Bun, Deno, Fly). Cold starts read
correctly the same as warm ones, so isolate recycling and
scale-to-zero are free. The thesis's "Idle → zero" criterion
falls out of this property; the small public API
([ADR-002](002-api-surface-lock.md)) is possible because there
is no coordinator state to expose. Graduation is mechanical: with no stateful coordinator to migrate away from, the bucket plus the log shape are the entire handoff to Postgres (`baerly export --target=postgres`).

**Negative.** No continuous compaction — maintenance cadence is
bounded below by the cron schedule, so under sustained heavy
write load, log-tail growth is paced rather than continuous.
Readers may see a stale `current.json` until the in-isolate
cache invalidates; the `consistency: "strong"` opt-in trades a
round-trip for freshness when needed. WebSocket connections
cannot be held beyond a single bounded invocation, so realtime
is delivered via the `/v1/since?cursor=<lsn>` long-poll route
inside the platform's request-time budget rather than a held
fanout socket.

## What would break the property

Any future feature that requires (a) holding a connection open
beyond a single bounded invocation, (b) persisting writer state
across commits in process memory, or (c) relying on
between-request memoization for correctness. Each of these is
grounds to reject the feature or to redesign it so the kernel
stays inside the request boundary. A "watch this collection"
API that holds a socket across requests breaks (a). A
write-batching coordinator that buffers across commits breaks
(b). A read-cache that returns stale rows past the
`current.json` ETag without re-validating breaks (c).

Features that compose with the property are still admissible:
platform-provided HTTP cache (CF Cache API), in-isolate caches
that re-validate against an ETag, and cron-paced maintenance
all preserve the property. The test is whether *removing the
in-memory state* breaks correctness. If it does, the feature
violates this ADR.
