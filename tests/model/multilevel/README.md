# Multilevel fold protocol model

An executable **design-time model** of the multilevel fold protocol: a bounded
transition system, a set of generated schedules over it, and twelve properties
checked against those schedules.

## What this does not do

**This study does not constrain production code.** It imports nothing from
`packages/**`, and nothing in `packages/**`, `docs/`, `scripts/`, or CI imports
it. The state machine in `executor.ts` is a hand-written model of the protocol,
not a wrapper around `Writer`, `compact()`, or `runGc()`.

The practical consequence: **a regression in the real implementation cannot
fail these tests**, and a failure here is a statement about the model, not
about the shipped kernel. Treat a green report as evidence that the *design*
admits no counterexample within the stated envelope — the same standing a TLA+
or Alloy model has. It is not a conformance suite.

The tests live under `tests/` and run under plain `pnpm test` for one reason:
so the model keeps compiling and keeps passing as the repo moves around it.
That is bit-rot protection, not a regression gate.

**A green report authorizes nothing.** Specifically, it does not license
building a multilevel manifest format, a decoder for one, a query path over
one, a compactor change, or an oracle adapter. Each of those needs its own
design and its own ratification; "the model admits no counterexample" is an
input to that decision, not the decision.

**Keep this model semantically independent of `tests/model/fold-boundary/`.**
Do not share modeled state, transitions, generators, reconstruction logic, or
invariants between them: the two models test different hypotheses, and shared
semantics could give them the same blind spot. If shared reporting
infrastructure is introduced, include it in each report's source-hash closure.

## What it checks

Eight safety properties, evaluated over prefixes of each selected derived
failure schedule:

| Property | Obligation | Prefixes |
| --- | --- | --- |
| `acknowledged-mutations-never-lost` | durability of an acknowledged append | every |
| `unacknowledged-mutations-never-visible` | no premature visibility | every |
| `cold-and-warm-equal-reference-replay` | the two independent reconstruction paths agree | every |
| `publication-monotone-no-partial-run` | no torn manifest becomes reachable | publication and retry |
| `lost-cas-preserves-winning-lineage` | the CAS loser cannot corrupt the winner | lost CAS |
| `reclamation-preserves-reachable-objects` | GC never deletes a reachable object | reclaim |
| `recovery-idempotent-after-every-crash-point` | retry after any crash boundary converges | retry |
| `total-object-count-is-bounded` | the physical object bound holds | every |

The first and last prefix are always checked. Between them, four of the
properties skip prefixes whose operation cannot move their subject, under the
hand proofs recorded on `modelSafetyCanChangeAtPrefix`. That is a real
reduction in coverage, not a free optimisation, so each report records the
prefixes a property actually evaluated rather than the schedule length, and
`properties.test.ts` pins those counts. The other four are deliberately left
exhaustive: their subjects are the whole reconstructed view and the whole
object set, which reclaim, crash, and reconstruct are the operations most able
to move, and a transient violation that later heals is a counterexample only
prefix checking can see.

Four structural properties assert the generator actually reaches the states the
safety properties are supposed to constrain — crash boundaries, both CAS
outcomes, both maintenance orders, and every rejected arm. Without these, the
safety results would be vacuous.

## Assumption envelope

`DEFAULT_MODEL_ASSUMPTIONS` in `types.ts` bounds every generated and evaluated
schedule: 8 live documents, 3 active levels, 2 runs per level, 6 committed
suffix entries, 2 concurrent publishers, and 40 source operations. Crash-plus-
retry expansion may reach 42 operations. Results outside that envelope are not
claimed, and `validateModelFullSuiteAssumptions` rejects a widened envelope
rather than silently reporting on one.

## `MODEL_BASE_SHA`

`types.ts` records the `main` commit the study was authored and validated
against. It is provenance for the report, not a live assertion — nothing checks
whether `main` has since moved somewhere that invalidates the modeled design.
That judgment belongs to whoever rebaselines the study. Update the constant and
re-run the acceptance pass in the same commit.

## Running it

| Command | What it does |
| --- | --- |
| `pnpm test` | runs the suite at default volume (`FC_NUM_RUNS` unset → 100–200 runs). Fast; catches bit-rot |
| `pnpm model:multilevel` | the acceptance pass: 10,000 runs per property, ~11 minutes, writes a report |
| `MODEL_NO_PREFIX_SKIP=1 …` | checks every prefix of every property, discharging the skip rules. Run it after changing one |

The study is deliberately **excluded from `pnpm test:randomize`**. That soak
exists to shake out races in `packages/**` after a protocol change; since the
model shares no code with `packages/**`, including it would add tens of minutes
for no additional signal.

`writeModelStudyReport` writes to `bench/results/multilevel-model/<createdAt>/report.json`,
which is gitignored. Reports are reproducible from the recorded seed, source
hashes, and assumptions rather than checked in. `sourceHashes` covers the `.ts`
files directly in this directory and nothing else — editing any one of them
invalidates a previously generated report, so regenerate after changing the
model. This file is not covered, and neither would a fixture or a
subdirectory be.

## Reading order

1. `types.ts` — the state, object, and operation vocabulary.
2. `model-store.ts` — the durable store, effect application, and reachability.
3. `executor.ts` — the transition system: operations to durable effects.
4. `reconstruct.ts` — the two independent cold and warm reconstruction paths.
   They are independent in what makes them differ — which objects they read,
   whether they reuse a warm run, how they materialise content. They share the
   canonical mutation ordering from `types.ts`, which is a modeled protocol rule
   rather than a per-path choice, so a copy of it left behind by an edit cannot
   diverge one path from the other.
5. `invariants.ts` — the property checks.
6. `arbitraries.ts` — bounded schedule generation and crash derivation.
7. `property-suite.ts` — the registry binding properties to generators.
8. `report.ts` — the immutable report record.
