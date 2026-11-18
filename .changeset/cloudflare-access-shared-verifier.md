---
"@gusto/baerly-storage": patch
---

`cloudflareAccess` verifies the `Cf-Access-Jwt-Assertion` token directly instead of rebuilding the request, which cuts per-request CPU. Behavior is unchanged.
