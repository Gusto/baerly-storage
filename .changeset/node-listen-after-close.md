---
"@gusto/baerly-storage": patch
---

`baerlyNode().listen()` now rejects with `InvalidConfig` after `close()` instead of binding a server that nothing would ever close.
