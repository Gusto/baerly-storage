---
"@gusto/baerly-storage": patch
---

Every `/v1/*` response from the HTTP router, including errors and `/v1/since`, now carries `Cache-Control: no-store`. The adapters' `/v1/spec` response also carries it because authenticated responses include collection and index names. An `Authorization` header already kept shared caches off these responses, but a cookie-authenticated session (for example behind Cloudflare Access) did not, so a shared cache could store one user's response.
