---
"@gusto/baerly-storage": patch
---

`baerlyNode().listen(port)` now binds the HTTP server once. It previously started a bind on `0.0.0.0:0` and then re-listened on `port`, which worked only because the second call won a race with the first. The bound address is unchanged.
