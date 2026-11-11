---
"@gusto/baerly-storage": minor
---

The canonical log line's `outcome` gains a `refused` value for capacity refusals (`CapacityExceeded`, `MaintenancePending`), logged at `warn`. A `CapacityExceeded` 409 no longer counts as `conflict`, and a `MaintenancePending` 503 no longer counts as `error` or logs at error level. Alert on `outcome:"refused"` to see collections at their host's fold ceiling.
