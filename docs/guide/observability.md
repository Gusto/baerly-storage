---
title: Observability
audience: operator
summary: "Sinks (OTel / Workers Analytics Engine / Datadog), cost-ballooning anti-patterns, and known gaps. Canonical log-line shape lives in dist/API.md."
last-reviewed: 2026-05-28
tags: [observability, operations, logging]
related: ["../contributing/conventions/observability.md", "../about/cost-model.md", "../contributing/development.md"]
---

# Observability

## What this guide is

This is the **operator runbook** for observability — sink wiring,
cost-ballooning anti-patterns, and known gaps. The canonical
log-line shape and field reference live in
[`dist/API.md`](../../packages/server/API.md) → "Observability"
because consumer LLMs read API.md from `node_modules/` and need the
contract one `cat` away. Read API.md first; come back here for sink
recipes.

The kernel emits **one canonical log line per HTTP request** at
`info` level by default. Background work
(`runScheduledMaintenance`) emits a separate
`unit_of_work: "maintenance"` line. The Cloudflare adapter is
JSON-only; the Node adapter switches to a single-line human-readable
shape under TTY. Set `LOG_LEVEL` or `observability.level` to tune
verbosity.

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
`baerly cost --collection=<collection>` projects Class A ops/mo and a
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

baerlyNode({ app, storage, verifier, observability: { sink: otelSink } });
```

### Cloudflare Workers Analytics Engine

CF's [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
is a free-tier-friendly time-series sink keyed by indices + blobs.
Wire it via a custom sink that pulls the binding off `env`:

```ts
// worker.ts
import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";

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

- **`invalidateOnWrite` is unobserved.** The CF adapter runs cache
  invalidation inside `ctx.waitUntil` after the response is sent —
  by then the canonical line for the request has already flushed,
  and the invalidator itself doesn't emit any metrics. Failures
  surface only on the Worker's process log.

## Cross-references

- [`docs/conventions/observability.md`](../contributing/conventions/observability.md)
  — contributor-facing rules for adding new emit sites.
- [`docs/cost-model.md`](../about/cost-model.md) — how class-A counts map to
  S3 / R2 spend.
- Public API: JSDoc on `baerlyNode` (Node) and `baerlyWorker`
  (Cloudflare). Both expose `observability?: ObservabilityConfig`.
- LogTape itself: <https://logtape.org/>. The kernel uses LogTape's
  `Sink` / `Logger` types directly; anything in the LogTape ecosystem
  works as a drop-in.
