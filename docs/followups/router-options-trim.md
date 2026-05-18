# Router: collapse `CreateRouterOptions` to its production shape

**Severity: MEDIUM. No behaviour change in production.**

`packages/server/src/http/router.ts` carries options and code
paths that the two production adapters never use. After this
cleanup, `CreateRouterOptions` reduces to `{ db, sinceTimeoutMs?,
sincePollIntervalMs? }` — the actual production surface.

The request lifecycle in both adapters runs the verifier and
opens the observability scope *before* calling `createRouter`.
By the time the router runs, the request is fully tenant-pinned
and ambient-scoped; the router's "do auth and observability
yourself" options are unreachable from a real request.

Coherent workstream — bundle the four steps below or split as
convenient.

---

## 1. Delete the router-level verifier middleware

`packages/server/src/http/router.ts`:

- Option declaration: `CreateRouterOptions.verifier` (L75) +
  JSDoc bullet at L60-67.
- Middleware block: `app.use("/v1/t/*", verifier)` at L206-216.

Every production callsite passes `verifier: undefined`:

- `packages/adapter-cloudflare/src/worker.ts:354` — verifier
  was already called at L288 (resolves tenant, builds `Db`).
- `packages/adapter-node/src/server.ts:281` (inside
  `createFetchHandler`) — verifier was already called at L253.
- `packages/server/src/http/router.test.ts:24, 129, 186, 223`
  — defaulted.
- `tests/integration/http-conformance.test.ts:333`,
  `tests/integration/since-options.test.ts:9` — defaulted.

The only callsite that exercises the branch is
`packages/server/src/http/router.test.ts:290` — a single 401
shape regression: `verifier: async () => null`.

**Action:**

- Drop `CreateRouterOptions.verifier`, the JSDoc bullet, and
  the `app.use(...)` block at L206-216.
- Relocate the 401-shape test (`router.test.ts:283-298`) into
  `packages/adapter-node/src/server.test.ts` or
  `packages/adapter-cloudflare/src/worker.test.ts` — i.e.
  where the verifier actually runs in production.

---

## 2. Delete the `healthCheck` flag

`packages/server/src/http/router.ts`:

- Option: `CreateRouterOptions.healthCheck` (L76) + JSDoc bullet
  at L68-71.
- Dead route: `GET /v1/healthz` registration at L197-199.
- Short-circuit: 3 lines inside the observability middleware at
  L134-137.

Every production callsite passes `false`:

- `packages/adapter-cloudflare/src/worker.ts:356` and
  `packages/adapter-node/src/server.ts:283` —
  `healthCheck: false`. Both adapters already serve
  `/v1/healthz` themselves before `createRouter` runs
  (`worker.ts:278-283`, `server.ts:239-244`).
- `tests/integration/http-conformance.test.ts:333` —
  `healthCheck: false`.
- Other test fixtures take the default `true`.

**Action — pick one:**

- **(a)** Drop `healthCheck` and always-mount
  `GET /v1/healthz`. Adapters never reach the router's mount
  (they short-circuit first), so it's a no-op in production.
  Update the three test fixtures.
- **(b) [preferred]** Drop `healthCheck`, the in-router
  `/v1/healthz` route, *and* the short-circuit. Healthz becomes
  purely an adapter concern. Update the three test fixtures to
  point at adapter-level healthz (or drop the assertions if
  they were only testing the router's mount).

(b) is the cleaner endpoint; (a) is the smaller diff.

---

## 3. Extract Mode B observability into a helper

This one is **not delete-clean**. The agent traced both adapters
and confirmed:

- **Mode A** at `router.ts:143-145` is the pass-through that
  fires in production. Adapters open the observability scope
  with `createObservabilityContext` + `runWithContext` and flush
  the canonical line themselves (`worker.ts:315-320, :378`;
  `server.ts:248-270, :300`). When `getCurrentContext()` returns
  a value, the router just calls `next()`. **Keep this.**

- **Mode B** at `router.ts:147-194` creates an observability
  scope inline when no ambient one is present. Fires only for
  `router.test.ts` (the "observability middleware" suite at
  L82-200 and L265-275), `http-conformance.test.ts:333`, and
  `since-options.test.ts:9`. **Test-only.**

The split was deliberate: commit `7ce6579` (2026-05-16,
*refactor(server): router observability middleware is
ambient-context aware*) added Mode A so the adapter-owned
context wouldn't double-emit. Deleting Mode B outright would
break the standalone-test path.

**Action:**

- Lift Mode B into a `withHttpObservabilityScope(req, fetch)`
  helper in `packages/server/src/observability/` (next to
  `withObservability`, the maintenance-flavoured equivalent).
- Adapters keep their own scope-opening calls (no change).
- Standalone tests opt in by wrapping the router fetch in the
  new helper, replacing the implicit Mode B fall-through.
- After the helper lands, `createRouter` carries only Mode A
  pass-through (or nothing — every caller wraps its own scope).

This is a small refactor, not a deletion. Doing it as part of
the same workstream avoids leaving a half-trimmed router.

---

## 4. Delete `peekContext`

`packages/server/src/observability/canonical.ts:142`:

```ts
export const peekContext = (): ObservabilityContext | undefined =>
  getCurrentContext();
```

`getCurrentContext` is itself exported from the barrel.
`peekContext` has zero non-self callers
(`grep -rn "peekContext" packages/ tests/ examples/ manual-e2e/`
returns only the definition + barrel re-export at
`packages/server/src/observability/index.ts:54`).

**Action:**

- Delete the definition.
- Delete the barrel re-export.

---

## Verification

After the workstream:

- `pnpm verify` — typecheck + lint pass.
- `pnpm test` — all default-project tests pass.
- `pnpm test:adapter-cloudflare` and `pnpm test:adapter-node`
  — verify both adapter request paths still produce the
  canonical line (the flush is in the adapter, not the router).
- `pnpm test:http-conformance` — the cascade still passes.

## Out of scope

This workstream is purely about `CreateRouterOptions` and the
single observability export `peekContext`. Other server-periphery
cleanups (JWKS over-engineering in `bearer-jwt.ts`, the
`dev-landing.ts` HTML literal, maintenance / observability scope
nesting, maintenance-profile reduction, observability subpath
collapse) are independent and untouched here.
