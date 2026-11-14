---
"@gusto/baerly-storage": minor
---

**Breaking:** the published barrels drop undocumented kernel internals. None of these names was in `API.md`; they are snapshot-format and write-tick-runner internals that the snapshot format change will reshape.

- `@gusto/baerly-storage` no longer exports `SnapshotBody`, `encodeSnapshotBody`, `snapshotKey`, `loadSnapshotAsMap`, `walkLogRange`, `probeTailFrom`, `resolveVerifier`, `collectionsToMaps` or `validateOrThrow`. `SchemaIssue` and `SchemaValidator` stay.
- `@gusto/baerly-storage/maintenance` no longer exports `runBoundedMaintenance`, `BoundedMaintenanceOptions`, `dispatchWriteTick`, `dispatchInlineAwaited`, `MaintenanceDispatch`, `parseMaintenanceEnv`, `isFoldViable`, `resolveFoldCeilings`, `FoldCeilings`, `estimateTailBytes`, `shouldFireMaintenance` or `crossesGcBoundary`. `runScheduledMaintenance`, `compact`, `runGc`, the tier profiles and their option/result types stay.
- `@gusto/baerly-storage/observability` no longer exports `logMaintenanceWarning` or `flushUnauthorizedAndRespond` (adapter wiring).

The write-tick runner, dispatch, and env parsing are wired by `baerlyWorker` / `baerlyNode`; in-band maintenance needs no import. Scheduled maintenance keeps using `runScheduledMaintenance`.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
import { runBoundedMaintenance } from "@gusto/baerly-storage/maintenance";
await runBoundedMaintenance(/* ... */);
// after: schedule the public runner, or let baerlyWorker / baerlyNode tick in-band
import { runScheduledMaintenance, CLOUDFLARE_FREE_TIER } from "@gusto/baerly-storage/maintenance";
await runScheduledMaintenance({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER);

// before
import { loadSnapshotAsMap, walkLogRange } from "@gusto/baerly-storage";
// after: read rows through the Db API
const rows = await db.collection("tickets").all();
```
