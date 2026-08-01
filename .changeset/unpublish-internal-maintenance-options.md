---
"@gusto/baerly-storage": patch
---

Stop publishing `InternalMaintenanceOptions` from
`@gusto/baerly-storage/maintenance`.

The type is documented as reachable only through the
`@baerly/server/_internal/testing` subpath, which is deliberately absent
from `publishConfig.exports`. It was nonetheless declared with
`export interface` in `maintenance.ts` — a published entry point — so it
landed in `dist/maintenance.d.ts` anyway.

That mattered beyond the doc drift, because its `compact` / `gc` fields
are typed as the `Internal*` widenings. Those are not name-exported, but
they are reachable *structurally* through the field types, so an
external caller got every internal knob with no cast and no `any`:

```ts
const o: InternalMaintenanceOptions = { gc: { graceMillis: 0 } };
await runScheduledMaintenance(args, o); // forwarded straight to runGc
```

`graceMillis` is the one that matters. `GC_GRACE_PERIOD_MILLIS`
documents that production MUST NOT go below the default outside a
maintenance window, since that risks deleting an anchor a writer is
about to find on retry. `0` is a valid integer, so no amount of input
validation inside `runGc()` can tell it from a legitimate call — the
only control is keeping the type off the published surface.

Both option types move to a new non-published `maintenance-options.ts`,
and `maintenance.ts` re-exports only the public `MaintenanceOptions`.
That is the shape `compactor.ts` and `gc.ts` already had — declare the
`Internal*` widening beside its public sibling in a module that is not
an entry point — which `maintenance.ts` could not have, being published
itself. Type-only throughout, so it erases at build time and no bundle
axis moves. `MaintenanceOptions` is still exported from
`@gusto/baerly-storage/maintenance` under the same name; only the
declaration site moved.

`tests/integration/internal-types-unpublished.test.ts` gates this in two
layers, because each covers the other's blind spot. A `@ts-expect-error`
pin fails the typecheck if `{ gc: { graceMillis: 0 } }` ever stops being
a type error on the published entry — exact, but only for that knob. A
name scan then walks every `publishConfig.exports` `.d.ts` and rejects
any exported name starting with `Internal` — broad, but keyed on a
naming convention, so it would miss a widening named otherwise. The scan
also asserts the emitter shape it parses (trailing `export { ... }`
blocks, which is what rolldown-dts produces): an inline
`export interface` or an `export *` would otherwise yield no match and
pass vacuously instead of going red.

Typed as a `patch` deliberately. Removing an exported type is normally
breaking, but this one is `@internal`, was never documented as public,
and reaching it required consuming a type the package explicitly
disclaims — so there is no supported usage to break.
