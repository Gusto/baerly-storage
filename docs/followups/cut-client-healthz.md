# Cut `BaerlyClient.healthz()`

**Severity: MEDIUM. Pre-launch cut. Load-balancer/k8s-probe
ceremony for an audience that doesn't run load balancers.**

`BaerlyClient.healthz()` is a one-line wrapper over `GET /v1/healthz`
that swallows errors and returns `boolean`. Documented as a
"convenience liveness probe."

- `/Users/eric.baer/workspace/baerly-storage/packages/client/src/client.ts:271,310-328`

## The case for cutting

This is borrowed-maturity ops ceremony. The audience builds
dashboards, internal trackers, side projects (thesis §"Audience
in practice") — they never write liveness checks. That's
load-balancer / Kubernetes / Datadog territory (graduation-tier
workload in the deferred changes-iterator memo's language).

The pattern also fails ADR-002's redundant ceremony test: an
LLM-authored CRUD app will never reach for it, and a sophisticated
operator who *does* want it writes two lines of raw `fetch` and
gets better error semantics than `boolean`.

The server endpoint `/v1/healthz` may still be useful (CF
provisioning checks, deploy smoke tests) — that's not what's being
cut. What's being cut is the typed client wrapper.

## What to do

1. Delete `BaerlyClient.healthz()` from the interface + impl in
   `packages/client/src/client.ts`.
2. **Keep** the `/v1/healthz` HTTP route — useful for deploy
   smoke tests and CF provisioning.
3. Audit `@example` JSDoc blocks for any `client.healthz()`
   reference.
4. Audit `manual-e2e/` — if it uses `client.healthz()`, switch
   to raw `fetch`.

## What gets harder after

- A user who wanted "is the server reachable" with one method
  call writes `await fetch("/v1/healthz").then(r => r.ok)` —
  two lines, better error handling. **Acceptable.**

## Related cuts

- Part of the **client public surface discipline** theme. Pairs
  with `cut-client-options-redundant-paths.md` and
  `cut-client-mockfetch.md`.
