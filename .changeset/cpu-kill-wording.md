---
"@gusto/baerly-storage": patch
---

The fold-ceiling warnings (the deferred-fold warning and the Cloudflare `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` init warning) and the related `BaerlyEnv` docs now describe the configured ceilings as conservative budgets: a larger fold may exceed an invocation's CPU or memory resources, rather than being asserted to be CPU-killed. Ceilings and behavior are unchanged.
