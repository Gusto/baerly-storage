---
"@gusto/baerly-storage": minor
---

The two `@internal` log-read seams on `Db` now take the `current.json` they are floored against and reject a seq below `log_seq_start` with `BaerlyError{code:"Internal"}`.

These seams are no longer on `Db` at all (see the "published barrels drop undocumented kernel internals" entry of this release). Read through the collection API and `/v1/since` instead:

```ts
// before
const entry = await db.getLogEntry(collection, seq);
// after
const rows = await db.collection(collection).all();
```

Entries below `log_seq_start` are already folded into the snapshot and may be reclaimed at any time, so reading one is a protocol violation rather than a tolerable miss — see invariant 5 in `docs/spec/sync-protocol.md`. Previously the floor lived entirely in the caller, and nothing in the type stopped a new HTTP route, CDC path, or adapter from reading beneath it. Application code is unaffected: use the collection API.
