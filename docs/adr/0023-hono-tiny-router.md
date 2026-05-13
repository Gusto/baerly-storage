---
title: HTTP router uses hono/tiny
audience: adr
summary: ADR 0023 — HTTP router uses hono/tiny.
last-reviewed: 2026-05-13
tags: [decision, adr]
related: [README.md, 0019-api-surface-lock.md]
---

# 0023 — HTTP router uses `hono/tiny`

## Status

Accepted (2026-05-13).

## Context

The HTTP dispatcher lives in
[`packages/server/src/http/router.ts`](../../packages/server/src/http/router.ts)
and consumes a small Hono slice: six locked CRUD routes
([ADR-0019](./0019-api-surface-lock.md)) plus `GET /v1/healthz` and
`GET /v1/since`, two `app.use` middlewares (observability + optional
verifier), `c.json` / `c.req.{path,header,query}`. No `app.route()`
mounts, no Hono-shipped middleware.

Both adapters call `createRouter({db, ...})` per request *after* the
verifier resolves the tenant:
[`packages/adapter-cloudflare/src/worker.ts:288`](../../packages/adapter-cloudflare/src/worker.ts)
and
[`packages/adapter-node/src/server.ts:202`](../../packages/adapter-node/src/server.ts).
A fresh `Hono` is therefore instantiated per request, and its matcher
is built per request.

The default `hono` export ships SmartRouter (RegExpRouter + TrieRouter,
chosen at first dispatch). The `hono/tiny` subpath ships PatternRouter
— a flat regex array, built once at route registration. Same package,
same `Hono` API, different backend.

Measured in baerly's per-request topology (10k iterations, 1k warmup,
fresh `Hono` + 6-route registration + one dispatch per iteration):

| Metric                          |    hono | hono/tiny |
|---------------------------------|--------:|----------:|
| p50 µs/req (GET param route)    |    32.9 |       8.4 |
| p99 µs/req                      |    78.5 |      19.2 |
| Heap allocated / req            |  ~22 KB |    ~13 KB |
| `http.js` raw bundle            | 248,783 B | 230,111 B |
| `http.js` gz bundle             |  70,118 B |  65,407 B |
| V8 parse+compile (cold isolate) | +3–4 ms |  baseline |

A naïve dispatch-only bench (one shared app, 100k iterations) ranks
the two builds in the opposite direction by ~150 ns at p50, because
that topology amortizes `new Hono()` + lazy-matcher construction away.
In baerly's actual per-request adapter shape that construction cost
is the dominant term, not dispatch.

## Decision

Use `hono/tiny` for the `Hono` constructor. Keep `Context` typed from
`hono` because the `tiny` subpath does not re-export `Context`:

```ts
import { Hono } from "hono/tiny";
import type { Context } from "hono";
```

`hono/utils/http-status` is unchanged. No package addition or
removal — `hono/tiny` is a subpath of the existing `hono` dependency.

## Consequences

- Per-request routing is ~4× faster at p50 and ~4× better at p99 in
  baerly's per-request-construction topology. Absolute saving is
  ~24 µs/req — small against the 5–50 ms S3 round-trip baseline, but
  free and applied to every dispatch forever.
- `http.js` closure shrinks by ~18 KB raw / ~4.7 KB gz; `index.js` by
  the same absolute amounts. Budgets in
  [`tests/integration/bundle-size.test.ts`](../../tests/integration/bundle-size.test.ts)
  tightened to ~8% above the new measured size, per that file's
  budget convention.
- Allocation per request drops ~9 KB, reducing GC pressure on the
  Cloudflare isolate (128 MB cap).
- V8 parse+compile saves ~3–4 ms per cold isolate boot — roughly
  10–15% of typical Workers cold start.
- PatternRouter is O(N routes × regex match) per dispatch.
  [ADR-0019](./0019-api-surface-lock.md)'s locked 6-route surface
  keeps N small; adding many exotic-pattern routes would warrant
  revisiting SmartRouter.
- The `Context` type still imports from `hono`. Both subpaths ship
  from the same npm package, so this is a path change, not a
  dependency addition.
- Reviewers adding a new HTTP route must keep the contract narrow
  ([ADR-0019](./0019-api-surface-lock.md)); the routing-cost ceiling
  this ADR documents holds only at the current route cardinality.
