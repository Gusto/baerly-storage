---
title: Observability
audience: operator
summary: "Operator signals, first-response actions, sinks, cost-ballooning anti-patterns, and known gaps. Canonical log-line shape lives in dist/API.md."
last-reviewed: 2026-06-23
tags: [observability, operations, logging]
related:
  [
    "../contributing/conventions/observability.md",
    "../about/cost-model.md",
    "../contributing/development.md",
  ]
---

# Observability

## What this guide is

This is the **operator runbook** for observability: what to watch,
what to do first, how to wire sinks, which logging choices balloon
cost, and which signals are still missing. The canonical log-line
shape and field reference live in
[`packages/server/API.md`](../../packages/server/API.md), published as
`node_modules/@gusto/baerly-storage/dist/API.md`, under
"Observability" because consumer LLMs read API.md from
`node_modules/` and need the contract one `cat` away. Use API.md when
you need the exact field list; use this page when a deployment is live.

The threshold idea: baerly logs the request, not every internal step.
At the end of each HTTP request, the kernel emits **one canonical log
line**. More precisely, the line is `info` by default, rises to `warn`
on any 4xx — a client error is the caller's fault, not a server fault,
so a `409 Conflict` (a duplicate-`_id` insert) stays `warn` — and rises
to `error` only on a 5xx or an otherwise-unclassified thrown error. It
carries a
`request_id`, an `outcome` (`read` / `committed` / `conflict` /
`error`), and the per-request `db.*` counters.

Maintenance is the exception because it can run outside that request
boundary. The in-band write-tick runner (`runBoundedMaintenance`) never
throws: it swallows expected `Conflict` CAS losses silently, and on an
unexpected error it increments `db.maintenance.unexpected_error_total`
and logs the stack via `console.error`. A separate, rate-limited
`console.warn` fires when compaction defers. The opt-in
`runScheduledMaintenance` cron runner simply awaits `compact()` and
`runGc()` and propagates any error to the caller's cron handler.

Watch the surface your host actually emits. Node's inline write-tick can
attach maintenance counters to the request line. Cloudflare write-tick
maintenance runs in `ctx.waitUntil` after the request line has flushed,
so first response uses `wrangler tail` for the rate-limited
`console.warn` / `console.error` records. The Cloudflare adapter is
JSON-only; the Node adapter switches to a single-line human-readable
shape under TTY. Set `LOG_LEVEL` or `observability.level` to tune
verbosity.

## What to watch

| Signal                                        | Indicates                                                    | First response                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status >= 500` or `outcome:"error"`          | User-visible API failure                                     | Inspect `error.code`, storage status, and the request path.                                                                                                                                                                                                                                                               |
| `outcome:"conflict"` rate rising              | HTTP 409; the only reachable 409 is a duplicate-`_id` insert | App-level id collision (clients reusing `_id`s or double-submitting POSTs), not storage contention — prefer letting the server mint `_id` (omit it on insert). Write contention is absorbed by the forward-probe and surfaces on `db.r2.put.412_total`, not here.                                                         |
| `db.r2.put.412_total` sustained               | Conditional-write (412) losses on log creates                | Check writes/min for the hot collection; retry at app edge if bursty, graduate if sustained. This is the storage-level conditional-write contention meter.                                                                                                                                                                |
| `db.compaction.deferred_total` or deferral `console.warn` | Snapshot exceeded byte or row fold ceiling                   | The counter carries a `dimension` label at the source, but the canonical JSON line flattens it. The rate-limited `console.warn` (not emitted on every defer, and the primary Cloudflare first-response signal) names bytes-vs-rows. Then read [graduation.md](../about/graduation.md). Raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` only on paid CF / Node with enough memory. |
| `db.compaction.cas_lost_total` sustained      | Duplicate fold compute under contention                      | Watch object count and GC drain; sustained growth is a graduation signal.                                                                                                                                                                                                                                                 |
| Class A ops above projection                  | Cost regression or hot write path                            | Run `baerly cost --bucket=<bucket-uri> --collection=<collection>` and compare to [cost-model.md](../about/cost-model.md).                                                                                                                                                                                                 |
| Object count grows while write rate is steady | GC is not draining or contention is above envelope           | Run `baerly admin fsck`; inspect maintenance warnings.                                                                                                                                                                                                                                                                    |

For Cloudflare, `wrangler tail` is enough for first response. For
trend and alerting, send the canonical line to Workers Analytics
Engine, CloudWatch, Datadog, or an OTel collector.

## First response

Cloudflare:

```sh
wrangler tail --format=json
```

Node:

```sh
LOG_LEVEL=info node server.js
```

A canonical JSON line looks like this shape (fields vary by adapter and
outcome):

```json
{
  "timestamp": 1718323200000,
  "level": "info",
  "category": "baerly.http",
  "message": "canonical",
  "request_id": "0f9c1f7e-2c3d-4a8b-9e10-7b6a5c4d3e2f",
  "duration_ms": 18,
  "outcome": "read",
  "status": 200,
  "method": "GET",
  "path": "/v1/c/tickets",
  "db.storage.class_a_ops_total": 0,
  "db.storage.class_b_ops_total": 3
}
```

`summarize()` only emits keys for counters actually observed. A pure
read line carries the `db.storage.*` op counters but not the
`db.compaction.*` counters. Those counters appear only when write-tick
maintenance runs before the canonical line flushes.

The filters below are for JSON canonical lines. On Cloudflare,
post-response `ctx.waitUntil` maintenance has already missed that line;
use `wrangler tail` to search for the deferral `console.warn` or
maintenance `console.error` when the question is compaction or GC.

Copyable local filters for JSON logs:

```sh
# User-visible failures.
wrangler tail --format=json | jq 'select(.outcome == "error" or (.status >= 500))'

# Deferred folds: snapshot exceeded byte or row ceiling. The canonical
# line flattens the counter and drops its dimension label; the
# rate-limited console.warn (not on every defer) names bytes-vs-rows.
wrangler tail --format=json | jq 'select(."db.compaction.deferred_total" > 0)'

# Duplicate fold compute under contention.
wrangler tail --format=json | jq 'select(."db.compaction.cas_lost_total" > 0)'

# Requests that consumed Class A storage ops.
wrangler tail --format=json | jq 'select(."db.storage.class_a_ops_total" > 0)'
```

For Node stdout, replace `wrangler tail --format=json` with your log
file or process stream.

## Sinks

The kernel ships one in-box sink shorthand; pretty rendering lives
in the Node adapter:

- `"console-json"` — one JSON object per line via `console.log`.
  Default for production. Cloudflare and CloudWatch ingest this
  natively.
- A custom `Sink` function — pass through verbatim. The Node adapter
  auto-selects an internal pretty renderer when
  `process.stdout.isTTY === true` (developer terminals), and uses
  `"console-json"` otherwise. `prettyConsoleSink()` is not currently a
  public sink API; pass your own `Sink` function if you need manual
  wiring in another Node host.

### Wiring a custom sink

**For a one-shot day-1 cost peek, you don't need a sink at all. Run
`baerly cost --bucket=<bucket-uri> --collection=<collection>` to project
Class A ops/mo and a free-tier-aware dollar trajectory. Wire a custom
sink (below) only when you need 7-day / 30-day trends or alerting.**

Pass a `Sink` (a function `(LogRecord) => void`) to the adapter's
`observability.sink` field:

```ts
import type { Sink } from "@gusto/baerly-storage/observability";

const otelSink: Sink = (record) => {
  // Push to your OTel collector. Sketch:
  fetch("http://otel-collector:4318/v1/logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(record.timestamp * 1e6),
                  severityText: record.level,
                  body: { stringValue: record.message.join("") },
                  attributes: Object.entries(record.properties).map(([k, v]) => ({
                    key: k,
                    value: { stringValue: String(v) },
                  })),
                },
              ],
            },
          ],
        },
      ],
    }),
  }).catch(() => {
    // Best-effort; never throw from a sink.
  });
};

baerlyNode({ config, storage, verifier, observability: { sink: otelSink } });
```

### Cloudflare Workers Analytics Engine

CF's [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
is a free-tier-friendly time-series sink keyed by indices + blobs.
Wire it via a custom sink that pulls the binding off `env`:

```ts
import type { Sink } from "@gusto/baerly-storage/observability";

// worker.ts
import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";
import type { BaerlyEnv } from "@gusto/baerly-storage/cloudflare";
import config from "../../baerly.config.ts";

interface AppEnv extends BaerlyEnv {
  readonly ANALYTICS: AnalyticsEngineDataset;
}

const analyticsSink =
  (env: AppEnv): Sink =>
  (record) => {
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
  config,
  // verifier: cloudflareAccess({ ... }), // add your production verifier
  observability: { sink: analyticsSink(env) },
}));
```

Declare the binding in `wrangler.jsonc`:

```jsonc
{
  "analytics_engine_datasets": [{ "binding": "ANALYTICS", "dataset": "{{appName}}_canonical" }],
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
Logs HTTP intake from a custom sink. Batch and backpressure this in
real deployments; the inline snippet is intentionally a minimal sketch
and must never throw:

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

## Embedding baerly in an app that already uses LogTape

baerly is a library, and [LogTape's guidance](https://logtape.org/manual/library)
is that only the *application* configures LogTape — a library must not
reset another app's logging config. The adapters auto-configure at boot
for the common zero-config case (a scaffolded standalone server), but
they will **never clobber a config you installed first**:

- If your app calls `configure()` (or `configureSync()`) before
  `baerlyNode` / `baerlyWorker` boots, baerly detects the existing
  config, leaves it untouched, and emits one `["logtape", "meta"]`
  notice. baerly's `["baerly", …]` categories then route through
  whatever sinks your config wired for them (its root/catch-all sink,
  or nowhere). To capture baerly's logs, add a logger for the
  `["baerly"]` category in your own `configure()` call.
- To stop baerly from touching LogTape at all — even when it boots
  first — pass **`observability: false`**:

  ```ts
  baerlyNode({ config, storage, verifier, observability: false });
  // or, on Cloudflare:
  baerlyWorker((env) => ({ config, observability: false }));
  ```

  Your app then owns the process-wide (isolate-wide on Workers) LogTape
  configuration end to end.

## Cost-ballooning anti-patterns

- ❌ **Don't log request bodies.** baerly-storage stores arbitrary
  JSON; a body field could be megabytes. The canonical line is a few
  hundred bytes by design.
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

- **`invalidateOnWrite` is unobserved.** The CF adapter runs cache
  invalidation inside `ctx.waitUntil` after the response is sent —
  by then the canonical line for the request has already flushed,
  and the invalidator itself doesn't emit any metrics. Failures
  surface only on the Worker's process log.

## Cross-references

- [`docs/contributing/conventions/observability.md`](../contributing/conventions/observability.md)
  — contributor-facing rules for adding new emit sites.
- [`docs/about/cost-model.md`](../about/cost-model.md) — how class-A counts map to
  S3 / R2 spend.
- Public API: JSDoc on `baerlyNode` (Node) and `baerlyWorker`
  (Cloudflare). Both expose `observability?: ObservabilityConfig | false`
  (`false` opts out of auto-configuration — see "Embedding baerly"
  above).
- LogTape itself: <https://logtape.org/>. The kernel uses LogTape's
  `Sink` / `Logger` types directly; anything in the LogTape ecosystem
  works as a drop-in.
