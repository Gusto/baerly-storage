---
"@gusto/baerly-storage": patch
---

The docs now name a support tier for each Cloudflare host. Workers Paid, with S3 or R2, is the first guaranteed tier. Workers Free with the R2 binding is the supported floor, with best-effort CPU. Workers Free with `S3HttpStorage` is best effort with a low ceiling, because every storage call there is a `fetch` and counts against the free plan's 50 subrequests per request; R2 binding calls don't.

The fold data ceiling is the same on both Free hosts. The R2 binding buys request headroom (tail length, retries), not a bigger collection. See `docs/about/workload-fit.md` § Scale at a glance. No runtime behavior changes.
