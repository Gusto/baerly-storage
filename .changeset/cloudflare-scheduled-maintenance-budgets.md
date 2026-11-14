---
"@gusto/baerly-storage": minor
---

Cloudflare scheduled maintenance budgets: `CLOUDFLARE_PAID_TIER` bounds its compact tail probe, and `CLOUDFLARE_FREE_TIER` fits one `runScheduledMaintenance()` call on Workers Free with the R2 binding.

The documented per-pass maxima now count every storage call (GETs and each LIST page) against the per-invocation request limits: 900 calls through the R2 binding and 45 through `fetch` on Workers Free, 9,000 on Workers Paid. With `CLOUDFLARE_FREE_TIER`, a pass is at most: compaction 49 calls (147 with every call retried), GC 22 (66), log retirement 23 (69), and one `runScheduledMaintenance()` pass 94 (282).

- **Workers Free with the R2 binding:** one `runScheduledMaintenance(args, CLOUDFLARE_FREE_TIER)` call per invocation now fits the request limit (Free CPU stays best effort). The even/odd-minute alternation of direct `compact()` and `runGc()` calls is no longer required there.
- **Workers Free with S3 over HTTP:** keep alternating the direct phases, one per invocation. A scheduled compact whose `tail_hint` is about 20 or more entries stale does not fit the 45 calls: its 46th call, a log GET, is refused before anything is written, so every later pass stops at the same point. The in-band write tick, which folds after a few writes on this host, is what keeps the pending tail short there.
- **Workers Paid:** `CLOUDFLARE_PAID_TIER` now walks at most 1,000 log slots to find the tail per compaction pass. Before, a pass behind a stale `tail_hint` could need up to 100,000 GETs, which the request limit refuses; now it returns `skippedReason: "probe-budget-checkpointed"` or folds a slice, and the next pass resumes. Worst case per pass is 1,204 calls (3,612 retried).

```ts
// Workers Free + R2 binding, or Workers Paid: one call per invocation
await runScheduledMaintenance(args, CLOUDFLARE_FREE_TIER); // or CLOUDFLARE_PAID_TIER

// Workers Free + S3 over HTTP: alternate phases
if (Math.floor(controller.scheduledTime / 60_000) % 2 === 0) {
  await compact(args, CLOUDFLARE_FREE_TIER.compact);
} else {
  await runGc(args, CLOUDFLARE_FREE_TIER.gc);
}
```
