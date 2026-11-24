---
"@gusto/baerly-storage": patch
---

A malformed `current.json`, snapshot, GC pending record, log entry or tree node no longer quotes stored content in its `InvalidResponse` error. The error used to carry the underlying `JSON.parse` `SyntaxError` as `cause`, and V8 includes a window of the source text in that message, so a fragment of a stored value could reach logs. The error code is unchanged; the message now reports the body length and, where available, the failing position.
