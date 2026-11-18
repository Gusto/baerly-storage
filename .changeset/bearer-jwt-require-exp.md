---
"@gusto/baerly-storage": minor
---

`bearerJwt` and `cloudflareAccess` now reject a token that has no `exp` claim (RFC 9068 §2.2 makes `exp` required for access tokens). Before, jose checked `exp` only when present, so a token minted without one was accepted forever. Standard IdPs (Auth0, Okta, Azure AD, Keycloak, Cloudflare Access) always set `exp`; a custom token issuer that omits it now gets 401 on every request.

Both presets also refuse a negative or `NaN` `clockSkewMs` / `jwksCacheTtlMs`, and an infinite `clockSkewMs`, with `InvalidConfig` at construction. Before, a negative skew silently rejected valid tokens and an infinite one disabled the expiry check.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: a self-minted token without exp was accepted
const token = await new SignJWT({ tenant: "acme" }).setProtectedHeader({ alg: "ES256" }).sign(key);
// after: set an expiry on every token
const token = await new SignJWT({ tenant: "acme" })
  .setProtectedHeader({ alg: "ES256" })
  .setExpirationTime("15m")
  .sign(key);
```
