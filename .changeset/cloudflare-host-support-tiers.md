---
"@gusto/baerly-storage": patch
---

The docs now name a support tier for each Cloudflare host. Workers Paid, with S3 or R2, is the first guaranteed tier. Workers Free with the R2 binding is the supported floor, with best-effort CPU. Workers Free with `S3HttpStorage` is not supported, because every storage call there is a `fetch` and counts against the free plan's 50 subrequests per request; R2 binding calls don't. S3 storage on Workers needs Paid with `BAERLY_MAINTENANCE_PROFILE=cf-paid`; a Paid Worker that has not set it keeps the free profile's 45-call `fetch` budget.

The R2 binding buys request headroom (tail length, retries), not a bigger collection. See `docs/spec/scale-ceilings.md` § Host support tiers. No runtime behavior changes.
