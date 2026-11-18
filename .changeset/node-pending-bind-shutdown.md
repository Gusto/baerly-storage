---
"@gusto/baerly-storage": patch
---

Wait for a pending hostname bind during `baerlyNode().close()` so the listener cannot remain open after shutdown.
