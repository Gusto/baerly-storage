---
"@gusto/baerly-storage": patch
---

`cloudflareAccess` now replaces an `Authorization` header the app sent itself with the Cloudflare Access token, instead of appending to it. Before, an app that also sent `Authorization` got a 401 for a valid Access session.

`cloudflareAccess` refuses a `teamDomain` that is not a bare team name (lowercase letters, digits and `-`, such as `acme`) with `InvalidConfig` at construction, so a stray `/`, `@`, `.` or `:` can't point the JWKS fetch at another host. A full host such as `acme.cloudflareaccess.com` never verified a token, and now fails at startup instead. The `baerly` CLI config loader and `baerly doctor` apply the same rule to `cloudflareAccess.teamDomain`.

On Node, the `auth: "none"` startup line is logged with `console.warn` when the process looks deployed (`NODE_ENV=production` or a known PaaS marker), and says that every request gets full access to the configured tenant. Nothing is refused; local runs and Workers keep the info line.

The `bearerJwt` and `cloudflareAccess` docs now say `tenantClaim` must name a claim only an IdP admin can set.
