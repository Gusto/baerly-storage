---
"@gusto/baerly-storage": minor
---

A write that leaves its collection within 90% of the host's growth-refusal point now carries an early warning, so apps can shed rows before the first `CapacityExceeded`. Over HTTP the success response gains a `Baerly-Capacity-Warning` header (the body is unchanged), and the same text is the `capacity_warning` field on the request's canonical log line. The text names the state and the app-side remedy (delete rows, shrink documents, export with `baerly admin dump`), never a host setting.

The warning is computed per request from `current.json` and the pending tail, and nothing is persisted: it disappears as soon as a delete, a shrinking update or a larger host brings the collection back under the threshold.
