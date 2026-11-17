---
"@gusto/baerly-storage": minor
---

**Breaking:** `runScheduledMaintenance` no longer takes a `phase` option. Every supported host runs one whole pass (compact, GC, then log retirement) per invocation: Workers Free with the R2 binding under `tier: "cf-free"`, Workers Paid under `"cf-paid"`, and Node under the default `"node"`. Splitting a pass with `phase: "compact"` / `"gc"` existed only for Workers Free with storage over `fetch`, which this release no longer supports. Drop the option and call `runScheduledMaintenance(target, { tier })` once per invocation; move S3 storage on Workers to Paid with `tier: "cf-paid"`. TypeScript now rejects the key, and a call that still passes it throws `InvalidConfig` before any storage call.
