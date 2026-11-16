---
"@gusto/baerly-storage": minor
---

Stale log objects are now reclaimed by a sequence window rather than a timed mark-and-sweep. Steady-state log object count is bounded by a constant regardless of how long a collection runs.

This replaces GC's `stale-log` category: `RunGcResult.marked.stale_log` is removed, and GC no longer lists the `log/` prefix. Log keys are computable, so the retirement pass issues DELETEs directly and needs no LIST. Reclamation no longer depends on object timestamps, so it behaves identically on every backend.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
const { marked } = await runGc(args);
console.log(marked.stale_log);
// after: runGc is no longer published. Log retirement runs in the maintenance
// pass that reaches it (scheduled maintenance, or a write tick that did not fold).
const { gcDeleted } = await runScheduledMaintenance({ storage, app, tenant, collection });
```

Remove reads of `RunGcResult.marked.stale_log`. Code that relied on GC listing `log/` must not; keys are computed from the sequence window.
