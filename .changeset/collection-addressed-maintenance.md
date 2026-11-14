---
"@gusto/baerly-storage": minor
---

**Breaking:** `@gusto/baerly-storage/maintenance` exports one function, `runScheduledMaintenance(target, options)`. It is addressed by collection (`{ storage, app, tenant, collection }`, the names you pass to `Db.create` and `db.collection`), not by a `current.json` key, and sized by `tier` (the `BAERLY_MAINTENANCE_PROFILE` vocabulary: `"cf-free"`, `"cf-paid"`, or the unbounded default `"node"`). `phase: "compact"` / `"gc"` runs one phase, which replaces the direct `compact()` / `runGc()` alternation on Workers Free with storage over `fetch`. It returns `{ folded, deferred?: { reason }, gcDeleted, pending }`. This entry replaces every earlier `/maintenance` recipe in this release's changelog.

- Removed from `@gusto/baerly-storage/maintenance`: `compact`, `runGc`, `CompactOptions`, `CompactResult`, `RunGcOptions`, `RunGcResult`, `MaintenanceArgs`, `MaintenanceProfile`, `MAINTENANCE_PROFILE_CF_FREE`, `MAINTENANCE_PROFILE_CF_PAID`, `MAINTENANCE_PROFILE_NODE`, `CLOUDFLARE_FREE_TIER` and `CLOUDFLARE_PAID_TIER`. `MaintenanceOptions` and `MaintenanceResult` keep their names with the new shapes; `MaintenanceTarget` is new.
- Removed from `@gusto/baerly-storage/cloudflare`: `resolveCfMaintenanceProfile`. Pass the `BAERLY_MAINTENANCE_PROFILE` value as `tier`.
- `minEntriesToCompact` is no longer an option. A scheduled pass folds any pending write (one 20-entry slice at a time under `"cf-free"`).
- Invalid `app` / `tenant` / `collection` names, and unknown `tier` / `phase` values, throw `InvalidConfig` before any storage call.

In-band maintenance is unchanged and still needs no import; a schedule stays optional.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
import { runScheduledMaintenance } from "@gusto/baerly-storage/maintenance";
const res = await runScheduledMaintenance({
  storage,
  currentJsonKey: "app/helpdesk/tenant/acme/manifests/tickets/current.json",
});
console.log(res.compact.entriesFolded, res.gc.swept);
// after
import { runScheduledMaintenance } from "@gusto/baerly-storage/maintenance";
const target = { storage, app: "helpdesk", tenant: "acme", collection: "tickets" };
const res = await runScheduledMaintenance(target);
console.log(res.folded, res.gcDeleted);

// before (Cloudflare, R2 binding)
await runScheduledMaintenance({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER); // or CLOUDFLARE_PAID_TIER
// after
await runScheduledMaintenance(target, { tier: "cf-free" }); // or "cf-paid"

// before (Workers Free, storage over fetch)
if (Math.floor(controller.scheduledTime / 60_000) % 2 === 0) {
  await compact({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER.compact);
} else {
  await runGc({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER.gc);
}
// after
const even = Math.floor(controller.scheduledTime / 60_000) % 2 === 0;
await runScheduledMaintenance(target, { tier: "cf-free", phase: even ? "compact" : "gc" });

// before
const profile = resolveCfMaintenanceProfile((k) => env[k]);
// after
const tier = env.BAERLY_MAINTENANCE_PROFILE === "cf-paid" ? "cf-paid" : "cf-free";

// before
await runScheduledMaintenance(args, { compact: { minEntriesToCompact: 10 } });
// after: no floor option; every scheduled pass folds what is pending
await runScheduledMaintenance(target);
```
