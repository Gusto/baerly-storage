---
"@gusto/baerly-storage": patch
---

A `Verifier` that throws no longer rejects the request handler with no log line. A thrown `BaerlyError` now answers with its own mapped status and error envelope (for example `NetworkError` from a failed JWKS fetch is a retriable 502, never a 401), any other throw answers an enveloped 500 `Internal`, and each emits exactly one canonical log line. Returning `null` still answers 401.
