# 0022 — Observability tag naming

## Status

Accepted (2026-05-11).

## Context

Phase 5 wired six load-bearing metrics through the protocol and server
packages
([`packages/protocol/src/metrics.ts:13-22`](../../packages/protocol/src/metrics.ts)):

- `db.write.class_a_ops_per_logical_write` — histogram, alert at
  p99 > 5.
- `db.r2.put.412_total` — counter; CAS conflict /
  If-Match-or-None-Match loss.
- `db.r2.put.429_total` — counter; R2 prefix-partition rate-limit.
- `db.manifest.lag_window_depth` — gauge, alert at > 100.
- `db.gc.entries_swept_per_second` — gauge, livelock indicator when
  below writes-per-second.
- `db.orphan.candidate_count` — gauge, `gc/pending.json` depth.

Additional named metrics emitted by the kernel — `db.compact.entries_folded`
([`packages/server/src/compactor.ts`](../../packages/server/src/compactor.ts)),
`db.gc.swept_total` (labelled by reason,
[`packages/server/src/gc.ts`](../../packages/server/src/gc.ts)), and
`db.tenant.put_rate` (per-tenant labelled,
[`packages/server/src/server-writer.ts`](../../packages/server/src/server-writer.ts))
— follow the same convention.

The recorder shape is three methods (counter / gauge / histogram)
accepting `(name, value, labels)` where labels are optional and default
to `{}`. The default `noopMetricsRecorder` swallows every emission;
callers thread `metrics?: MetricsRecorder` and default to the noop.
See
[`packages/protocol/src/metrics.ts:44-62`](../../packages/protocol/src/metrics.ts).

Three naming-convention options were considered:

- **Camel-case namespacing** (e.g. `dbWrite.classAOpsPerLogicalWrite`).
  Does not survive every aggregation backend (statsd, Prometheus,
  OpenTelemetry, Workers Analytics Engine); the dot is the
  widely-supported namespace separator.
- **`db.<subsystem>.<metric>` lowercase snake-case segments.**
  Survives every backend. Three segments are enough; deeper trees
  (`db.write.commit.412.total`) reduce aggregation ergonomics with no
  offsetting benefit.
- **Backend-specific naming.** Rejected — the recorder abstraction
  exists precisely so the kernel does not have to know its sink.

## Decision

Metric names follow `db.<subsystem>.<metric>`: three dot-separated
segments, lowercase, snake-case within each segment when the metric
name has multiple words. Labels are flat
`Readonly<Record<string, string>>` — no numbers as label values, no
nested objects — so any aggregation backend can consume them.

The kernel does not emit to any specific backend. Operators implement
`MetricsRecorder` (counter / gauge / histogram) and pass it to
`ServerWriter`, `compact`, `runGc`, and the scheduled handler. The
default is `noopMetricsRecorder`. The multi-runtime adapter pattern
([ADR-0006](./0006-server-component.md)) is what motivates the
recorder abstraction: different runtimes use different backends, and
the kernel must not pick one.

Allowed label keys are open-ended but conventionally include:

- `collection` — the table name.
- `tenant` — the tenant id (only on `db.tenant.put_rate`; this label
  is valuable precisely because of the tenant-prefix isolation in
  [ADR-0018](./0018-tenant-cas-isolation.md)).
- `reason` — the orphan category (`stale-log`, `orphan-snapshot`,
  `orphan-content` on `db.gc.swept_total`; see
  [ADR-0020](./0020-gc-lag-window.md) for the categories).

Prohibited:

- Numeric label values. Prometheus and OpenTelemetry both treat
  numeric labels as anti-patterns: they explode cardinality and
  produce unaggregatable series.
- Nested objects as label values. The type signature literally forbids
  this (`Record<string, string>`), but reviewers should reject any
  caller that string-encodes a JSON object into a label.
- New top-level prefixes other than `db.`. The kernel's metrics live
  under one root; adapters or operators emitting their own metrics
  use their own roots.

The three-segment dot-separated lowercase convention is the
lowest-common-denominator format every aggregation backend in the
project's target list consumes without translation. Flat string labels
avoid the cardinality-explosion and aggregation hazards that numeric
or nested labels cause. The recorder abstraction keeps the kernel
backend-agnostic so per-operator wiring is a one-file shim, not a
kernel change.

## Consequences

- A new metric MUST pick a `<subsystem>` from the existing set
  (`write`, `r2`, `manifest`, `gc`, `orphan`, `compact`, `tenant`) or
  add a new one in this ADR's spirit. Adding a new subsystem segment
  is forward-compatible.
- The `noopMetricsRecorder` default means an uninstrumented call site
  sees zero behavioural change. Operator-supplied recorders that throw
  are an operator bug; the kernel does not try/catch around emissions.
- The `InMemoryMetricsRecorder` test helper at
  [`packages/protocol/src/metrics.ts:64-122`](../../packages/protocol/src/metrics.ts)
  is the test-time recorder. Production code MUST NOT use it because
  memory grows unbounded.
- Test assertions match exact metric names; renaming a metric is
  therefore a multi-file change (the test file plus the emit site).
  This is intentional friction: a name is a contract, and contracts
  should not be renamed silently.
- The six load-bearing metrics each have one or more alert thresholds
  documented in
  [`packages/protocol/src/metrics.ts:13-22`](../../packages/protocol/src/metrics.ts).
  Operators who wire alerting consume those thresholds; the kernel
  does not emit alerts.
- Adapter packages (`@baerly/adapter-cloudflare`, `@baerly/adapter-node`)
  MAY emit additional metrics under the `db.<subsystem>.` convention
  but MUST NOT redefine an existing metric's semantics.
- Labels are case-sensitive. They are conventionally lowercase;
  reviewers reject mixed case to avoid `tenant=ACME` vs `tenant=acme`
  cardinality splits at the aggregator.
- The orphan-related metrics
  (`db.orphan.candidate_count`, `db.gc.entries_swept_per_second`,
  `db.gc.swept_total`) are the observability surface for the seven-day
  grace window in [ADR-0020](./0020-gc-lag-window.md). Sustained
  growth in `db.orphan.candidate_count` predicts a sweep-side
  livelock several days before reclamation lags.
