---
title: Product thesis
audience: product
summary: What Baerly is, who it's for, and what it deliberately is not.
last-reviewed: 2026-05-12
tags: [positioning, product]
related: [cost-model.md, "../contributing/conventions/change-discipline.md"]
---

# Baerly — product thesis

What Baerly is, who it's for, and what it deliberately is not. The
positioning is stable; the implementation detail lives in the rest
of `docs/`.

## What Baerly is

A small TypeScript SDK that turns **one S3-compatible bucket plus a
tiny portable HTTP server** into a low/no-ops document database for
non-engineers and Claude pair-programmed prototypes inside a
multi-thousand-employee company.

The audience is people who can access object storage (every cloud
has it) but not D1 / managed Postgres (gated by IT). The deliverable
is the lowest-friction path from "I have an idea for an internal
CRUD tool" to "deployed and persisting" — measured in minutes,
not days.

Day-1 templates ship for **Cloudflare Workers** (most-polished UX —
zero infra, free tier, one command to deploy) and **self-hosted
Node** (zero vendor lock-in — your hardware, your S3-compatible
bucket, your auth IdP). Both are first-class. AWS Lambda / Bun /
Deno / Fly are a paper-thin adapter package away. The protocol
kernel runs identically on every runtime; the platform glue lives
in `@baerly/adapter-*` packages. See
[architecture.md](../contributing/architecture.md) for the runtime split.

## Who this is for, in one sentence

A non-engineer at a 10,000-person company opens Cursor, asks Claude
"build me an internal tool to track laptop requests", and 30 minutes
later has a deployed React app that persists to their team's
S3-compatible bucket — Cloudflare R2 by default for the polished
day-1 path, or AWS S3 / GCS / self-hosted Minio if their org has
already standardized elsewhere. They never log into a cloud
dashboard. They never write SQL. They never reason about the
protocol.

## Positioning

- **The pitch:** schemaless documents you can iterate on without
  DDL; a real protocol that survives trusted multi-instance
  contention; *your data is already in your bucket and your code is
  a portable HTTP server, so graduating to D1 / Postgres / a
  different host needs no vendor cooperation.* See
  [cost-model.md](cost-model.md) for the per-line-item rates and
  the M-size operating-point comparison.

- **The pitch is NOT cost.** D1 is ~$5/mo at the M-size workload vs
  Baerly's ~$19. Baerly is cheaper for hello-world (free tier) and
  on par or more-expensive past M-size. That's fine — cost is not
  the moat.
- **The pitch is NOT realtime.** The HTTP `/v1/since?cursor=<lsn>`
  long-poll is the default change-notification channel. A
  WebSocket realtime tier is opt-in with a documented cost-cliff
  note.
- **The pitch is NOT a D1 replacement.** D1 is the graduation
  target. Baerly's job is to keep the experiment cheap and fast
  until the user knows whether it's worth graduating. The log entry
  shape is frozen and stable across all future versions; `baerly
  export --target=postgres` is a mechanical translator, not a
  marketing line. Graduation is a tool we ship, not a feature we
  promise.

## Public API shape

`db.table<T>(name).where(p).order(o).limit(n).all()` — SQL-shape,
predicate-AST-driven, additive-only locked
([ADR-0019](../adr/002-api-surface-lock.md)). Baerly still borrows
specific patterns from Firestore (composable query constraints,
gRPC-derived error codes, JSDoc `@example` density, field-value
sentinels).

Seven verbs, five modifiers, one transaction. Stable error codes
(`BaerlyError.code`) with stable messages; JSDoc `@example` blocks
that are tested. The surface is small enough that an LLM can use it
zero-shot from the `.d.ts` alone. Underneath, the protocol is a real
distributed system: descending base32-time keys, RFC 7386 merge
patch, fence tokens, randomized property tests against multi-Worker
fault injection. The user never sees any of it. Simple is a feature;
the work to keep it simple is the product.

## Constraints we accept

- App is small. Up to ~10 GB / tenant; ~30 logical writes/min /
  collection; ~100 collections / tenant. Above that: graduate. The
  ceiling reflects the CAS-livelock regime documented in the
  S3-as-database literature at sustained ~5 writes/sec/object.
- One bucket per app. Tenants are prefix-scoped within.
- Strongly consistent point GETs and conditional writes (R2/S3).
  Eventually-consistent LIST is avoided on the hot path.
- Server-only writes. The browser is a typed HTTP client.

## Anti-goals

- **No SQL, no joins, no LSM.** The query API ships operators one
  at a time, gated on a passing SQL translator test. Equality +
  dotted-path nesting on day one. Honest about the limit; Claude
  respects documented constraints.
- **Browser-direct multi-writer is OUT.** Trusted multi-instance is
  the design center; browser-direct is a different protocol problem
  and the audience does not need it. (Baerly, the predecessor
  project, was browser-direct multiplayer; Baerly is not.)
- **Realtime is opt-in, not the default.** Polling is always
  correct, even when realtime is on.
- **Not a database for tenants whose write rate exceeds 30
  writes/min/collection sustained, or whose fan-out exceeds 100
  collections per tenant.** Above that, graduate to D1 / Postgres.
  This ceiling is platform-independent — the kernel makes the same
  guarantees on CF, Node, Lambda.
- **No automatic schema migration.** Migrations are versioned
  scripts.
- **No multi-bucket replication / fan-out / mirroring.** R2's own
  replication tier handles read fan-out.
- **No on-disk caches.** Object storage + the platform's HTTP cache
  (CF Cache API on the CF target, none on Node by default) + small
  in-memory caches only.
