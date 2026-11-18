---
"@gusto/baerly-storage": patch
---

Filtered reads and `count()` evaluate the predicate in one pass, splitting each dotted path once per query instead of once per row.
