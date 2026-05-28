---
title: Browser → server auth
audience: integrator
summary: Cross-cutting four-quadrant analysis of the SPA → API auth seam (dev/prod × Cloudflare/Node) — synthesis first, hardened per-quadrant recipes live in scaffold AGENTS.md files.
last-reviewed: 2026-05-28
tags: [client, auth, integration]
related: ["./auth.md", "../adr/005-verifier-function-shape.md"]
---

# Browser → server auth

baerly's design center is "trusted multi-instance, browser is a
typed HTTP client." The browser sends `/v1/*` HTTP requests; the
server runs the verifier and pins the tenant. This page is the
synthesis: why the seam is shaped the way it is, what the four
quadrants share, and where they diverge. The per-quadrant *recipes*
— code blocks for `vite.config.ts`, `src/server/index.ts`,
`baerly.config.ts` — are in each scaffold's `AGENTS.md` →
"Going to production" so they ship hardened next to the code they
configure.

## Why every quadrant defaults to `auth: "none"`

The scaffolds ship `auth: "none"` in `baerly.config.ts` so day-1
hits `/v1/*` with no `Authorization` header and every request
resolves to `config.tenant`. This is the same default across all
four quadrants for one structural reason: the most common
beginner failure mode in this category is "paste `SHARED_SECRET`
into a `VITE_*` env var thinking the leading `VITE_` makes it
private." A non-zero default credential at scaffold time invites
that mistake. `auth: "none"` makes the first happy path work
without any credential at all; the dev→prod transition is then a
deliberate flip rather than an undefended initial state.

## The four-quadrant matrix

|           | Cloudflare target                                                                       | Node target                                                                              |
| --------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Dev**   | `auth: "none"` default. No bearer injection — SPA hits `/v1/*` plain.                  | `auth: "none"` default. No bearer injection — SPA hits `/v1/*` plain.                   |
| **Prod**  | **Pattern A** — `cloudflareAccess` verifier resolved from CF Access JWT cookie         | **Pattern C** — `bearerJwt` verifier over JWKS, token minted by your OIDC IdP            |
| **Shared-secret (either + dev)** | **Pattern B** — `auth: "shared-secret"` + `baerlyDevAuth` in `vite.config.ts` for browser calls | **Pattern B** — `auth: "shared-secret"` + `SHARED_SECRET` in `.env` |

Pattern A and Pattern C are the production-fit shapes — they take a
real identity from a real IdP. Pattern B is the server-to-server
shape (CI, cron, internal services) and the only shape where dev
needs a special Vite plugin (`baerlyDevAuth`) to inject the bearer
server-side for browser calls. **Pattern B is never for end-user
browser auth in prod.**

## What changes at the dev→prod flip

The Cloudflare and Node targets handle the transition with the same
seam — the factory `verifier:` argument silently overrides
`config.auth` when present. The recipe shape: keep
`auth: "none"` in `baerly.config.ts`, gate the `verifier:` override
on a production-only env var (e.g. `CF_ACCESS_TEAM_DOMAIN` for CF,
`JWKS_URL` for Node), spread the override conditionally. Dev sees
the env var as `undefined`, the spread short-circuits, and
`auth: "none"` runs. Prod sees the env var set and the override
engages. Same code artifact ships to dev and prod.

This is structurally the same shape as the
`process.env.NODE_ENV === "production"` branch — but driven off a
specific env var that *causes* the production behavior rather than
a label that *describes* the environment. The result is harder to
misconfigure: there's no way to "be in prod" without the bearer
trust chain being wired up.

## The one invariant

**Never put `SHARED_SECRET` in the SPA bundle**, in
`import.meta.env.*`, in build-time env vars, or in static assets.
The shared-secret posture is for server-to-server callers only.
For browser → server auth in prod, use Pattern A (CF) or Pattern C
(Node). The dev-mode `baerlyDevAuth` plugin injects the bearer
*server-side* in the Vite middleware specifically so the SPA can
keep its plain `Authorization`-less `fetch()` calls and the secret
stays out of the bundle even during dev.

If a code review ever surfaces a `SHARED_SECRET` import in any
`src/web/**` file, that's a security defect, not a style issue —
the secret is now in every visitor's browser the moment the SPA
loads.

## Where the per-quadrant recipes live

Open the scaffold matching your target and posture; jump to the
"Going to production" section:

- Cloudflare + Pattern A or B: `examples/minimal-cloudflare/AGENTS.md` or `examples/react-cloudflare/AGENTS.md`.
- Node + Pattern B or C: `examples/minimal-node/AGENTS.md` or `examples/react-node/AGENTS.md`.

The recipes are hardened against real agent usage and stay byte-
identical across paired scaffolds (the drift fence in
`tests/integration/agents-md-drift.test.ts` enforces this). Read
those for code; read this file when you need to understand *why*
the seam is shaped this way before making a non-default decision.
