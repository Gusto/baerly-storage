---
title: Observability
audience: operator
summary: "Canonical log lines, sampling, sinks (OTel / Workers Analytics Engine / Datadog), and known gaps."
last-reviewed: 2026-05-16
tags: [observability, operations, logging]
related: ["../contributing/conventions/observability.md", "../about/cost-model.md", "../contributing/development.md"]
---

# Observability

baerly-storage emits **one canonical log line per unit of work** —
HTTP request, maintenance run, GC sweep, compactor run,
`rebuildIndex` call — on stdout. Default level `info`, default
sample rate `0.1`. Errors are always kept; maintenance always
emits. The scaffolded templates wire this on day one; no code
change required to opt in.

This doc is for the operator deploying baerly. For the contributor
adding a new code path, see
[`docs/conventions/observability.md`](../contributing/conventions/observability.md).

## What lands by default

Run a scaffolded `baerly create` app under either target:

```sh
# Cloudflare
pnpm dev          # vite + @cloudflare/vite-plugin (Worker in workerd)
# Node
pnpm dev          # vite + baerlyDev() — single process on :5173 over LocalFsStorage
```

Hit any route. One JSON line per request appears on stdout:

```json
{
  "timestamp": "2026-05-12T17:42:11.823Z",
  "level": "info",
  "category": "baerly.http",
  "message": "canonical",
  "request_id": "0193b0a1-ff7a-7c44-b9d5-c3e91d8f3a01",
  "method": "POST",
  "path": "/v1/t/tickets",
  "status": 200,
  "duration_ms": 14.207,
  "outcome": "ok",
  "db.storage.put.calls_total": 3,
  "db.storage.get.calls_total": 1,
  "db.storage.class_a_ops_total": 3,
  "db.storage.class_b_ops_total": 1,
  "db.write.class_a_ops_per_logical_write_p50": 3,
  "db.write.class_a_ops_per_logical_write_count": 1
}
```

### TTY pretty output

The Node adapter auto-selects a human-readable single-line shape when
`process.stdout.isTTY === true` (developer terminals). Same fields,
column-aligned, one line per unit-of-work. Sample lines:

```text
12:34:56 GET   /v1/t/tickets                200   1ms  req=ab12cd34 class_a=0 class_b=1
12:34:57 POST  /v1/t/tickets                201  20ms  req=cd34ef56 class_a=3 class_b=0 wamp=7
12:34:58 POST  /v1/t/tickets                409   8ms  req=ef56gh78 class_a=1 class_b=0 412=1 outcome=conflict
12:34:59 GET   /v1/t/tickets                200   0ms  req=gh78ij90 cache=hit
12:35:00 ⚙ maintenance                                 142ms  class_a=4
```

The TTY shape is presentation only — the underlying fields are the
same ones the JSON shape carries. Non-TTY stdout (`pnpm dev` piped
through a process supervisor, CI, container logs, Workers Logs) gets
the JSON shape above. The Cloudflare adapter is JSON-only — Workers
have no TTY.

Cloudflare Workers Logs and AWS CloudWatch ingest this format
natively. Datadog's Agent picks it up via its `json` source. Any
log aggregator that parses JSON-per-line works without further
wiring.

## The canonical log line

One event per unit of work. The kernel emits one line for each:

- HTTP request (every `/v1/*` route).
- Maintenance run (the scheduled compactor + GC cycle).
- GC sweep.
- Compactor run.
- `rebuildIndex` admin call.

### Field reference

| Field | Type | Meaning |
|---|---|---|
| `request_id` | UUID-ish string | Correlates this event across logs. Set from `X-Request-Id` if the caller supplied one, else minted fresh. |
| `method` | string | HTTP method (HTTP unit only). |
| `path` | string | Request path (HTTP unit only). |
| `status` | number | HTTP status code (HTTP unit only). |
| `cache_status` | `"hit" \| "miss" \| "bypass"` | Cloudflare adapter only. Set per HTTP request via the Cache API wrapper. `"hit"` skips the router; `"miss"` populates the cache; `"bypass"` covers non-GET, `/v1/since`, `/v1/healthz`, and anything outside `/v1/t/`. The Node adapter has no cache layer and never emits this field. |
| `duration_ms` | number | Monotonic wall-clock duration, `performance.now()` delta. |
| `outcome` | string | One of `"ok"`, `"conflict"`, `"not_found"`, `"client_error"`, `"internal_error"`, or a unit-specific tag. |
| `db.storage.class_a_ops_total` | number | Sum of PUT + DELETE + LIST calls. These are the physical operations S3-pricing classifies as Class A — the cost-dominant ones. |
| `db.storage.class_b_ops_total` | number | Sum of GET calls. Class B in S3 pricing. |
| `db.storage.<op>.calls_total` | number | Per-op breakdown for `get` / `put` / `delete` / `list`. |
| `db.storage.<op>.duration_ms_p50` / `_p99` / `_count` / `_sum` | number | Histogram of per-call durations. |
| `db.write.class_a_ops_per_logical_write_*` | number | Writer's per-`commit()` class-A-op count. `_count` = number of logical writes in this request. |
| `db.r2.put.412_total` | number | CAS or conditional-PUT conflicts. Non-zero on `_total` means contention. |
| `db.r2.put.429_total` | number | Storage-side rate-limit hits. |
| `error.code` | string | `BaerlyErrorCode` discriminator (failure path only). |
| `error.message` | string | Error message (failure path only). |
| `error.stack` | string | Stack trace (`error`-level lines only). |

Class A / Class B totals are the **load-bearing fields** —
[`docs/cost-model.md`](../about/cost-model.md) lays out the per-request
cost ceiling, and the canonical line is how you verify a deployed
service stays under it.

### Maintenance-specific fields

The `maintenance` unit-of-work emits the fields above plus two
explicit summary fields read off the `MaintenanceResult` returned
by `runScheduledMaintenance`:

| Field | Type | Meaning |
|---|---|---|
| `compact_written` | number | Log entries folded into the new snapshot this tick. `0` when the live tail was below `minEntriesToCompact`. |
| `gc_swept` | number | Keys deleted this tick. `0` when no candidates had aged out. |

The kernel still emits the recorder-bag fields (`db.compact.entries_folded_p50` / `_p99` / `_count` / `_sum`,
`db.manifest.lag_window_depth`, `db.orphan.candidate_count`,
`db.gc.entries_swept_per_second`, `db.gc.swept_total`)
alongside — useful for dashboards. The two explicit fields above
are the at-a-glance summary so a log scan answers "did anything
happen this tick?" without decoding `_p50` / `_count` / `_total`
suffixes.

## Log levels

| Level | What lands |
|---|---|
| `error` | `error` records only. The canonical line emits at `error` level when `status >= 500` or an exception was thrown. |
| `warn` | Adds 4xx canonical lines and explicit `warn` records. |
| `info` (default) | Adds 2xx canonical lines, maintenance runs, lifecycle events. |
| `debug` | Adds per-storage-op events (one per `get` / `put` / `delete` / `list`). **High volume**; off in production. Useful for diagnosing a single slow request. |

Toggle via the `LOG_LEVEL` env var (both templates) or the typed
`observability.level` option.

## Sampling

Head-based, deterministic per `request_id`. The decision is made
once at request entry and held until flush.

- Default rate: `0.1` (10% of successful requests).
- **Errors are always kept** — the flusher overrides the sample
  decision on the failure path.
- Maintenance / GC / compactor / `rebuildIndex` always emit. They
  aren't HTTP units and don't go through the head sampler.
- Set `LOG_SAMPLE=1.0` while diagnosing; set `LOG_SAMPLE=0` to
  suppress success lines entirely (errors still emit). The typed-
  option equivalent — platform-portable, no env var required — is
  `observability: { sampleRate: 0 }` passed to `baerlyWorker` /
  `createApp` (or `baerlyNode`). Either form works; the typed
  option wins when both are set.

Sampling is hash-based on `request_id`, so retries (which carry the
same `X-Request-Id`) are kept-or-dropped consistently — you won't
see the first attempt sampled out and the retry sampled in.

## Sinks

The kernel ships one in-box sink shorthand; pretty rendering lives
in the Node adapter:

- `"console-json"` — one JSON object per line via `console.log`.
  Default for production. Cloudflare and CloudWatch ingest this
  natively.
- A custom `Sink` function — pass through verbatim. The Node
  adapter's `@baerly/adapter-node` exports `prettyConsoleSink()`,
  a human-readable renderer auto-selected when
  `process.stdout.isTTY === true` (developer terminals); pass it
  as a `Sink` function to wire it manually in other Node hosts.

### Wiring a custom sink

**For a one-shot day-1 cost peek, you don't need a sink at all —
`baerly cost --table=<collection>` projects Class A ops/mo and a
free-tier-aware dollar trajectory. Wire a custom sink (below) only
when you need 7-day / 30-day trends or alerting.**

Pass a `Sink` (a function `(LogRecord) => void`) to the adapter's
`observability.sink` field:

```ts
import type { Sink } from "@logtape/logtape";

const otelSink: Sink = (record) => {
  // Push to your OTel collector. Sketch:
  fetch("http://otel-collector:4318/v1/logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: String(record.timestamp * 1e6),
        severityText: record.level,
        body: { stringValue: record.message.join("") },
        attributes: Object.entries(record.properties).map(([k, v]) => ({
          key: k, value: { stringValue: String(v) },
        })),
      }]}]}],
    }),
  }).catch(() => {
    // Best-effort; never throw from a sink.
  });
};

createApp({ app, storage, verifier, observability: { sink: otelSink } });
```

### Cloudflare Workers Analytics Engine

CF's [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
is a free-tier-friendly time-series sink keyed by indices + blobs.
Wire it via a custom sink that pulls the binding off `env`:

```ts
// worker.ts
import { baerlyWorker } from "baerly-storage/cloudflare";

interface AppEnv {
  readonly ANALYTICS: AnalyticsEngineDataset;
}

const analyticsSink = (env: AppEnv): Sink => (record) => {
  const props = record.properties;
  env.ANALYTICS.writeDataPoint({
    indexes: [String(props["request_id"] ?? "")],
    blobs: [
      record.category.join("."),
      record.level,
      String(props["method"] ?? ""),
      String(props["path"] ?? ""),
      String(props["outcome"] ?? ""),
    ],
    doubles: [
      Number(props["duration_ms"] ?? 0),
      Number(props["db.storage.class_a_ops_total"] ?? 0),
      Number(props["db.storage.class_b_ops_total"] ?? 0),
      Number(props["status"] ?? 0),
    ],
  });
};

export default baerlyWorker<AppEnv>((env) => ({
  verifier: ...,
  observability: { sink: analyticsSink(env) },
}));
```

Declare the binding in `wrangler.jsonc`:

```jsonc
{
  "analytics_engine_datasets": [
    { "binding": "ANALYTICS", "dataset": "{{appName}}_canonical" }
  ]
}
```

Query the dataset via CF's GraphQL Analytics API. The `indexes`
field is the high-cardinality column; you get one row per canonical
line.

### Datadog

If your host runs the Datadog Agent and stdout is piped to it, **no
code change**. Set `DD_LOGS_INJECTION=true` in the Agent's env to
get `dd.trace_id` / `dd.span_id` correlation if you also enable APM,
otherwise the JSON-per-line ingestion works as-is.

For a fully-self-managed pipe (no Agent), POST records to Datadog
Logs HTTP intake from a custom sink:

```ts
const datadogSink: Sink = (record) => {
  fetch("https://http-intake.logs.datadoghq.com/api/v2/logs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "DD-API-KEY": env.DD_API_KEY,
    },
    body: JSON.stringify({
      ddsource: "baerly",
      service: "{{appName}}",
      ...record.properties,
      message: record.message.join(""),
      level: record.level,
    }),
  }).catch(() => {});
};
```

## Cost-ballooning anti-patterns

- ❌ **Don't log request bodies.** baerly stores arbitrary JSON; a
  body field could be megabytes. The canonical line is a few hundred
  bytes by design.
- ❌ **Don't log-and-rethrow.** The canonical-line emitter already
  redacts and serializes the thrown error on the failure path. A
  manual `console.error(err); throw err;` double-emits.
- ⚠️ **Watch high-cardinality fields in metric labels.** Things
  like `ref`, `etag`, `user_id`, `request_id` are fine as
  canonical-line fields (one row per request), but blow up
  Prometheus / Datadog metric labels (one series per distinct
  value). Use them in fields; bucket them in labels.
- ❌ **Don't put canonical lines inside hot loops.** One canonical
  line is one unit of work. A loop emitting 1000 of them per
  request defeats the sampling story.

## Known gaps

- **`invalidateOnWrite` is unobserved per-request.** The CF
  adapter runs cache invalidation inside `ctx.waitUntil` after the
  response is sent. Its work doesn't contribute to the canonical
  line that already shipped. Aggregate counts are still in the
  operator's `MetricsRecorder` sink.
- **Direct `Storage` access (via `db._raw`) bypasses the
  observability storage decorator.** The decorator wraps the
  storage handed to `createApp` / `baerlyWorker`; code that
  reaches the raw handle skips per-op counters. This is intentional
  — `_raw` is an `@internal` escape hatch.

## Cross-references

- [`docs/conventions/observability.md`](../contributing/conventions/observability.md)
  — contributor-facing rules for adding new emit sites.
- [`docs/cost-model.md`](../about/cost-model.md) — how class-A counts map to
  S3 / R2 spend.
- Public API: JSDoc on `createApp` (Node) and `baerlyWorker`
  (Cloudflare). Both expose `observability?: ObservabilityConfig`.
- LogTape itself: <https://logtape.org/>. The kernel uses LogTape's
  `Sink` / `Logger` types directly; anything in the LogTape ecosystem
  works as a drop-in.
