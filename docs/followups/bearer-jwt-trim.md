# `bearerJwt`: drop the dead WeakMap memo and the speculative kid-miss rate limit

**Severity: LOW. No behaviour change in production.**

`packages/server/src/auth/bearer-jwt.ts` (the JWKS-backed Verifier
preset) ships three layered defenses around the JWKS fetch path:

1. `inflight` deduplication of concurrent refreshes (`bearer-jwt.ts:163-221`).
2. TTL-based cache + stale-on-failure fallback (`bearer-jwt.ts:223-235`).
3. Per-minute rate-limiting on kid-miss-triggered refreshes
   (`bearer-jwt.ts:237-247, 289-292`).
4. A per-request `WeakMap<Request, Promise<VerifierResult | null>>`
   memoizer (`bearer-jwt.ts:249-257`).

The verifier is called exactly once per request. Three call sites,
all `await verifier(req)` immediately before `next()`:

- `packages/server/src/http/router.ts:209`
- `packages/adapter-node/src/server.ts:253`
- `packages/adapter-cloudflare/src/worker.ts:288`

The WeakMap memoizer has no real cache hits; commit `e3dca0b
feat(server): add bearerJwt JWKS-backed Verifier preset` introduced
all four layers in one shot — no incident in the visible history.
Speculative defense, not load-bearing.

The kid-miss rate-limit (`JWKS_REFRESH_RATE_LIMIT_MS` +
`lastKidMissRefreshAt`) is similarly speculative: it guards
against a thundering-herd-of-unknown-kids workload that no real
caller has been observed to produce.

---

## 1. Drop the per-request WeakMap memoizer

`packages/server/src/auth/bearer-jwt.ts:249-257`:

```ts
const inflightVerifications = new WeakMap<Request, Promise<VerifierResult | null>>();
```

**Action:**

- Delete the WeakMap declaration (L249-257 or wherever the
  current state field lives).
- Delete the route that checks/sets the memo inside the
  exported verifier closure.
- Tests that rely on "calling the verifier twice with the same
  Request returns the same promise" (if any — verify
  `packages/server/src/auth/bearer-jwt.test.ts`) can be removed
  or rewritten.

---

## 2. Drop the kid-miss rate limit (optional)

`packages/server/src/auth/bearer-jwt.ts:237-247, 289-292`:

The kid-miss refresh path triggers a JWKS reload when an incoming
token's `kid` isn't in the cached key set, gated by a per-minute
rate limit (`JWKS_REFRESH_RATE_LIMIT_MS` + `lastKidMissRefreshAt`).

**Action — pick one:**

- **(a)** Drop both the kid-miss refresh and its rate limit.
  Key rotation is rare; the existing TTL refresh + `stale-on-failure`
  fallback covers it. Re-introduce when a caller asks.
- **(b) [preferred]** Keep the kid-miss refresh but drop the
  rate-limit accounting (`lastKidMissRefreshAt` + the check at
  L237-247). The `inflight` dedup already prevents the
  thundering-herd worst case. One less piece of state.

(a) is more aggressive; (b) keeps the operational property
(transparent key rotation) without the speculative rate limit.

---

## What stays

- `inflight` deduplication — covers genuine concurrent-request
  refresh, real on cold start.
- TTL cache + `stale-on-failure` fallback (`ensureFresh` at L223-235)
  — keeps the IdP outage tolerable.

---

## Verification

After the workstream:

- `pnpm verify` — typecheck + lint pass.
- `pnpm test` — all default-project tests pass, including
  `packages/server/src/auth/bearer-jwt.test.ts`.
- Manual: in dev, point a CF Worker at a JWKS endpoint, hit it
  under concurrent load, confirm one fetch (not N).
- Manual: rotate the JWKS keys mid-flight (if section 2(b)
  retained kid-miss refresh), confirm a fresh fetch lands on
  the first miss.

## Out of scope

This workstream is purely the over-engineered layers of
`bearer-jwt.ts`. The `Verifier` interface itself, the
`sharedSecret` preset, and other auth presets (`cloudflareAccess`,
`singleTenantDevVerifier`) are unaffected.
