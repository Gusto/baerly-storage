---
"@gusto/baerly-storage": minor
---

**Breaking:** `baerly cost --json` reports a monthly object-storage cost band instead of an exact dollar figure. `trajectory.projectedUsdPerMonth` is replaced by `trajectory.projectedUsdBand`: `null` for providers without a dollar model (self-hosted), otherwise one of `"$0"`, `"<$25"`, `"$25-$50"`, `"$50-$100"`, `"$100-$250"`, `"$250-$500"` or `"$500+"`, each including its lower bound. `"$0"` appears only inside a modeled free tier; every other priced projection is `"<$25"` or above, however small, including zero writes on a provider with no free tier (AWS S3). Text output prints the band the same way.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
const free = result.trajectory.projectedUsdPerMonth === 0;
const usd = result.trajectory.projectedUsdPerMonth; // number | null
// after
const free = result.trajectory.projectedUsdBand === "$0";
const band = result.trajectory.projectedUsdBand; // "$0" | "<$25" | … | "$500+" | null
```

The projection covers only the selected collection, with zero other account usage and zero stored bytes. The JSON envelope now carries `scope` and `assumptions` (pricing provider, maintenance profile, whether that profile was inferred or set) and `trajectory.profile`. The maintenance profile is a separate input from the provider: `cf-free` for R2 and `node` otherwise, or set it with the new `--profile=cf-free|node`. `gcs://` buckets are now priced as GCS Standard (regional, flat namespace) instead of falling through to self-hosted, and `--provider` accepts `gcs`. See `docs/about/cost-model.md#cli-cost-bands`.

`baerly cost` and `baerly admin usage` sample each collection's trailing log by reading `current.json` and probing the live tail, instead of listing the collection's whole `log/` prefix, so per-collection sampling (and therefore `baerly cost`) no longer grows with retained history. `baerly admin usage` still discovers collections by listing every key under the tenant's `manifests/` prefix, so its discovery LIST pages still grow with retained objects.
