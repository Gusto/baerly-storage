---
"@gusto/baerly-storage": patch
---

`order()` is now a total order. Previously `null` compared equal to every value, so a key holding `null` left rows unsorted, and mixed strings and numbers compared under JS coercion. Values now order by type (`null` or missing, numbers, strings, booleans, objects, arrays) and by value within a type; `desc` reverses the whole order, and rows with equal keys order by `_id`. Strings still compare by UTF-16 code units. A query that sorted on a key holding `null`, mixed types or ties may return rows in a different, now deterministic, order.
