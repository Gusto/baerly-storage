# 0015 — Cost ceiling is a published bound

## Status

Accepted.

## Context

"Database costs are unpredictable" is the single most common reason
a non-engineer abandons a hosted DB. Baerly's positioning is "your
data in your bucket," which is hollow if the storage operations
required to make the protocol work blow past a free tier on a
hello-world workload or accumulate cost super-linearly as the app
scales.

Two failure modes shape the bound:

- **The idle case.** A deployed app with one daily writer and a
  handful of pollers should be free on Cloudflare R2 and effectively
  free on AWS S3. An idle reader that costs one Class A op per poll
  destroys that economics inside a day.
- **The small-workload case.** A ~100-MAU helpdesk app should cost
  dollars per month, not tens of dollars. The per-write op count
  must be a bounded small constant rather than something that grows
  with table size, snapshot depth, or history.

Without an architecturally enforced ceiling the protocol drifts: a
new feature adds a poll here, a LIST there, and the cost line creeps
upward with no single regression to point at.

## Decision

Baerly commits to a published cost ceiling, enforced architecturally
and verified by an end-to-end gate:

- **3 storage ops per logical write.** PUT content, PUT log entry,
  CAS-advance `current.json`. Snapshot writes amortize across many
  log entries and are paid by the compactor rather than the writer.
- **`< 1 Class A op / writer / hour` for idle readers.** Real
  expectation is exactly zero — the reader walks `current.json` plus
  the snapshot plus the live-tail log entries via deterministic
  GETs, never LIST.

The header JSDoc at
[`tests/integration/phase5-end-to-end.test.ts:16-20`](../../tests/integration/phase5-end-to-end.test.ts)
recites the bound. The assertion at
[`tests/integration/phase5-end-to-end.test.ts:240-322`](../../tests/integration/phase5-end-to-end.test.ts)
wraps `Storage` with a counting proxy that increments `classAOps` on
every PUT, DELETE, or LIST, polls for an hour at 2-second cadence
(1800 reads), and gates on `expect(classAOps).toBeLessThan(1)`. Tier
profiles at
[`packages/server/src/maintenance.ts:106-144`](../../packages/server/src/maintenance.ts)
(`CLOUDFLARE_FREE_TIER`, `CLOUDFLARE_PAID_TIER`, `NODE_PROFILE`)
carry the budget arithmetic, and
`packages/server/src/maintenance.budget.test.ts` proves a single
maintenance pass under the Cloudflare free-tier profile sits under
the 50-subrequest cap.

## Consequences

- Every architectural decision is checked against the envelope. The
  cost ceiling is a gate, not a target — a change that regresses it
  fails CI rather than getting a warning.
- Hot-path write cost is bounded at three storage ops per logical
  write; snapshot maintenance is paid by the compactor and amortized
  across many log entries ([ADR-0017](./0017-snapshot-levels.md)).
- Idle-poll cost is bounded at less than one Class A op per writer
  per hour. The reader uses deterministic GET paths only, never LIST.
- Realtime notifications are opt-in, not default. The envelope holds
  for apps that do not pay for change-stream infrastructure.
- D1 is materially cheaper than Baerly at M-size workloads. Baerly
  does not try to beat D1 on cost; graduation to Postgres
  ([ADR-0013](./0013-export-contract.md)) is the answer for projects
  that cross the M-size threshold.
- The per-collection CAS scope ([ADR-0011](./0011-cas-scope.md)) is
  what makes the idle-poll bound tractable: one cheap key per
  collection rather than contention on a global mutex. Auth presets
  ([ADR-0014](./0014-auth-verifier-interface.md)) must avoid per-
  request key-rotation patterns that would multiply Class B reads
  against this envelope.
