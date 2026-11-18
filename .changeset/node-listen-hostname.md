---
"@gusto/baerly-storage": minor
---

`baerlyNode().listen(port, { hostname })` binds a single address, for example `"127.0.0.1"` to accept loopback connections only. Without `hostname`, `listen(port)` still binds every interface. The new `BaerlyNodeListenOptions` type is exported from `@gusto/baerly-storage/node`.
