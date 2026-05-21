# `hono-node-server` branch follow-ups

The branch landed in 4 commits (`0fd1be8` → `24c5353`, total
−894 LoC) replacing the hand-rolled Node↔Fetch bridge in
`packages/adapter-node/src/server.ts` with `@hono/node-server`'s
`serve()` + `getRequestListener()`. The critical long-poll /
client-abort regression suite at
`packages/adapter-node/src/server.test.ts` passes verbatim.

One known regression and a couple of dependent items remain.

## 1. Body-cap drain-after-exceed is gone in adapter-node — MEDIUM

The pre-pivot bridge enforced `MAX_BODY_BYTES` (1 MiB) at the Node
stream-pump layer, with a load-bearing "drain-after-exceed" semantic
documented at the deleted `server.ts:476-491`: when a chunked POST
exceeded the cap, the cap-trip silently drained remaining bytes
rather than tearing down the socket, so the client's `fetch()`
could finish its body write and read the 413 envelope cleanly.

T01 introduced `bodyCapMiddleware` to replace that. T04 deleted the
middleware after finding it raced with `@hono/node-server`'s body
reader: attaching `incoming.on("data", ...)` puts the Node stream
into flowing mode and consumes chunks before the bridged WHATWG
Request body sees them, surfacing as `400 SchemaError` on every POST.

**Current state.** Body-cap enforcement now relies entirely on the
kernel router's defence-in-depth at
`packages/server/src/http/router.ts:464-501`:

- Content-Length header check before reading (lines 466-470). Trips
  early when the client advertises an over-cap body.
- Post-materialise check on `c.req.arrayBuffer()` result (lines
  478-481). Trips after the kernel has already buffered the bytes.

**The regression.** A chunked transfer with no Content-Length and
bytes arriving over a slow connection will buffer the full body in
memory before the post-materialise check fires. Cloudflare Workers
are protected by platform-imposed body limits (16 MB free / 100 MB
paid). Self-hosted Node is not. Production Node deployments typically
sit behind a reverse proxy (nginx, traefik, ALB, CF) that enforces
its own body limit; the regression is bounded by that operational
posture.

**Fix path.** Re-implement body-cap as a Hono middleware that
**wraps `c.req.raw.body` with a counting `TransformStream`** rather
than tapping the underlying IncomingMessage. The TransformStream
sits in the same reader chain as the kernel's `c.req.arrayBuffer()`
consumer, so there's no race. On cap-trip, the TransformStream
errors with `BaerlyError{code:"PayloadTooLarge"}`, the kernel's
`readJsonBody` recognises the `BaerlyError` and re-throws verbatim,
and the wire response is the same 413 envelope as today's
defence-in-depth.

The remaining question is whether to also preserve the drain-on-exceed
client UX. Two options:

- **(a)** Accept the new behavior — over-cap chunked uploads see the
  socket close before the response. Production hosts run behind a
  proxy anyway.
- **(b)** After the TransformStream errors, call `c.env.incoming.resume()`
  to drain the rest of the upload so the 413 reaches the client
  cleanly. This combines the new approach with the old drain
  semantic.

Recommend (b) — small added complexity, restores the documented
client-side UX. Should be a single follow-up PR (~50 LoC + a test).

## 2. Stale references to `createListener` in two existing follow-up docs — LOW

- `docs/followups/dev-vite-plugin-extract.md` referenced
  `createListener` in 3 places. Updated in-place on this branch to
  `createApp` / `getRequestListener(createApp(opts).fetch)`. The
  underlying plan (move `packages/dev/src/vite-plugin.ts` into
  `@baerly/adapter-node` as a subpath export) is unaffected — the
  vite plugin still mounts adapter-node's Fetch handler as Vite
  middleware.
- `docs/followups/publish-direction.md` referenced `createListener`
  in the A3 "Quick start can't be followed" section. Updated
  in-place to `createApp`. The README rewrite still needs to happen
  whenever the publish-direction call is resolved.

No further action needed; both docs are now self-consistent.

## 3. `@hono/node-server` info-log on client abort — INFO

Whenever a `/v1/since` long-poll client disconnects, the library
logs `console.info("The user aborted a request.")`. The kernel's
canonical-line emission still fires as expected; this is the
library's own info-level chatter, not a duplicate or replacement.
The existing long-poll regression tests don't capture stdout, so no
silencer is required. If operator log levels surface info-level
noise as a problem, suppress with a global logger filter at the
adapter level — out of scope for this branch.

## 4. New runtime dependency: `@hono/node-server@^2.0.3`

Added to:

- `packages/adapter-node/package.json` (primary consumer; uses
  `serve()` and `getRequestListener`)
- `packages/dev/package.json` (uses `getRequestListener` in
  `vite-plugin.ts`)
- Root `package.json` devDep (manual-e2e + tests)

`@hono/node-server` itself has zero production deps. The `hono`
runtime was already a transitive dep via `@baerly/server`; it's now
also a direct dep of `packages/adapter-node` because the new
middleware files import `MiddlewareHandler` / `Context` types from
`hono`.

No publish-time concern: both packages are already part of the
public workspace surface. The cost-model implication (kernel
footprint stays small) is preserved; per the budget update in
`tests/integration/bundle-size.test.ts`, the `node.js` aggregator
gained ~13 KiB raw / 4 KiB gz and `dev-vite.js` gained ~27 KiB raw /
8 KiB gz from the listener chunk landing in transitive closures.
