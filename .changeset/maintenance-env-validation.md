---
"@gusto/baerly-storage": minor
---

Maintenance environment validation now rejects values that previously
disabled maintenance or stalled folding silently. Node returns its standard
JSON `InvalidConfig` response and emits the canonical error line.

API/database requests that reach maintenance dispatch re-read these values,
so correcting the environment restores service without a restart. Node
health/spec and configured dev/static short-circuits remain available.
Cloudflare `/v1/spec` remains tolerant, and health/dev routes bypass an
invalid `BAERLY_MAINTENANCE_DISABLE` or `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`;
an API request that reaches the parse surfaces as a Worker exception rather
than the JSON envelope, matching the adapter's existing contract for a
missing `SHARED_SECRET`.

`BAERLY_MAINTENANCE_DISABLE` now accepts only the case-insensitive vocabulary
unset / `""` / `"0"` / `"false"` (enabled) and `"1"` / `"true"` (disabled).
Anything else throws `BaerlyError{code:"InvalidConfig"}`.

`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` uses a positive integer byte count as the
override; unset and empty values use the active profile default. Zero and
negative values now throw `InvalidConfig` (stricter parsing of other values
is in the `maintenance-env-strict` entry).

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

| LEFT (before) | RIGHT (now) |
| --- | --- |
| `BAERLY_MAINTENANCE_DISABLE=yes` | `BAERLY_MAINTENANCE_DISABLE=true` |
| `BAERLY_MAINTENANCE_DISABLE=no` | `BAERLY_MAINTENANCE_DISABLE=false` (or unset) |
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=0` (or any negative value) | Unset it, or use a positive value such as `1048576` |
