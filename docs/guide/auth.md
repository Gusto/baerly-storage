---
title: Authentication
audience: operator
summary: "Built-in Verifier presets (shared secret, bearer JWT, CF Access, AWS SigV4, IP allowlist), tenant pinning, and the authorization caveat."
last-reviewed: 2026-05-13
tags: [auth, operations]
related: ["../adr/001-tenant-cas-isolation.md", "../contributing/extending.md"]
---

# Authentication

`@baerly/server/auth` ships five `Verifier` presets. Each one
authenticates the caller and returns a `tenantPrefix`, which the
server uses to pin the request to one tenant's keyspace.

- `sharedSecret` — `Authorization: Bearer <secret>` with
  constant-time compare. Single-tenant; the simplest preset to
  stand up.
- `bearerJwt` — JWT over JWKS with `iss` / `aud` / `alg` allowlist;
  reads the tenant from a configurable claim.
- `cloudflareAccess` — thin shim over `bearerJwt` that consumes
  CF Access's `Cf-Access-Jwt-Assertion` header.
- `awsIamSigV4` — verifies SigV4-signed requests against a list of
  IAM principals; each principal pins one tenant.
- `allowlistIp` — CIDR-based source-IP allowlist for use behind a
  trusted proxy. Compose with `sharedSecret` / `bearerJwt` via
  `andAll` for defense in depth.

Source:
[`packages/server/src/auth/presets/`](../../packages/server/src/auth/presets/).

## Why a `Verifier` function?

The auth seam is one function, not a class hierarchy, middleware
chain, or closed enum. Three properties had to hold:

1. **Platform-pure.** The kernel does not depend on `node:http`,
   `R2Bucket`, or any binding that only exists in one runtime. Auth
   lives on top of standard `globalThis.Request` so it works in
   Workers, Node 24+, Bun, Deno, and browsers without polyfill
   gates.
2. **Identity-shape-agnostic.** A JWT verifier wants to return the
   decoded claim set; a SigV4 verifier wants the IAM principal ARN;
   an IP allowlist verifier wants the matched IP. There is no honest
   common shape — `VerifierResult.identity` is `unknown` so preset
   factories stay sovereign over their payload. The kernel never
   reads the field.
3. **One commit point per request.** Auth is checked exactly once,
   at the dispatcher boundary, before any `Storage` I/O. No
   middleware chain, no implicit context lookup, no second-decision
   late in the request lifecycle.

`null` is the canonical unauthenticated signal; the dispatcher maps
it to HTTP 401 + `BaerlyError{code:"Unauthorized"}`. A thrown
`BaerlyError` means "auth is broken" (operator problem — missing
env var, unreachable JWKS endpoint) and maps to 500. The
null-vs-throw split is deliberate so on-call paging policy can
target operator faults without false positives from
credential-fishing traffic.

`Verifier` is `async` because real preset factories all need at
least one async operation: JWKS rotation (`fetch(jwksUrl)` on cache
miss), SigV4 body hashing (`crypto.subtle.digest`), or RPC-based
IdP attestation. A sync contract would gate a class of factories
on a workaround.

The `tenantPrefix` derives from auth, not from the URL. A
URL-encoded tenant is a forgery surface; tenant-CAS isolation
guarantees rest on the verifier producing the right prefix — see
[ADR-001](../adr/001-tenant-cas-isolation.md).

### Rejected alternatives

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
  `Verifier` against any scheme without touching `@baerly/server` internals.
- **Multiple `Verifier`s with kernel-side composition.** The right
  composition policy depends on the deployment — some want "try CF
  Access first, fall back to shared-secret"; others want "require
  both an IP allowlist and a JWT." A future sugar package can ship
  `firstOf` / `allOf` without the kernel having to pick.

## Authorization

Beyond tenant pinning, there is no built-in authorization — an
authenticated caller can read and write anything under their
tenant prefix, including the manifest. Use-cases that need finer
policy (per-collection ACLs, row-level rules, manifest-change
validation) wrap `createListener` in a server they control and
enforce policy before passthrough. If you're using S3 + IAM
directly, scope STS tokens to a sub-path per user/team.
