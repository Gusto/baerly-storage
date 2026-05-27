# Cut `baerly cost`

**Severity: HIGH. Pre-launch cut. Datadog cosplay on a prototype-tier
primitive — the bucket invoice is the gauge.**

`baerly cost --table=<collection>` GETs ~120 trailing log entries,
computes writes/min × write-amp × minutes/month, then renders
`~$X/mo`, `% of free tier`, and `% of 50M/mo graduation trigger`.

- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/cost.ts`
  (~181 LoC)
- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/cost/project.ts`
  (~121 LoC)
- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/cost/provider.ts`

## The case for cutting

Thesis line 164 is unambiguous: **"Cost is not the moat."** The
audience in §"Audience in practice" — finance team dashboard, PM's
internal tracker, weekend side project, "$20/mo ChatGPT subscriber
with a dream" — reads the R2 invoice once a month if at all. The
whole point of "idle rounds to zero" (thesis criterion #1) is that
the bill *is* the gauge.

The `GRADUATION_*` constants and CF-vs-AWS-vs-self-hosted price
table is borrowed maturity from production observability tooling.
It ages badly when CF rev the free tier and creates a maintenance
liability (`pricing-log.md`) for a value the user can read off
their cloud bill in two clicks. This is the textbook pattern the
deferred changes-iterator memo (`docs/superpowers/specs/2026-05-25-changes-iterator-design.md`)
called out — production-tier ceremony grafted on a prototype-tier
primitive whose audience is not the operator type.

The CI gate at `tests/integration/phase5-end-to-end.test.ts`
(class-A op counter under `Storage` proxy) is the load-bearing
enforcement. The user-facing `--percentOfGraduation` projection
adds nothing the gate doesn't already guarantee.

## What to do

1. Delete `packages/cli/src/cost.ts`, `packages/cli/src/cost/`
   directory, and its citty subcommand wiring.
2. Delete the cost-rate constants module (CF/AWS/GCS rates). These
   are otherwise unreferenced after the verb dies.
3. Drop the `cost` row from `CLAUDE.md`'s verification table.
4. Remove cost-related sections from `docs/about/cost-model.md`
   that reference the verb's projection output.

Workload-shape signals (writes/min vs ceiling, % of free-tier ops)
are appropriate to surface — but they belong in `baerly inspect`
output if anywhere, not their own verb with a dollar projection.

## What gets harder after

- A user who wants a heads-up before they outgrow the free tier
  has no in-CLI signal. **Acceptable** — they should be reading
  the R2 dashboard, which gives them the same number with better
  fidelity than a 120-entry sample.
- The "100 MAU helpdesk app should cost single-digit $/mo" claim
  in `cost-model.md` loses its in-product proof. **Acceptable** —
  the claim is in the doc; the bill confirms it.

## Related cuts

- **`docs-cost-model-trim.md`** — `docs/about/cost-model.md` has a
  whole M-size comparison table that exists for the same
  borrowed-maturity reason. Cut together for a coherent
  cost-isn't-the-moat trim.
- **`observability-trim-v2.md`** — the `db.write.class_a_ops_per_logical_write`
  histogram cited by `cost-model.md` as the "p99 alert" target
  has the same issue: the gate is the value, the histogram is
  ceremony.
