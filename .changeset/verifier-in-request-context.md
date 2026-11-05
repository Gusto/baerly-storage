---
"@gusto/baerly-storage": patch
---

The Node and Cloudflare adapters now run the `Verifier` inside the per-request observability context, so `getCurrentContext()` is defined for work the verifier does (for example a JWKS fetch). Responses, status codes and canonical log lines are unchanged.
