# Cut `BaerlyClient.since` and `useInvalidationTick` (changes-iterator residue)

**Severity: HIGH. Pre-launch cut. Already named for deletion in the
deferred changes-iterator memo; verify still present, then pull.**

Two public surfaces flagged for removal in
`docs/superpowers/specs/2026-05-25-changes-iterator-design.md`
(see lines 17-22 of that memo). Both still ship on the current
branch.

- `/Users/eric.baer/workspace/baerly-storage/packages/client/src/client.ts:269`
  (`BaerlyClient.since` interface)
- `/Users/eric.baer/workspace/baerly-storage/packages/client/src/client.ts:300-309`
  (impl)
- `/Users/eric.baer/workspace/baerly-storage/packages/client/src/react/use-invalidation-tick.ts:56`
  (hook impl)
- `/Users/eric.baer/workspace/baerly-storage/packages/client/src/react/index.ts:29-30`
  (export)

## The case for cutting

The deferred-spec memo is the gold standard for this cut — its
"Why we said no" section names the borrowed maturity (Debezium /
MongoDB Change Streams / Postgres logical-rep) and the workload
the cost ceiling can't sustain.

**`client.since`:** typed wrapper over `GET /v1/since` returning
raw `SinceResponse`. The deferred-spec memo §"What we built
instead" lays out the replacement: extract `pollSinceOnce` as an
internal helper consumed by the subscription pool; no public
caller post-hooks-collapse; manual-e2e probes hit `/v1/since` via
raw `fetch`.

**`useInvalidationTick`:** a third public reactive primitive
alongside `useLiveQuery` / `useLiveDocument` — three type-valid
paths to "I want to know when data changed" violates the
redundant ceremony failure mode (thesis §4). Its own JSDoc cites
"manual cache" as the use case, which is precisely the
"hand-rolled caches outside `useQuery`" power-user escape hatch
the deferred-spec §4 calls out as the wrong audience to serve
with polished surface.

## What to do

1. Delete `client.since` from `BaerlyClient` interface + impl.
2. Delete `use-invalidation-tick.ts` and its export from
   `packages/client/src/react/index.ts`.
3. Extract `pollSinceOnce` as an internal helper in
   `packages/client/src/poll-since-once.ts` (per deferred-spec
   memo §"What we built instead"). The React subscription pool
   consumes it directly.
4. The wire endpoint `/v1/since?table=…&cursor=…` is **unchanged**.
5. The `LogEntry` shape is **unchanged**.
6. Manual-e2e probes already hit `/v1/since` via raw `fetch` —
   no change.

## What gets harder after

- Anyone reaching for `client.since(...)` gets `Property 'since'
  does not exist on type 'BaerlyClient<TConfig>'` — which is the
  correct signal per the deferred-spec memo's §"What we built
  instead" closing paragraph.
- A power-user who wanted invalidation-tick semantics outside
  `useLiveQuery` falls through to internals (or polls explicitly
  with `setInterval(refetch, 10_000)`). **Acceptable** —
  deferred-spec §4 argues this exact case.

## Notes

This cut is the most pre-decided of the audit — the analysis was
already done in the deferred memo, the replacement design is
specified, the deletion targets are named. This is execution, not
re-litigation.

## Related

- **Source memo:** `docs/superpowers/specs/2026-05-25-changes-iterator-design.md`
- **Companion spec (in flight):** `docs/superpowers/specs/2026-05-25-react-hooks-collapse-design.md`
  — this is where `pollSinceOnce` lands as the internal helper.
