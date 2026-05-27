# Observability trim v2

**Status: PARTIALLY REJECTED.** Items 1 (histogram only — sibling
counters still candidates), 4 (`force_kept_by_error` only —
sampling still cut), and 6 (kernel seam only — public knob still
cut) are kept under load-bearer exception #1 (kernel-bug
tripwires). Items 2, 3, 5 stand as cuts. See
`docs/about/thesis.md` §"What we keep even when it looks like
ceremony" — the thesis itself names "op-count histograms" as the
canonical kernel-bug-tripwire example.

## Revised verdict per item

- **Item 1a — `db.write.class_a_ops_per_logical_write` histogram:**
  **KEEP.** Named explicitly in the thesis as a kernel-bug
  tripwire. Write-amp regressions blow the invoice before the CI
  gate catches them on `main`; the user-visible surface is the
  second-line defence. The "exactly one CI consumer" framing in
  the original analysis missed that the *user* is the other
  consumer when write-amp drifts in production.
- **Item 1b — 4 sibling counters:** **REWORK / mostly CUT.**
  Individual judgment:
  - `db.r2.put.412_total`, `db.r2.put.429_total` — KEEP. Distinct
    kernel-bug tripwires (CAS livelock, rate-limit floor); not
    derivable from the histogram. A 412 storm is the canonical
    "CAS scope regression" signal.
  - `db.r2.preimage_get_total` — CUT. Pre-image reads are
    subsumed by the histogram's class-A op count; redundant.
  - `db.writer.fence_bump_observed_total` — CUT. Internal-only
    diagnostic; no user-visible regression it catches that the
    412 counter doesn't already cover.
  - `db.write.index_ops_per_logical_write` — KEEP if cheap to
    keep alongside the main histogram; this is the
    index-amplification tripwire (a buggy index def can 10x
    write-amp silently). Re-evaluate if it duplicates work.
- **Item 2 — `RequestScopedMetricsRecorder.summarize()`
  percentiles:** **CUT stands.** p99 of 3 samples is meaningless;
  per-request percentile machinery doesn't serve the
  kernel-bug-tripwire role (the histogram aggregated at the
  Workers Analytics Engine / operator sink level does). Replace
  with `_sum`/`_count` suffixes only, drop the sort.
- **Item 3 — `BAERLY_LOG_STACKS` two-gate:** **CUT stands, but
  simplify rather than delete.** Stacks at `error` level DO catch
  kernel bugs (silent retry exhaustion, conflict-loop blow-up),
  but the two-gate env-var ceremony is incident-response cosplay.
  Simplify to "always include stack at `error` level, never
  elsewhere." Delete the env var and the `includeStack` param.
- **Item 4a — head-based deterministic sampling:** **CUT stands.**
  At 30 writes/min/collection ceiling, sampling is overkill; FNV
  hashing for cross-service trace correlation is microservice
  thinking. Delete the sampling module.
- **Item 4b — `force_kept_by_error`:** **KEEP the mechanism, drop
  the field name.** Errors must reach maintainers — that's the
  kernel-bug-tripwire role. With sampling deleted (4a), the
  *implementation* of force-keep is trivial (every line is kept),
  so the `force_kept_by_error` provenance field can go. The
  invariant "errors are never dropped" stays as a doc/test
  contract; the field stops existing because there is nothing to
  contrast against.
- **Item 5 — `runScheduledMaintenance` per-tick enrichment:**
  **CUT stands.** No human reads 6 AM cron canonical lines for a
  15-user app. Maintenance errors throw to the platform (CF
  dashboard / Node process logs); the kernel-bug-tripwire role is
  served by the per-write histogram (item 1a), not by
  maintenance-tick summary fields. Delete `withObservability` for
  maintenance/compactor/gc/rebuild.
- **Item 6 — `MetricsRecorder` kernel seam:** **REWORK.** Because
  item 1a stays, *something* has to emit the histogram. But the
  three-method recorder interface + tee combinator + ALS-aware
  wrapper are graduation-tier sink machinery for a kernel that
  ships ~3 emissions (histogram + 412 counter + 429 counter +
  maybe index-ops counter). Collapse to a single
  `MetricsRecorder` interface with no tee, no ALS wrapper; keep
  it as an *internal* seam (consumed by tests and the canonical
  emission site). The public `Db.create({ metrics })` knob still
  cuts per `cut-api-db-create-overrides.md` — operators wire to
  Workers Analytics Engine / OTel by reading the recorder output
  from canonical log lines, not by passing a custom recorder.

## Cross-item pattern

The original cut treated "no on-call" as if it removed *all*
observability load. It doesn't — the thesis carves out
kernel-bug tripwires precisely because the *maintainer's* job is
to catch protocol regressions before they hit the *user's*
invoice. The histogram + the two error-class counters (412, 429)
+ the always-kept error path are the minimum surface that
satisfies that role. Everything else (per-request percentiles,
env-gated stacks, head sampling, maintenance-tick enrichment,
public recorder seam) was Datadog cosplay grafted onto the
tripwires and goes.

## Original analysis (preserved for context)

**Severity: HIGH. Pre-launch cut. Six items of Datadog-grade
ceremony grafted onto a primitive whose audience does not own
on-call. The CI gates are the value; the recorder plumbing is
ceremony.**

The previous observability trim (memory: `observability-trim
shipped`, 2026-05-20) collapsed `redact.ts` into `canonical.ts`
and moved the in-memory recorder into `_internal/testing`. This
is v2 — six more cuts in the same theme.

## What to cut

### 1. `db.write.class_a_ops_per_logical_write` histogram + 4 sibling counters

- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/writer.ts:639,682,733,875,911,922,950`
  (per-emit sites)
- `/Users/eric.baer/workspace/baerly-storage/packages/protocol/src/metrics.ts:14`
  (recorder interface)

Per-`commit()` histogram of class-A op cost, plus
`db.r2.put.412_total`, `db.r2.put.429_total`,
`db.r2.preimage_get_total`, `db.writer.fence_bump_observed_total`,
`db.write.index_ops_per_logical_write`.

**Real consumers:** the histogram has exactly one — the CI gate
at `tests/fixtures/table-api-cascade.ts:594` (and `writer.test.ts`).
The four sibling counters have *zero* consumers outside their own
emission site and tests.

**Cut shape:** keep the CI gate (replace the
counting-recorder-proxy pattern with a counting `Storage` proxy
inline in the test). Delete every emission in `writer.ts`. The
audience is "an app with fifteen users" (thesis line 52) — they
will not run a p99 alert.

### 2. `RequestScopedMetricsRecorder.summarize()` percentile machinery

- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/observability/recorder.ts:95-138`
  (the `_p50/_p99/_count/_sum` expansion + `percentile()` at
  line 146)

Per-request histogram aggregation: sort observations, derive
p50/p99/count/sum suffixes, spread onto the canonical line.

**The problem:** p50/p99 *per request* is statistically
meaningless — a single HTTP request produces a handful of
histogram samples; "p99 of 3 values" is just `max`. The
conventions doc lists one histogram emitted by user-visible code;
everything else is a counter.

**Cut shape:** replace with `_sum`/`_count` suffixes only; drop
the sort.

### 3. `BAERLY_LOG_STACKS` two-gate stack inclusion

- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/observability/canonical.ts:369-401`
  (`serializeError` + `stacksEnabled`)

Two-gate (`includeStack` param AND `BAERLY_LOG_STACKS=1` env)
opt-in to include stack traces in the canonical-line error
envelope.

**The problem:** the framing — "operators turn stacks on globally
during an incident without redeploy" — is incident-response
cosplay for an audience that does not own on-call. Nobody is
flipping env vars mid-incident on a 15-user app.

**Cut shape:** always include stack at `error` level, never at
`warn`/`info`. Delete the env var, delete the two-gate logic.

### 4. Head-based deterministic sampling + `force_kept_by_error`

- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/observability/sampling.ts:1-60`
  (FNV-1a + bucket compare)
- Context fields at `context.ts:69-74`, gating at
  `canonical.ts:81-91`.

FNV-1a hash of `request_id` → deterministic head-sampling
decision; error path force-keeps with provenance preservation.

**The problem:** head sampling exists so you don't drown Datadog
at 10K req/s. At ~30 writes/min/collection ceiling, the entire
tenant produces fewer log lines per day than one curl loop.
Deterministic hashing for "stable inclusion across upstream/
downstream services that share the id" is microservice-trace-
correlation thinking — not for a single Worker.

**Cut shape:** delete the sampling module entirely. `sampleRate`
behaves as if always 1. Drop `sampled_by_head` and
`force_kept_by_error` from the context type and canonical-line
shape.

### 5. `runScheduledMaintenance` per-tick canonical-line enrichment

- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/maintenance.ts:134-150`
  (`compact_written`/`gc_swept` enrichment)
- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/observability/canonical.ts:131-157`
  (`withObservability` nesting logic)

Wraps each maintenance tick in its own ObservabilityContext, runs
compact+gc inside, then writes `compact_written` and `gc_swept`
summary fields to the canonical line. Nesting awareness exists so
`compact()` / `runGc()` *also* called individually still emit
exactly one line.

**The problem:** no prototype-tier author looks at canonical-log
lines emitted by a 6 AM cron tick. The maintenance unit-of-work
canonical line is observability theater for a phase no human reads.

**Cut shape:** delete `withObservability` for
`maintenance`/`compactor`/`gc`/`rebuild` units. Keep the kernel
mechanics; let errors throw to the platform (CF Workers
dashboard / Node process logs).

**Confidence: worth a memo** — pairs naturally with
`cut-cli-admin-compact-gc.md`'s critique that no human is
reading manual-compact output either.

### 6. `MetricsRecorder` as kernel-shipped seam + `alsAwareRecorder`

- `/Users/eric.baer/workspace/baerly-storage/packages/protocol/src/metrics.ts:1-120`
  (interface + tee combinator)
- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/observability/recorder.ts:188-201`
  (`alsAwareRecorder`)

Three-method recorder interface (counter/gauge/histogram), a tee
combinator, plus an ALS-aware wrapper that dual-writes to operator
sink + per-request bag.

**The problem:** the doc at `metrics.ts:47` cites the intended
consumer list: "Workers Analytics Engine, OpenTelemetry, statsd."
That is graduation-tier sink list. No scaffold wires this up.

**Cut shape:** collapse to a single optional `MetricsRecorder` for
advanced operators (or drop entirely if cuts 1-5 leave nothing
emitting). Delete the tee + ALS-aware wrapper from kernel. Pairs
with `cut-api-db-create-overrides.md` (which removes `metrics`
from the public `Db.create` shape).

**Confidence: worth a memo** — depends on whether items 1-5 leave
any kernel emissions worth a public sink interface. Probably not.

## What to leave alone

- **`body-cap.ts`** — real wire correctness (413 vs socket-hang-up).
- **`static-assets.ts`** — the SPA scaffolds' actual server.
- **`dev-landing.ts`** — zero-shot DX.
- **Cloudflare free-tier budget arithmetic in `maintenance.ts:155-176`** —
  kernel mechanics (the 50-subrequest cap is real); only `UNBOUNDED`
  vs `CLOUDFLARE_FREE_TIER` exist, which is the right ceiling.

## What gets harder after

- A user genuinely curious about per-write op cost has to read
  the R2 invoice or the CI gate's output. **Acceptable** — same
  reasoning as `cut-cli-cost-verb.md`.
- The canonical log line shrinks. **Net win** — less to maintain,
  less to teach, fewer fields for an agent to imagine they need
  to set.

## Related cuts

- **`cut-cli-cost-verb.md`** — the user-visible piece of the same
  theme (the histogram was the underlying ceremony; the verb was
  the wrapping).
- **`cut-api-db-create-overrides.md`** — removes the `metrics`
  knob from the public `Db.create` shape.
- **`cut-cli-admin-compact-gc.md`** — same audience-doesn't-
  read-this point for maintenance output.
