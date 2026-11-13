---
"@gusto/baerly-storage": patch
---

Fix `where({...})` queries missing rows when the only usable index is a
filtered index (`predicate`) whose filter the query does not imply. The
planner now skips such an index and full-scans, so a query on `assignee`
returns closed rows too even when the sole `assignee` index is filtered
to `status: "open"`.
