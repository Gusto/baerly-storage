---
"@gusto/baerly-storage": minor
---

**Breaking for raw HTTP callers:** `POST`, `PATCH` and `PUT` now require `Content-Type: application/json` (or a `+json` type such as `application/merge-patch+json`; parameters such as `charset` are allowed). A missing type or any other type, including `text/plain` and `application/x-www-form-urlencoded`, gets `415` with the new `UnsupportedMediaType` error code, before the body is read. Those types make a CORS-simple request, which a page on another origin can send without a preflight, so under ambient auth (`auth: "none"` on localhost or an intranet, or Cloudflare Access cookie sessions) another site could forge inserts. `createBaerlyClient` and the React hooks already send the header, so SDK callers need no change; add `-H "Content-Type: application/json"` to `curl -d` scripts.
