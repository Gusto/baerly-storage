---
"@gusto/baerly-storage": patch
---

`baerly cost --provider=gcs` takes a new `--region=<location>` flag. GCS's always-free allowance (5,000 Class A ops and 5 GB-month) applies only in `us-west1`, `us-central1` and `us-east1`; for a bucket in any other location the projection now drops the allowance and the `$0` band, and reports the region in `assumptions.bucketRegion`. Omitting the flag keeps the previous behavior and its disclosure. `--region` on a non-GCS provider is an `InvalidConfig` error.
