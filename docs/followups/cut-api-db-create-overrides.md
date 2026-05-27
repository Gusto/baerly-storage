# Cut `Db.create({ schemas, indexes, metrics })` override knobs

**Severity: HIGH. Pre-launch cut. Three redundant-ceremony knobs
on the public `Db.create` shape — ADR-002 violation.**

`Db.create(...)` accepts three optional knobs that the `config`
param already covers or that no prototype-tier author will tune:

- `schemas?: ReadonlyMap<...>` — overrides the schemas map derived
  from `config.collections`.
- `indexes?: ReadonlyMap<...>` — overrides the indexes map derived
  from `config.collections`.
- `metrics?: MetricsRecorder` — production-grade telemetry sink.

- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/db.ts:286-299`
  (override-map declarations + JSDoc)
- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/db.ts:278`
  (metrics field declaration)
- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/db.ts:220-228`
  (metrics forwarded to every `Writer`)
- Adapter callsites: `packages/adapter-cloudflare/.../worker.ts:247`,
  `packages/adapter-node/.../server.ts:103`

## The case for cutting

ADR-002 §"Scope of 'additive'" bans redundant ceremony — multiple
type-valid paths to the same capability. Thesis §4 makes the same
point: "JSDoc steering does not override training-distribution
priors; the fix is making one of the paths not type-check."

**`schemas` / `indexes` overrides:** `config` already derives both
maps via `collectionsToMaps()`. The adapter-side justification
("allocation-free hot path; pre-flatten the map") is production-DB
perf thinking applied at a workload of 30 writes/min/collection
where one allocation per request is invisible. Two type-valid paths
to the same outcome.

**`metrics` knob:** No prototype-tier author wires a
`MetricsRecorder`. The audience is dashboards, internal trackers,
side projects (thesis §"Audience in practice") — none of them
have a Workers Analytics / OpenTelemetry / statsd sink. The kernel
needs an internal hook for the CI gate; that hook does not need
to be on the public `Db.create` shape.

The deferred changes-iterator memo's §3 lens applies: "the React
side doesn't need a bare-client iterator; what was elided is that
only the primitive matters." Here, the kernel internals need a
metrics seam; the *public surface* doesn't.

## What to do

1. Remove `schemas`, `indexes`, and `metrics` from the public
   `DbCreateOptions` type.
2. Keep the internal machinery that consumes them — but route via
   `config` (for schemas/indexes) and via a friend-exported
   `_internal/testing` re-export (for metrics, consumed by tests
   and CI gates).
3. Adapter sites: drop the pre-flatten optimization; pass `config`
   only. If profiling later proves the alloc matters, memoize
   internally — don't push it onto the public API.
4. Update `packages/server/API.md` to reflect the single canonical
   form.

## What gets harder after

- Tests that constructed `Db` with a pre-flattened map need a
  config shape. **Acceptable** — `collectionsToMaps` is reversible.
- The metrics CI gate moves to the friend-export path. **Acceptable**
  — internal use is what `_internal/testing` is for.
- Adapter request-path allocation goes up by O(collections-count)
  per request. **Acceptable at the ceiling** — invisible at 30
  writes/min/collection. If it ever matters, memoize.

## Related cuts

- **`observability-trim-v2.md`** — the `MetricsRecorder` interface
  itself, the histogram emissions, and the percentile machinery
  all participate in the same "operability tooling the audience
  doesn't operate" theme.
