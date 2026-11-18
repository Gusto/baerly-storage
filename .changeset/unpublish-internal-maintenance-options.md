---
"@gusto/baerly-storage": patch
---

Stop publishing `InternalMaintenanceOptions` from `@gusto/baerly-storage/maintenance`. The type was documented as internal but landed in `dist/maintenance.d.ts`, and its fields exposed internal knobs such as `gc.graceMillis` with no cast:

```ts
const o: InternalMaintenanceOptions = { gc: { graceMillis: 0 } };
await runScheduledMaintenance(args, o); // forwarded straight to GC
```

A grace of `0` risks deleting an object a retrying writer is about to find, so the only safe control is keeping the type off the published surface. `MaintenanceOptions` is still exported under the same name. This is a `patch` because the removed type was `@internal` and never documented as public.
