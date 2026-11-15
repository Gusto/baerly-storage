---
"@gusto/baerly-storage": minor
---

**Breaking:** the published barrels drop undocumented kernel internals, and `CompactResult` no longer carries snapshot storage keys. None of these names was in `API.md`; they are snapshot-format and write-tick-runner internals that the snapshot format change will reshape.

- `@gusto/baerly-storage` no longer exports `SnapshotBody`, `encodeSnapshotBody`, `snapshotKey`, `loadSnapshotAsMap`, `walkLogRange`, `probeTailFrom`, `resolveVerifier`, `collectionsToMaps` or `validateOrThrow`. `SchemaIssue` and `SchemaValidator` stay.
- `@gusto/baerly-storage/maintenance` no longer exports `runBoundedMaintenance`, `BoundedMaintenanceOptions`, `dispatchWriteTick`, `dispatchInlineAwaited`, `MaintenanceDispatch`, `parseMaintenanceEnv`, `isFoldViable`, `resolveFoldCeilings`, `FoldCeilings`, `estimateTailBytes`, `shouldFireMaintenance` or `crossesGcBoundary`. `runScheduledMaintenance` and its types stay; `compact`, `runGc` and the tier profiles also leave this entry, as described in the entry of this release where `/maintenance` "exports one function".
- `@gusto/baerly-storage/observability` no longer exports `logMaintenanceWarning`, `flushUnauthorizedAndRespond` (adapter wiring) or the `ReadEnvelope` type, and `ObservabilityContext` / `ObservabilityContextInit` drop the adapter-set `maintenance` and `readEnvelope` fields. Work inside a context you create runs write-tick maintenance inline at the default caps, with no read envelope; `baerlyWorker` / `baerlyNode` set the host values.
- `Db` loses the `@internal` read seams `collectionReadContext`, `getCurrentJson`, `getLogEntry`, `probeLogTail` and `probeLogChunk`, so `CurrentJson` and `TailProbeChunk` leave the public types. Use the collection API (`db.collection(name)`) and `/v1/since` instead.
- `CompactResult` drops `previousSnapshotKey` and `newSnapshotKey`. Use `written`, `entriesFolded`, `logSeqStartBefore` and `logSeqStartAfter`.

The write-tick runner, dispatch, and env parsing are wired by `baerlyWorker` / `baerlyNode`; in-band maintenance needs no import. Scheduled maintenance keeps using `runScheduledMaintenance`.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
const res = await compact({ storage, currentJsonKey });
if (res.written) console.log("snapshot", res.newSnapshotKey);
// after: compact() is no longer published; a scheduled pass reports the fold
const res = await runScheduledMaintenance({ storage, app, tenant, collection });
if (res.folded > 0) console.log("folded", res.folded, "entries");

// before
import { runBoundedMaintenance } from "@gusto/baerly-storage/maintenance";
await runBoundedMaintenance(/* ... */);
// after: schedule the public runner, or let baerlyWorker / baerlyNode tick in-band
import { runScheduledMaintenance } from "@gusto/baerly-storage/maintenance";
await runScheduledMaintenance({ storage, app, tenant, collection }, { tier: "cf-free" });

// before
import { loadSnapshotAsMap, walkLogRange } from "@gusto/baerly-storage";
// after: read rows through the Db API
const rows = await db.collection("tickets").all();
```
