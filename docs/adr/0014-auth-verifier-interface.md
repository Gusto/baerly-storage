# 0014 — Auth as a `Verifier` interface

## Status

Accepted. Referenced as a forward dependency by
[ADR-0006](./0006-server-component.md), and by the tenancy isolation
discussion in [ADR-0011](./0011-cas-scope.md) and
[ADR-0018](./0018-tenant-cas-isolation.md).

## Context

The Phase 6 server component (`@baerly/server`, established by
[ADR-0006](./0006-server-component.md)) is a portable
`(Request) => Response` handler. To be deployable in any non-trivial
production scenario it needs an auth seam: an answer to "given this
`Request`, what tenant prefix may it touch, and who is it?"

baerly intentionally supports multiple production auth schemes — at
minimum Cloudflare Access JWTs, generic bearer JWTs, AWS IAM SigV4,
shared-secret HMAC, and IP allowlist — across multiple runtimes (CF
Workers, Node, Lambda, Bun, Deno, Fly). That is a five-by-six matrix
of combinations the kernel cannot maintain. Every additional class in
that matrix doubles the surface area of conformance tests, the
documentation burden, and the per-runtime polyfill audit. The kernel
is small on purpose; the auth surface has to be smaller still.

Forward-references in
[`packages/protocol/src/errors.ts`](../../packages/protocol/src/errors.ts)
(reserved `MPS3ErrorCode.Unauthorized`),
[`packages/server/src/contract.ts`](../../packages/server/src/contract.ts)
(both the `Routes` JSDoc — "the `tenant` derives from the
`Verifier`'s output, not the URL" — and the `HttpStatus` table
mapping 401 to `code:"Unauthorized"` and 403 to `code:"AccessDenied"`),
and the JSDoc on both adapter entry points
([`adapter-node/src/server.ts`](../../packages/adapter-node/src/server.ts),
[`adapter-cloudflare/src/worker.ts`](../../packages/adapter-cloudflare/src/worker.ts))
have committed the codebase to a single auth shape since earlier
phases. They all imply the same contract: one function, one answer
per request, tenant prefix flows out of auth and not the URL. This
ADR is the receipt for those commitments.

Three properties have to hold for the seam to fit the rest of the
kernel:

1. **Platform-pure.** The protocol kernel does not depend on
   `node:http`, `R2Bucket`, `IncomingMessage`, or any binding that
   only exists in one runtime. Auth has to live on top of standard
   `globalThis.Request` so it works in Workers, Node 24+, Bun, Deno,
   and browsers without polyfill gates.
2. **Identity-shape-agnostic.** A JWT verifier wants to return the
   decoded claim set. A SigV4 verifier wants to return the IAM
   principal ARN. An IP allowlist verifier wants to return the
   matched IP. There is no honest common shape across those — picking
   "a string" loses claim structure, picking "a JWT claim set"
   excludes SigV4. The kernel cannot commit to a shape it would have
   to break to add a scheme.
3. **One commit point per request.** Auth is checked exactly once, at
   the dispatcher boundary, before any `Storage` I/O. No middleware
   chain, no implicit context lookup, no second-decision late in the
   request lifecycle. The dispatcher gets one `(tenantPrefix,
   identity)` pair and proceeds.

## Decision

Define one type in `@baerly/protocol`:

```ts
type Verifier = (req: Request) => Promise<VerifierResult | null>;

interface VerifierResult {
  readonly tenantPrefix: string;
  readonly identity: unknown;
}
```

A `Verifier` is a function from a `Request` to either a success
result or `null`. `null` is the canonical unauthenticated signal; the
Phase 6 HTTP dispatcher maps `null` to HTTP 401 +
`MPS3Error{code:"Unauthorized"}`. A truthy `VerifierResult` carries
the `tenantPrefix` the request is authorized to touch and an opaque
`identity` payload.

The Phase 6 HTTP dispatcher (ticket 25,
`packages/server/src/dispatcher.ts` when it lands) accepts an
optional `options.verifier?: Verifier`. When set, every request is
verified before any `Storage` I/O. On a successful result, the
dispatcher performs a **scope check**: the URL-derived target must
fall within the physical prefix
`app/<app>/tenant/<tenantPrefix>/...`. Anything outside that prefix
is rejected with HTTP 403 + `MPS3Error{code:"AccessDenied"}`. Once
the scope check passes, the dispatcher constructs
`Db.create({ storage, app, tenant: tenantPrefix })` and dispatches
the route. Per [ADR-0011](./0011-cas-scope.md) and
[ADR-0018](./0018-tenant-cas-isolation.md), the tenant prefix is
load-bearing for CAS isolation, so producing it correctly is
load-bearing for tenancy.

Preset factories — `cloudflareAccess`, `bearerJwt`, `awsIamSigV4`,
`sharedSecret`, `allowlistIp` — ship in Phase 8 with the deploy
scaffold, not in the kernel. Each preset is tied to a specific IdP
and runtime idiom (e.g. `bearerJwt` pulls `jose`; CF Workers users
should not pay that cost) and gets its own ADR when it lands. The
protocol kernel only owns the contract.

`identity` is `unknown` so each preset factory commits to its own
shape; the dispatcher never reads the field. Application code that
wants the identity narrows it at the use site, off a request context
the dispatcher attaches (the attachment mechanism is ticket 25's
call, not this ADR's).

`Verifier` is async because real preset factories need `await`:
JWKS rotation, RPC-based IdPs, SigV4 body hashing, IP-block table
lookups. Synchronous would gate a class of preset factories before
they land.

## Consequences

- The kernel stays platform-pure. `verifier.ts` has no imports;
  `Request` resolves out of `lib: ["esnext"]` in `tsconfig.json` and
  is the same shape in every supported runtime. No `node:http`, no
  `R2Bucket`, no per-runtime polyfill audit.
- `identity: unknown` keeps preset factories sovereign over their
  payload. A future SigV4 factory returning an IAM principal ARN, a
  bearer-JWT factory returning a decoded claim set, and an IP
  allowlist factory returning the matched address can all coexist
  without forcing a `Box<T>` discriminant on the kernel.
- A `Verifier` is testable in one line: `const v: Verifier = async ()
  => ({ tenantPrefix: "t", identity: null });`. The HTTP conformance
  suite (ticket 28) fixtures use exactly this pattern. No
  constructor convention, no `new`, no class-shape boilerplate.
- The 401-vs-403 split lives in the dispatcher, not in the Verifier.
  Test fixtures return raw `VerifierResult | null` without needing
  an HTTP layer. The discriminant convention per
  [ADR-0003](./0003-error-code-discriminant.md) means dispatcher
  catches `MPS3Error` and switches on `.code` to pick the status:
  `Unauthorized` → 401, `AccessDenied` → 403, `InvalidConfig` from
  `Db.create` (a Verifier bug producing a `/`-containing prefix) →
  500 + `Internal`.
- `tenantPrefix` derives from auth, not from the URL. This is a
  security improvement on its own — a URL-encoded tenant is a
  forgery surface — and it composes cleanly with
  [ADR-0011](./0011-cas-scope.md)'s per-collection CAS scope and
  [ADR-0018](./0018-tenant-cas-isolation.md)'s tenant isolation
  guarantees. The auth layer is the source of truth for tenancy;
  routing only ever consumes it.
- The null-vs-throw split is deliberate. `null` is "auth said no"
  (client problem → 401); a thrown `MPS3Error` is "auth is broken"
  (operator problem — missing env var, unreachable JWKS endpoint →
  500). The dispatcher distinguishes these so that on-call
  paging-policy can target the second class without false positives
  from credential-fishing traffic.
- The kernel's bundle does not grow. The Verifier type is
  type-erased at compile time; the only runtime cost lands in
  whichever preset factory the deployment chooses.
- Reversing this decision means changing the contract for every
  Phase 8 preset factory simultaneously, plus the dispatcher
  integration in ticket 25. The cost of revision climbs with each
  preset; this ADR is one of the load-bearing reasons Phase 6 ticket
  23 is first in the Phase 6 cluster.

## Alternatives Considered

### Class hierarchy (`AbstractVerifier` + subclasses)

Define an abstract class with a `verify(req): Promise<VerifierResult
| null>` method and require every preset factory to extend it.

Rejected for three reasons. First, classes do not tree-shake as
cleanly as functions: a preset factory shipped in a Phase 8 package
would force its prototype chain into every bundle that imports the
type, even if the bundle never instantiates the class. The Worker
target is bundle-size-sensitive enough that this matters. Second, a
class forces a constructor convention — `new CloudflareAccess({ ...
})` — that has to be memorized per scheme and is harder to compose
with `async` factories that need to read env vars at construction
time. Third, the most common test pattern — "stub a verifier that
returns this fixed result" — is one line as a function (`const v:
Verifier = async () => fixedResult`) and three or four lines as a
class subclass. The kernel optimizes for the test pattern.

### Middleware chain (Express/Hono `use`)

Let each auth scheme ship as a middleware that mutates the request
(`req.user = ...`) and short-circuits with a 401 on failure. Multiple
middlewares compose by ordering — auth, then rate-limit, then
tenant-resolve, etc.

Rejected because baerly's HTTP server is intentionally stateless.
There is no request mutation, no implicit context lookup, no
"earlier middleware set `req.tenant`" pattern. Auth is one decision
point in the dispatcher's `(Request) => Response` job; mixing it
with logging, rate-limiting, and request-context decoration via
middleware ordering makes the auth boundary harder to audit. The
`Verifier` function form keeps the decision point literal: one
`await`, one branch, no chain. Middleware chains also tend to grow
per-runtime adapters (an Express middleware does not work in a
Worker without porting); a plain function works in every supported
runtime without a shim.

### Enum + dispatcher (`type AuthScheme = "jwt" | "sigv4" | ...`)

Ship a closed enum of supported schemes plus a kernel-side
`dispatchAuth(scheme, req)` function. Adding a new scheme is a kernel
change.

Rejected because closing the enum forces every new auth scheme into
the kernel release cycle. A deployment that needs to support a
proprietary IdP — or an off-the-shelf scheme not yet in the enum —
has to fork the kernel or wait for a release. The open-function
shape lets a deployment author write its own `Verifier` against any
scheme it wants without touching `@baerly/protocol`. The kernel
owns the contract; the deployment owns the implementation.

### Branded `TenantPrefix` type

Define `type TenantPrefix = Branded<string, "TenantPrefix">` (per
[ADR-0002](./0002-branded-types.md)) and require every Verifier to
return a `TenantPrefix`-branded value. Branding would compile-time-
prevent passing a raw string into `Db.create({ tenant })`.

Rejected for two reasons. First, the kernel already validates the
prefix at the consumer boundary: `Db.create` enforces that `tenant`
is non-empty and contains no `/` (the key-segment separator). The
brand would force every Phase 8 preset factory to call an
`asTenantPrefix(...)` constructor helper for zero real safety win —
the validation runs either way. Second, the existing pattern in
`@baerly/protocol` is "validate at the consumer, not the producer"
for `app` and `tenant` strings (see `Db.create` in
`packages/server/src/db.ts`). Branding here would diverge from that
convention for one field. If the future shows that the brand
materially reduces bugs, a major-version bump can add it without
breaking the prefix's runtime shape.

### Sync `Verifier` (no `Promise`)

Define `type Verifier = (req: Request) => VerifierResult | null` and
require all auth checks to be synchronous.

Rejected because realistic preset factories all need at least one
async operation in the request path: JWKS rotation
(`fetch(jwksUrl)` on cache miss), SigV4 body hashing
(`crypto.subtle.digest(...)` returns a `Promise`), RPC-based IdP
attestation. A sync contract would gate every one of those factories
on a workaround and would be a breaking change to introduce later.
Async is the right default; factories that genuinely have nothing to
await return `Promise.resolve(...)`.

### Multiple `Verifier`s with composition in the kernel

Let the dispatcher accept an array of `Verifier`s and try each in
order. Rejected because the right composition policy depends on the
deployment — some sites want "try CF Access first, fall back to
shared-secret"; others want "require both an IP allowlist and a
JWT." The kernel cannot pick one without picking against the other.
A Phase 8 sugar package can ship `firstOf(...)`, `allOf(...)`, or
any other composition pattern without the kernel having to know
about them.

## References

- Parent: [ADR-0006](./0006-server-component.md) — establishes
  `@baerly/server` and forward-references this ADR.
- Tenancy: [ADR-0011](./0011-cas-scope.md) and
  [ADR-0018](./0018-tenant-cas-isolation.md) — the
  `tenantPrefix` returned by a Verifier is the key the tenant-CAS
  isolation guarantees rest on.
- Branding: [ADR-0002](./0002-branded-types.md) — the convention
  against which the `TenantPrefix` rejection is argued.
- Error model: [ADR-0003](./0003-error-code-discriminant.md) — the
  401/403/500 mapping is by `MPS3Error.code`, not class hierarchy.
