---
"@gusto/baerly-storage": minor
---

Invalid maintenance env values now fail with `BaerlyError{code:"InvalidConfig"}` instead of silently falling back to a default. The error names the variable, the received value, and the accepted values. No value is trimmed.

`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` (Node and Cloudflare) must be unset, `""`, or a plain positive decimal integer byte count no greater than `Number.MAX_SAFE_INTEGER` (`/^[1-9][0-9]*$/`). Values that used to be accepted — unit suffixes (`"8mb"`), typos (`"1O24"`), surrounding whitespace (`" 1024 "`), hex (`"0x400"`), exponents (`"1e6"`), fractions (`"1.5"`), a leading `+` or `0` — now throw, as zero and negative values already did.

`BAERLY_MAINTENANCE_PROFILE` (Cloudflare) is a closed, case-sensitive vocabulary: unset, `""`, or `"cf-free"` select `cf-free`; `"cf-paid"` selects `cf-paid`; anything else (`"cf_paid"`, `"CF-PAID"`, `"cf-paid "`) throws. `resolveCfMaintenanceProfile` throws for the same values, so a `scheduled` callback that calls it fails the same way.

Where the error surfaces: an API request reaching maintenance dispatch fails — on Cloudflare as a Worker exception, on Node as the JSON `InvalidConfig` response — and keeps failing until the value is corrected; no restart is needed. On both hosts `/v1/healthz`, `/v1/spec`, and dev routes stay up for every invalid combination of these variables, and Cloudflare `scheduled()` still runs the configured callback. This replaces the earlier behavior where a non-positive `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` failed Cloudflare health probes. `baerly inspect` reports a rejected value as a stderr warning.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

| LEFT (before) | RIGHT (now) |
| --- | --- |
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=8mb` | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=8388608` (a byte count) or unset |
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=1e6` / `0x100000` / `1048576.0` | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=1048576` |
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=" 1048576 "` | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=1048576` (no whitespace) |
| `BAERLY_MAINTENANCE_PROFILE=CF-PAID` / `cf_paid` / `paid` / `"cf-paid "` | `BAERLY_MAINTENANCE_PROFILE=cf-paid` |
| `BAERLY_MAINTENANCE_PROFILE=free` (or any other value meant as the default) | Unset it, or `BAERLY_MAINTENANCE_PROFILE=cf-free` |
