# Observability: collapse scope nesting, trim public surface, finish wiring

**Severity: MEDIUM. The kernel ships canonical-line plumbing that's
half-finished — adapters duplicate ~50 lines of ceremony, the
maintenance loop emits three lines per tick where one would do, the
`CATEGORY` table is half-dead, and a load-bearing module barrel
carries a stale "dormant" comment.**

After this cleanup:

- One canonical line per cron tick (not three).
- 401-on-verifier-rejection lives in a `@baerly/server` helper, not
  copy-pasted across both adapters.
- `CATEGORY` lists only the units that actually flush a line.
- Test-only metrics types are demoted out of the public surface.
- The barrel comment matches reality.

Coherent workstream — bundle or split as convenient. Sections are
independent but touch overlapping files (`packages/server/src/observability/`
+ both adapters' top-level files), so a single PR is easier to
review.

---

## 1. Collapse three nested `withObservability` wrappers into one

`packages/server/src/maintenance.ts:90` wraps
`runScheduledMaintenance` in `withObservability("maintenance", ...)`.
Inside, `compact()` opens its own scope at
`packages/server/src/compactor.ts:222`
(`withObservability("compactor", ...)`), and `runGc()` opens
another at `packages/server/src/gc.ts:153`
(`withObservability("gc", ...)`). All three call
`teeMetricsRecorders(...)` for their own canonical-line emit.

One cron tick → three canonical lines for one unit of work.

**Action:**

- Inside `maintenance.ts`, replace the outer `withObservability(
  "maintenance", ...)` with direct calls to `compactInner` and
  `runGcInner` (or expose those directly), and have the inner
  helpers run in the caller's scope.
- Alternatively (less invasive): inside `runScheduledMaintenance`,
  call `compact()` and `runGc()` after stripping their own
  `withObservability` wrap — promote `compact` / `runGc` to
  scope-free, expect callers to wrap.
- Update `maintenance.test.ts` and `maintenance.budget.test.ts`
  expectations to match the new "one line per tick" cadence.

---

## 2. Lift duplicate adapter observability ceremony into a helper

`packages/adapter-cloudflare/src/worker.ts:233-295` and
`packages/adapter-node/src/server.ts:158-300` reproduce the same
call sequence almost verbatim:

```ts
ensureObservability()                    // or configureObservability
const recorder = alsAwareRecorder(operatorRecorder)
// verifier
if (verifier === null) {
  getLogger(CATEGORY.http).warn("verifier_rejected", …)
  flushCanonicalLine(..., status: 401)
  return new Response(
    JSON.stringify(errorEnvelope("Unauthorized",
      "Missing or invalid Authorization header")),
    { status: 401, headers: { "content-type": "application/json" } }
  )
}
// success path
deriveOutcome(...)
flushCanonicalLine(...)
```

The 401 envelope is byte-identical in both files.

**Action:**

- Add `runWithObservedRequest(req, verifier, handler):
  Promise<Response>` to `packages/server/src/observability/`,
  shaped to cover both adapters' needs (verifier dispatch +
  scope open + canonical-line flush).
- Both adapters call it and only contribute the bits that legitimately
  differ (storage handle construction, cache wrap on CF).
- Add a regression test asserting byte-identical 401 envelopes
  across both adapters (cross-references the F19 follow-up about
  error-envelope drift — same root cause).

---

## 3. Trim `CATEGORY` to the units that actually flush

`packages/server/src/observability/logger.ts:55-64` defines 8
categories (`auth`, `http`, `storage`, `writer`, `compactor`, `gc`,
`rebuild`, `maintenance`). `packages/server/src/observability/canonical.ts:59-66`
maps 6 Units to categories (no `auth`, no `storage`).

Canonical-line flushers across the repo emit only 5 categories:

- `http` — `packages/server/src/http/router.ts:184`,
  `packages/adapter-cloudflare/src/worker.ts:342,378`,
  `packages/adapter-node/src/server.ts:257,300`.
- `maintenance` — `packages/server/src/maintenance.ts:90`.
- `compactor` — `packages/server/src/compactor.ts:222`.
- `gc` — `packages/server/src/gc.ts:153`.
- `rebuild` — `packages/server/src/rebuild-index.ts:148`.

Three dead entries:

- `CATEGORY.auth` — referenced only inside `logger.ts` itself.
- `CATEGORY.writer` — appears in `UNIT_TO_CATEGORY` but no caller
  ever flushes `unit: "writer"`.
- `CATEGORY.storage` — used at
  `packages/server/src/observability/storage.ts:52` for DEBUG-level
  logger calls only (no canonical-line flush).

**Action:**

- Delete the `auth`, `writer`, `storage` entries from `CATEGORY`.
- Drop the `writer` entry from `UNIT_TO_CATEGORY`.
- Switch the `storage.ts:52` debug logger to `getLogger(CATEGORY.maintenance)`
  (debug events from the storage-observer always fire inside
  compactor/gc/rebuild scopes anyway).
- Re-emit the auth-warn path through `CATEGORY.http` (it's an HTTP
  401, not a separate category). This collapses cleanly because
  `runWithObservedRequest` (section 2) owns the flush.

---

## 4. Demote test-only metrics types out of the public surface

`packages/server/src/observability/index.ts` exports
`MetricsSnapshot`, `ObservationRow`, `MetricsSummary` (and
`RequestScopedMetricsRecorder.snapshot()`). Production reads via
`summarize()` only — the `snapshot()` accessor and its return types
are consumed only by the recorder's own tests
(`recorder.test.ts`, `context.test.ts`, `storage.test.ts`,
`canonical.test.ts`).

**Action:**

- Drop `MetricsSnapshot`, `ObservationRow`, `MetricsSummary` from
  the `observability/index.ts` re-export block.
- Mark `RequestScopedMetricsRecorder.snapshot()` `@internal`.
  Tests import it through a direct relative path
  (`../recorder.ts`) rather than the barrel.

---

## 5. Update the stale "dormant" barrel comment

`packages/server/src/observability/index.ts:1-24` opens with:

> Observability module — dormant. Nothing in @baerly/server's
> existing surface (Db, ServerWriter, the HTTP router, the
> maintenance loops) imports from here yet. Wiring lands in
> subsequent commits.

The wiring landed. The HTTP router (`router.ts:43,184`),
`maintenance.ts:24,90`, `gc.ts:63,153`, `compactor.ts:52,222`, and
`rebuild-index.ts:48,148` all import from this module. The CF
worker pulls in 12 named symbols; the Node adapter pulls in 12.

**Action:**

- Rewrite the comment to describe the module's actual role:
  request-scoped metric/log capture + canonical-line emission,
  consumed by the HTTP router, the maintenance loops, and both
  adapters.

---

## 6. Move `picocolors` dependency to `@baerly/dev` (optional)

`packages/server/src/observability/logger-pretty.ts:18` imports
`picocolors`, listed at `packages/server/package.json:59`
(`"picocolors": "^1.1.1"`). The kernel already dynamic-imports the
pretty sink only when `sink === "console-pretty"` (`logger.ts:173`),
so prod hot paths don't load it. But the dep is still in
`@baerly/server`'s `dependencies`, and the kernel-dep narrative in
CLAUDE.md lists "aws4fetch, idb-keyval, @xmldom/xmldom, hono/tiny"
as the runtime footprint — `picocolors` is the fifth.

Both adapters default to `console-json` in prod; only
`packages/adapter-node/src/server.ts:725`
(`isTty ? "console-pretty" : "console-json"`) selects pretty in dev
TTY.

**Action — pick one:**

- **(a)** Move `logger-pretty.ts` to `@baerly/dev`. The Node
  adapter's "pretty if TTY" decision moves to the adapter (or to
  the CLI's `baerly dev`). `@baerly/server` drops `picocolors`.
- **(b)** Keep the lazy import; just update CLAUDE.md to list
  `picocolors` as the fifth runtime dep and explain why
  (dev-TTY-only via dynamic import).

(a) is cleaner; (b) is one-line.

---

## Verification

After the workstream:

- `pnpm verify` — typecheck + lint pass.
- `pnpm test` — all default-project tests pass.
- `pnpm test:adapter-cloudflare` and `pnpm test:adapter-node` —
  both adapter request paths still produce a single canonical line.
- `pnpm test:http-conformance` — the cascade still passes.
- Manual: run `pnpm dev:storage`, scaffold a CF app, exercise
  `wrangler tail` once; confirm one canonical line per cron tick
  (not three).

## Out of scope

This workstream is purely about the observability scope-nesting,
adapter ceremony duplication, `CATEGORY` table trim, public-surface
demotions, and the stale barrel comment. The router-side error
helpers (`mapError`/`mapToResponse`/`jsonError`), the JWKS verifier
in `bearer-jwt.ts`, and the maintenance options surface
(`skipCompact`/`skipGc`, maintenance profiles, `CompactOptions` knobs)
are independent and tracked separately.
