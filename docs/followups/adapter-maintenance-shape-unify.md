# Adapters: maintenance API drifts between Node and Cloudflare

**Severity: LOW. Two adapters, two mental models for the same
"compact then GC" maintenance flow. Unify before public publish.**

## What diverges

### Node adapter

`packages/adapter-node/src/server.ts` exports
`runMaintenanceTick({ storage, currentJsonKey, signal?, metrics? })`
that wraps `runScheduledMaintenance` from `@baerly/server` with
~20 lines of observability + storage tee plumbing. So the layers
are:

1. `runScheduledMaintenance` (kernel, in `@baerly/server`)
2. `runMaintenanceTick` (`@baerly/adapter-node`)
3. The user calling `runMaintenanceTick` from a host
   cron/scheduler

Three layers named with "tick" / "maintenance" / "scheduled" —
similar enough to be confusing, different enough to be
inconsistent.

### Cloudflare adapter

`packages/adapter-cloudflare/src/worker.ts`'s `scheduled` handler
takes either:

- `env.CURRENT_JSON_KEY` (single-tenant, single-collection) →
  built-in fallback fires
- `options.scheduled(...)` (multi-tenant) → user-supplied iterator
  drives maintenance per tenant × collection

No `runMaintenanceTick`-equivalent on CF; the iteration shape is
the user's responsibility.

## Why the divergence is a problem

A user writing a multi-environment app (CF for prod, Node for
local dev) gets two completely different maintenance shapes:

- On Node: call a typed function per
  `(tenant, collection)` tick.
- On CF: bind an env var or define a callback in
  `BaerlyWorkerOptions.scheduled`.

The kernel's invariant is the same — `runScheduledMaintenance`
operates per `currentJsonKey` — so the divergence is purely
adapter-side framing.

## Fix

Unify on a single `MaintenanceTargets` shape:

```ts
// @baerly/server/maintenance (new export)
export type MaintenanceTargets = {
  readonly currentJsonKeys: readonly string[];
};

export function buildCurrentJsonKey(app: string, tenant: string, collection: string): string;
```

### Node side

Drop `runMaintenanceTick`. Re-export `runScheduledMaintenance`
from `@baerly/adapter-node` directly. The observability + tee
plumbing the wrapper provided either:

- Folds into `runScheduledMaintenance` itself (preferred — the
  observability hooks belong with the kernel function).
- Lives as a thin `withObservability` decorator the user wires
  themselves (smaller kernel surface; explicit user code).

```ts
// adapter-node, post-fix
export { runScheduledMaintenance } from "@baerly/server";
```

User code calls `runScheduledMaintenance` directly with their
`MaintenanceTargets`, one entry per `(app, tenant, collection)`
they want to maintain.

### CF side

The `scheduled` handler iterates over `options.scheduled
?.MaintenanceTargets` and calls `runScheduledMaintenance` per
key. The single-tenant `env.CURRENT_JSON_KEY` fallback either
goes away (per `cf-worker-surface-trim.md` item 2) or becomes a
zero-config shortcut that builds a one-element
`MaintenanceTargets` internally.

## Why this is LOW

The current divergence ships to ~zero external users. The fix is
worth doing pre-launch but isn't blocking. Coordinate with:

- `cf-worker-surface-trim.md` item 2 (default scheduled handler).
- Any A1 barrel decisions (`unify-baerly-storage.md`) — the
  `MaintenanceTargets` export needs a home that lines up with the
  package-naming outcome.

## Verify after fix

- `examples/minimal-cloudflare/src/server/index.ts` and a
  hypothetical Node maintenance example show identical
  `MaintenanceTargets` construction patterns.
- `runMaintenanceTick` is removed from
  `packages/adapter-node/src/index.ts` exports; consumers updated.
- `buildCurrentJsonKey(app, tenant, collection)` exists as a
  single canonical helper instead of being open-coded in each
  adapter / example.

## Cross-references

- Memory `project_run_maintenance_tick_per_collection` is the
  prior incident that motivated the per-collection contract.
  Don't auto-derive `currentJsonKey` from `(app, tenant)` alone —
  that's the bug.
- `cf-worker-surface-trim.md` item 2 is the CF half of this.
