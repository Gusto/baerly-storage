---
"@gusto/baerly-storage": patch
---

Write-tick maintenance now fits inside the request's storage request
budget. Before each phase it checks what the request has left: a fold
that does not fit is skipped until a later write, and a GC slice or
log-retirement pass deletes fewer objects. If a call is still refused
part-way through, the tick stops quietly. The new counters
`db.maintenance.request_budget_skipped_total` (label `phase`) and
`db.maintenance.request_budget_refused_total` record both cases; neither
counts toward `db.maintenance.unexpected_error_total`. Node has no
budget, so nothing changes there. No app code changes.
