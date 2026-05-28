---
title: Conventions for observability code
audience: coder
summary: One canonical line per unit-of-work, field attachment, DEBUG vs INFO, test patterns.
last-reviewed: 2026-05-17
tags: [conventions, observability]
related: ["../../guide/observability.md", "tests.md"]
---

# Observability conventions

Rules for code that emits observability. The operator-facing
counterpart is [`docs/observability.md`](../../guide/observability.md).

## The one rule

**Every HTTP request emits one canonical line.** The kernel emits it
on the request boundary; you don't.

Maintenance ticks (compactor, GC, `rebuildIndex`, `runScheduledMaintenance`)
emit NO canonical line — there's no human reading cron-tick logs on a
15-user app, and errors throw to the platform (Cloudflare dashboard,
Node process logs). Their per-emission metrics still flow into the
canonical line when called from within an HTTP scope (e.g. an admin
route that triggers `rebuildIndex`); outside any HTTP scope each emit
site falls through to `noopMetricsRecorder` — operators don't wire
their own `MetricsRecorder`, the canonical line on stdout is the
operator's view of kernel emissions.

Direct `Db` calls outside an HTTP request — e.g. a `baerlyDev()` seed
callback that calls `db.collection().insert()` from inside the Vite
plugin — don't emit a canonical line on their own. The unit boundary
lives on the wrapping HTTP request, not on the `Db` method.
Field-setters like `getCurrentContext()?.fields.set(...)` are no-ops
in that mode, and metrics that attach to the canonical line (e.g.
`db.write.class_a_ops_per_logical_write`) won't surface — so don't
use server-side `Db` calls as a verification or calibration proxy
for HTTP-path behaviour; drive a real `/v1/*` request instead.

Don't log-and-rethrow:

```ts
// ❌ Wrong — the canonical-line flusher already serializes the error.
try {
  await work();
} catch (err) {
  console.error("work failed", err);
  throw err;
}
```

If you want extra detail on a code path, use `debug`:

```ts
import { CATEGORY, getLogger } from "../observability";

getLogger(CATEGORY.storage).debug("step", { collection, attempt });
```

DEBUG is below the `info` threshold in production; the formatting
cost is paid only when `LOG_LEVEL=debug`.

## Attaching a field to the in-flight canonical line

```ts
import { getCurrentContext } from "../observability";

getCurrentContext()?.fields.set("collection", collection);
getCurrentContext()?.fields.set("table_row_count", rows.length);
```

Field values must be JSON-stringifiable: strings, numbers, booleans,
plain objects, arrays. Don't put functions, `undefined`, or BigInts
in. `null` is fine.

`fields` keys override `recorder.summarize()` keys but lose to
`opts.extra` at flush time (`extra` is the caller's final say).

The context is `undefined` when no `runWithContext` scope is active
— optional-chain the access. Library code must work in both modes.

## Background entry points

There is no `withObservability` wrapper for background work — only
HTTP requests get a canonical line, and they are wrapped by the
adapter. Background entry points (admin commands, batch jobs,
maintenance ticks) call the kernel primitives directly:

```ts
import { rebuildIndex } from "@gusto/baerly-storage/maintenance";

await rebuildIndex(storage, currentJsonKey, def);
```

Errors propagate to the platform's process / Worker log. Metric
emissions fall through to `noopMetricsRecorder` outside any
`runWithContext` scope.

If you need per-emission visibility during local testing, construct
an `ObservabilityContext` and wrap the work in `runWithContext`:

```ts
import { createObservabilityContext, runWithContext } from "../observability";

const ctx = createObservabilityContext();
await runWithContext(ctx, async () => {
  await rebuildIndex(storage, currentJsonKey, def);
});
console.log(ctx.recorder.snapshot());
```

## When to use DEBUG

DEBUG is for stuff that's:

- Per-storage-op (one event per `get` / `put` / `delete` / `list`).
- Per-predicate-evaluation step.
- Anything hot you want occasional visibility on without paying for
  it in production.

Toggle on per-deployment via `LOG_LEVEL=debug`. Tests opt in by
passing `{ level: "debug" }` to `configureObservability`.

## Sampling philosophy

Every unit-of-work emits one canonical line unconditionally; errors
are not special-cased because there is nothing to override.

## Metric-name conventions

`db.<subsystem>.<metric>` — three dot-separated segments, lowercase,
snake_case within each segment when a metric name has multiple
words. Match the existing names in
[`packages/protocol/src/metrics.ts`](../../../packages/protocol/src/metrics.ts).
Labels are flat `Readonly<Record<string, string>>` — no numbers as
label values, no nested objects — so any aggregation backend can
consume them.

The load-bearing kernel metrics today (canonical list in
[`packages/protocol/src/metrics.ts`](../../../packages/protocol/src/metrics.ts)):

- `db.write.class_a_ops_per_logical_write` — writer histogram
  (p99 alert at 5).
- `db.write.index_ops_per_logical_write` — writer histogram
  (`K (PUT) + L (DELETE)` per commit, per-collection label).
- `db.r2.put.412_total` — CAS conflict / `If-Match` / `If-None-Match`
  loss counter.
- `db.r2.put.429_total` — R2 prefix-partition rate-limit counter.
- `db.manifest.lag_window_depth` — compactor gauge (alert at >100).
- `db.compact.entries_folded` — compactor histogram (entries folded
  per run).
- `db.gc.entries_swept_per_second` — GC gauge (livelock indicator
  when below writes/s).
- `db.gc.swept_total` — GC counter, labelled by reason.
- `db.orphan.candidate_count` — GC gauge (`gc/pending.json` depth).
- `db.storage.<op>.calls_total` / `db.storage.<op>.errors_total` /
  `db.storage.<op>.duration_ms` — storage decorator counters +
  histogram (one trio per `get` / `put` / `delete` / `list`).
- `db.storage.class_a_ops_total` / `db.storage.class_b_ops_total` —
  storage decorator's S3-pricing rollup.

Don't invent new namespaces casually. New subsystem? Pick from the
existing set (`write`, `r2`, `manifest`, `gc`, `orphan`, `compact`,
`storage`) or discuss with maintainers before adding `db.newthing.*`
— metric names are a contract.

### Rejected naming alternatives

- **Camel-case namespacing** (e.g. `dbWrite.classAOpsPerLogicalWrite`).
  Does not survive every aggregation backend (statsd, Prometheus,
  OpenTelemetry, Workers Analytics Engine); the dot is the
  widely-supported namespace separator. Deeper trees
  (`db.write.commit.412.total`) reduce aggregation ergonomics with
  no offsetting benefit, so we cap at three segments.
- **Backend-specific naming.** The recorder abstraction exists
  precisely so the kernel does not have to know its sink. A future
  preset could ship a Prometheus or OpenTelemetry adapter without
  changing emit sites.

### Prohibited patterns

- **Numeric label values.** Prometheus and OpenTelemetry both
  treat numeric labels as anti-patterns — they explode cardinality
  and produce unaggregatable series.
- **Nested objects as label values.** The type signature literally
  forbids this (`Record<string, string>`), but reviewers should
  reject any caller that string-encodes a JSON object into a label.
- **New top-level prefixes other than `db.`**. Kernel metrics live
  under one root; adapters or operators emitting their own metrics
  use their own roots.
- **`InMemoryMetricsRecorder` in production code.** It exists as a
  test helper only; memory grows unbounded.
- **Renaming a live metric without coordinating with the test
  suite.** Test assertions match exact metric names, so a rename is
  a multi-file change. The friction is deliberate; a name is a
  contract.
- **Mixed-case label values.** Labels are case-sensitive at the
  aggregator — reviewers reject `tenant=ACME` vs `tenant=acme`
  cardinality splits.

## Test patterns

Use the `collectingSink` pattern from
[`packages/server/src/observability/canonical.test.ts`](../../../packages/server/src/observability/canonical.test.ts):

```ts
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureObservability } from "../observability";

const collectingSink = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  return { records, sink: (r) => records.push(r) };
};

let records: LogRecord[];
beforeEach(async () => {
  let sink: Sink;
  ({ records, sink } = collectingSink());
  await configureObservability({ level: "debug", sink });
});
afterEach(async () => {
  await reset();
});
```

Always `await reset()` in `afterEach`. LogTape's `configure` is
global; a leaked sink in test A poisons test B with stale records.

## Anti-patterns

- ❌ Don't log inside hot loops at `info` or higher. The kernel's
  hot paths emit at `debug` exactly because logging on every
  iteration breaks Workers' 50ms CPU budget.
- ❌ Don't put high-cardinality fields (refs, etags, user_ids) in
  metric labels. They're fine in canonical-line fields (one row per
  request); they create cardinality explosions in metric exporters.
- ❌ Don't add a separate logger import. Use `getLogger(CATEGORY.<unit>)`
  from `../observability`. The `CATEGORY` constants ensure the
  hierarchical routing under `["baerly", ...]` hits the configured
  sink — bare-string categories miss it.
- ❌ Don't call `configureObservability` from kernel code. Adapters
  call it once at boot; kernel code uses `getLogger(...)` and the
  current config takes effect.
- ❌ Don't read `process.env` directly for level / sample rate.
  Pass through the typed `ObservabilityConfig` option so the
  envvar fallback lives in one place (the logger config).
