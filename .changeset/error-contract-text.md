---
"@gusto/baerly-storage": patch
---

Error-contract text fixes:

- A read refused with `CapacityExceeded` now carries the remedy for the bound it hit as `resolution` (narrow the predicate or add a limit; delete or shrink rows; or retry once maintenance has absorbed pending writes), instead of the write remedy. The code, status, and `cause.bound` are unchanged.
- `CapacityExceeded`'s JSDoc, its `/v1/spec` summary, and the API.md table describe read refusals as well as write refusals. The `/v1/spec` IR lists `CapacityExceeded` under the read verbs (`get`, `first`, `all`, `count`).
- The `AlreadyExists` resolution now says that after an insert that omitted `_id` (the client resends it under its minted `_id`) the row may be that insert's own first attempt: re-read it, and do not insert again without an `_id`, which mints a second row.
