---
"@gusto/baerly-storage": minor
---

Cloudflare scheduled maintenance budgets: `CLOUDFLARE_PAID_TIER` bounds its compact tail probe, and `CLOUDFLARE_FREE_TIER` fits one `runScheduledMaintenance()` call on Workers Free with the R2 binding.

The documented per-pass maxima now count every storage call (GETs and each LIST page) against the per-invocation request limits: 900 calls through the R2 binding and 45 through `fetch` on Workers Free, 9,000 on Workers Paid. With `CLOUDFLARE_FREE_TIER`, a pass is at most: compaction 49 calls (147 with every call retried), GC 22 (66), log retirement 23 (69), and one `runScheduledMaintenance()` pass 94 (282).

- **Workers Free with the R2 binding:** one `runScheduledMaintenance(target, { tier: "cf-free" })` call per invocation now fits the request limit (Free CPU stays best effort). The even/odd-minute alternation of direct `compact()` and `runGc()` calls is no longer required there.
- **Storage over `fetch` under `cf-free`:** a whole pass does not fit the 45 calls. Workers Free with S3 is not a supported host; S3 on Workers needs Paid with `cf-paid`.
- **Workers Paid:** `CLOUDFLARE_PAID_TIER` now walks at most 1,000 log slots to find the tail per compaction pass. Before, a pass behind a stale `tail_hint` could need up to 100,000 GETs, which the request limit refuses; now it returns `skippedReason: "probe-budget-checkpointed"` or folds a slice, and the next pass resumes. Worst case per pass is 1,204 calls (3,612 retried).

The tiers are now selected with `tier`, as described in the entry of this release where `/maintenance` "exports one function":

```ts
const target = { storage, app, tenant, collection };
// Workers Free + R2 binding, or Workers Paid: one call per invocation
await runScheduledMaintenance(target, { tier: "cf-free" }); // or "cf-paid"
```
