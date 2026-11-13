---
"@gusto/baerly-storage": minor
---

Adds the `BaerlyError{code:"MaintenancePending"}` error code: HTTP 503 with a `Retry-After` header, retriable, carrying the suggested delay in seconds on `err.retryAfter` (and `error.retryAfter` in the HTTP envelope). It means a write was refused, nothing was committed, and maintenance is catching up; wait the indicated delay and repeat the call.

Near a collection's fold ceiling, writes now drive maintenance themselves instead of waiting for the usual fold trigger:

- While a growth write (an insert, or an update that makes a row larger) would be refused with `CapacityExceeded`, an accepted write folds the pending changes in its own write tick once a full fold pass is pending, or as soon as folding them frees room, within the usual per-pass budget.
- A growth write refused only because pending changes have not folded yet (they would make room once folded, and every pending fold pass lands within the ceiling) runs one bounded fold and fails with `MaintenancePending` (`retryAfter` 1 second) instead of `CapacityExceeded`. Each retry folds one more pass, and the write commits once the room is folded. On a single host the capacity check never admits the growth that leads here, so it follows a move to a host with a smaller fold ceiling, for example a collection written under a larger ceiling whose pending deletes have not folded yet. With nothing pending that would make room, or when no fold can make progress on this host, the refusal stays `CapacityExceeded`.
- A full fold pass of the pending tail that would rebuild past the byte ceiling now also counts as no progress, alongside a stored snapshot past the ceiling: that pass would defer on every tick, so every write is refused with `CapacityExceeded`, and reads keep working.

On Cloudflare that fold runs in `ctx.waitUntil` after the response, like every write tick. Reads still never run maintenance, and nothing new is configured.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: no such code; a write near the ceiling either committed or stalled
await tickets.insert(doc);

// after: MaintenancePending is retriable (503 + Retry-After). Wait, then repeat.
for (let attempt = 0; ; attempt++) {
  try {
    await tickets.insert(doc);
    break;
  } catch (err) {
    if (err instanceof BaerlyError && err.code === "MaintenancePending" && attempt < 2) {
      await new Promise((r) => setTimeout(r, (err.retryAfter ?? 1) * 1000));
      continue;
    }
    throw err;
  }
}
```

The bundled HTTP client already retries `MaintenancePending` itself (see the client retry entries); a raw-HTTP caller or a custom `fetch` wrapper must honor `Retry-After`. An exhaustive `switch (err.code)` over `BaerlyErrorCode` must add the new case.
