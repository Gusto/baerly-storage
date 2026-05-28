---
title: Verifier function shape
audience: adr
summary: ADR 005 — auth lives on a single async `(Request) => Promise<VerifierResult | null>` seam. Records the three properties this shape upholds and the four rejected alternatives.
last-reviewed: 2026-05-28
tags: [decision, adr, auth]
related: [README.md, 001-tenant-cas-isolation.md, ../about/thesis.md]
---

# 005 — Verifier is a function, not a class hierarchy

## Status

Accepted (2026-05-28). Reframed from `docs/guide/auth.md`.

## Context

Auth in baerly happens at exactly one point: the dispatcher
boundary, before any `Storage` I/O. Two seams configure it:

- `config.auth` in `baerly.config.ts` (graduated postures: `"none"`,
  `"shared-secret"`).
- `verifier:` on the adapter factory — a `Verifier` value that
  silently overrides `config.auth` when present.

`Verifier` itself is a single async function:

```ts
type Verifier = (req: Request) => Promise<VerifierResult | null>;
```

This ADR records the three properties that shape upholds and the
four alternatives that were rejected.

## Decision

Auth is one function, not a class hierarchy, middleware chain, or
closed enum. Three properties had to hold:

1. **Platform-pure.** The kernel does not depend on `node:http`,
   `R2Bucket`, or any binding that only exists in one runtime. Auth
   lives on top of standard `globalThis.Request` so it works in
   Workers, Node 24+, Bun, Deno, and browsers without polyfill gates.
2. **Identity-shape-agnostic.** A JWT verifier wants to return the
   decoded claim set; a SigV4 verifier wants the IAM principal ARN;
   an IP allowlist verifier wants the matched IP. There is no honest
   common shape — `VerifierResult.identity` is `unknown` so preset
   factories stay sovereign over their payload. The kernel never
   reads the field.
3. **One commit point per request.** Auth is checked exactly once at
   the dispatcher boundary, before any `Storage` I/O. No middleware
   chain, no implicit context lookup, no second-decision late in the
   request lifecycle.

`null` is the canonical unauthenticated signal — the dispatcher maps
it to HTTP 401 + `BaerlyError{code:"Unauthorized"}`. A thrown
`BaerlyError` means "auth is broken" (operator problem — missing
env var, unreachable JWKS endpoint) and maps to 500. The null-vs-
throw split is deliberate so on-call paging policy can target
operator faults without false positives from credential-fishing
traffic.

`Verifier` is `async` because real preset factories all need at
least one async operation: JWKS rotation (`fetch(jwksUrl)` on cache
miss), SigV4 body hashing (`crypto.subtle.digest`), or RPC-based
IdP attestation. A sync contract would gate a class of factories on
a workaround.

The `tenantPrefix` derives from auth, not from the URL. A
URL-encoded tenant is a forgery surface; tenant-CAS isolation
guarantees rest on the verifier producing the right prefix — see
[ADR-001](001-tenant-cas-isolation.md).

## Rejected alternatives

- **Class hierarchy (`AbstractVerifier` + subclasses).** Classes do
  not tree-shake as cleanly as functions — a preset factory's
  prototype chain lands in every bundle that imports the type, and
  the Worker target is bundle-size-sensitive. Functions also
  collapse the most common test pattern ("stub a verifier that
  returns this fixed result") from a multi-line class subclass to
  one line.
- **Middleware chain.** Baerly's HTTP server is stateless — no
  request mutation, no implicit context lookup, no "earlier
  middleware set `req.tenant`". Auth is one literal decision point
  in `(Request) => Response`, not a chain ordering problem.
- **Closed enum + kernel-side dispatch.** Forces every new scheme
  into the kernel release cycle. Deployments that need a proprietary
  IdP, or any scheme not yet in the enum, would have to fork. The
  open-function shape lets a deployment author write its own
  `Verifier` against any scheme without touching
  `@gusto/baerly-storage` internals.
- **Multiple `Verifier`s with kernel-side composition.** The right
  composition policy depends on the deployment — some want "try CF
  Access first, fall back to shared-secret"; others want "require
  both an IP allowlist and a JWT." A future sugar package can ship
  `firstOf` / `allOf` without the kernel having to pick.

## Consequences

- Adding a new auth scheme is a function in user space — no kernel
  change, no release coupling.
- Composition (e.g. "JWT OR shared-secret") is user-side function
  composition. A future `@baerly/auth-compose` package may ship
  `firstOf` / `allOf` sugar; the kernel stays out of it.
- The `unknown` `identity` field is by design — discoverability of
  the field is via the preset's JSDoc, not the kernel's type.
