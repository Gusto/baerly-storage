---
'@gusto/baerly-storage': patch
---

Canonical HTTP log lines now classify by wire status alone: any 4xx is
`warn`, not `error`, even when a structured error is attached. Previously
an attached error forced `error` level regardless of status, so a `409
Conflict` logged at `error`.

**Why:** a 4xx is the caller's fault, not a server fault. The reachable
409 is a duplicate-`_id` insert (a reused id or a double-submitted POST);
ordinary storage write contention is absorbed internally by the log
forward-probe and never reaches the client as a 409. Logging these at
`error` polluted error budgets and could page on-call for normal
operation. `error` is now reserved for genuine server faults: 5xx, a
2xx/3xx that anomalously carries an error, or a thrown error with no wire
status to classify by. The line still carries the structured
`{ code, message }` on the failure path; only the stack (unneeded for a
routine client error) drops off at `warn`.
