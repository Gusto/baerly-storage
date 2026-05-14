---
title: Conventions for observability code
audience: coder
summary: One canonical line per unit-of-work, field attachment, DEBUG vs INFO, test patterns.
last-reviewed: 2026-05-12
tags: [conventions, observability]
related: ["../observability.md", "tests.md"]
---

# Observability conventions

Rules for code that emits observability. The operator-facing
counterpart is [`docs/observability.md`](../observability.md).

## The one rule

**Every unit of work emits one canonical line.** A unit is an HTTP
request, a maintenance run, a GC sweep, a compactor run, or a
`rebuildIndex` call. The kernel emits the line; you don't.

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

getLogger(CATEGORY.writer).debug("step", { collection, attempt });
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

## When to create a new `withObservability` scope

Whenever you add a new top-level entry point that does meaningful
work and isn't already wrapped:

- Admin commands (e.g. `baerly admin rebuild-index`).
- Batch operations triggered out-of-band.
- Long-running background jobs.

`withObservability` handles the recorder, the sample decision, and
the canonical-line flush:

```ts
import { withObservability } from "../observability";

await withObservability("rebuild", async (ctx, recorder) => {
  ctx.fields.set("collection", collection);
  await runTheWork();
});
```

The body sees the context positionally for ergonomic field-setting,
but `getCurrentContext()` works inside any descendant too — async
propagation is via `AsyncLocalStorage`.

## When to use DEBUG

DEBUG is for stuff that's:

- Per-storage-op (one event per `get` / `put` / `delete` / `list`).
- Per-predicate-evaluation step.
- Anything hot you want occasional visibility on without paying for
  it in production.

Toggle on per-deployment via `LOG_LEVEL=debug`. Tests opt in by
passing `{ level: "debug" }` to `configureObservability`.

## Sampling philosophy

The head sampler decides at request entry whether to keep the
canonical line. **Don't bypass it.** If something *must* always
emit, the flusher already handles two cases:

- Errors set `force_kept_by_error = true` automatically.
- Non-HTTP units (`maintenance`, `gc`, `compactor`, `rebuild`)
  always emit by virtue of not going through the head-sampler at
  all. `withObservability` does set `sampled_by_head` for symmetry
  with the HTTP path, but the flusher's keep/drop decision is
  effectively always-keep for non-HTTP.

If you find yourself wanting to flip `force_kept_by_error` outside
the error path: stop. Use DEBUG, or attach a field to the canonical
line that the operator can dashboard on. Always-on logging defeats
the sampling story.

## Metric-name conventions

`db.<subsystem>.<metric>` — three dot-separated segments, lowercase,
snake_case within each segment when a metric name has multiple
words. Match the existing names in
[`packages/protocol/src/metrics.ts`](../../packages/protocol/src/metrics.ts).
Labels are flat `Readonly<Record<string, string>>` — no numbers as
label values, no nested objects — so any aggregation backend can
consume them.

Examples in tree today:

- `db.r2.put.412_total` — CAS conflict counter.
- `db.r2.put.429_total` — rate-limit hit counter.
- `db.write.class_a_ops_per_logical_write` — writer histogram.
- `db.storage.<op>.calls_total` — storage decorator counter.
- `db.storage.class_a_ops_total` / `db.storage.class_b_ops_total` —
  storage decorator's S3-pricing rollup.
- `db.compact.entries_folded` — compactor counter.
- `db.gc.swept_total` — GC counter.

Don't invent new namespaces casually. New subsystem? Pick from the
existing set (`write`, `r2`, `manifest`, `gc`, `orphan`, `compact`,
`tenant`, `storage`) or discuss with maintainers before adding
`db.newthing.*` — metric names are a contract.

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
[`packages/server/src/observability/canonical.test.ts`](../../packages/server/src/observability/canonical.test.ts):

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
  await configureObservability({ level: "debug", sink, sampleRate: 1 });
});
afterEach(async () => {
  await reset();
});
```

Always `await reset()` in `afterEach`. LogTape's `configure` is
global; a leaked sink in test A poisons test B with stale records.

`sampleRate: 1` ensures every line lands; otherwise head-sampling
makes assertions flaky. The error-path tests can drop the rate to
`0` to prove force-keep works.

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
