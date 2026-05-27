---
title: Inline Unit = "http" type alias on canonical-line options
target: "@gusto/baerly-storage/observability:Unit"
concern: internal-seam-without-payoff
consumers_source: 4
consumers_docs: 0
sample_consumers:
  - packages/adapter-node/src/server.ts:flushCanonicalLine call
  - packages/adapter-cloudflare/src/worker.ts:flushCanonicalLine call
  - packages/server/src/observability/canonical.ts:flushUnauthorizedAndRespond
  - packages/server/src/observability/canonical.ts:withHttpObservability
est_loc:
  core: 3
  doc_drift: 0
  test_churn: 0
  total: 3
risk: low
risk_score: 1
score: 3
exception_eligible: none
exception_reasoning: n/a
status: proposed
discovered: 2026-05-27
related:
  - cut-observability-trim-v2 (sibling, already shipped; this is the residual tail)
---

## Why this is a candidate

`packages/server/src/observability/canonical.ts` declares
`export type Unit = "http"` — a one-variant union — and uses it as
the type of `FlushCanonicalLineOptions.unit`. Every caller of
`flushCanonicalLine` passes the literal `"http"`; no code branches
on the `Unit` value, no pattern matching exists, and there is no
second variant on the horizon (the recent observability-trim v2
explicitly narrowed `Unit` to `"http"` per memory
`[[observability-units-narrowed-to-http]]`). The seam exists, but
no payoff: the type can collapse to a literal field
(`readonly unit: "http"`) on the options interface, and the alias
+ its barrel re-export drop.

Per the cutting lens "internal-seam-without-payoff" — a Unit/Variant
enum with one variant in practice.

## Evidence

- `packages/server/src/observability/canonical.ts:Unit` —
  `export type Unit = "http";` (single-variant union).
- `packages/server/src/observability/canonical.ts:FlushCanonicalLineOptions.unit` —
  `readonly unit: Unit;`.
- `packages/server/src/observability/index.ts:type Unit` re-export
  inside the `flushCanonicalLine`/`flushUnauthorizedAndRespond`
  named-export block — the alias is in the published
  `/observability` subpath surface.
- All four production call sites pass the literal `"http"`:
  - `packages/adapter-node/src/server.ts:flushCanonicalLine` invocation
  - `packages/adapter-cloudflare/src/worker.ts:flushCanonicalLine` invocation
  - `packages/server/src/observability/canonical.ts:flushUnauthorizedAndRespond` self-call
  - `packages/server/src/observability/canonical.ts:withHttpObservability` self-call
- Test call sites (`canonical.test.ts`) also pass the literal
  `"http"` — 12 hits, no other variant.
- Grep across the whole repo for non-literal `unit: <expr>`: 0 in
  observability paths (the adapter-node conformance test uses
  `unit: fc.constantFrom(...)` for a fast-check arbitrary that's
  unrelated — a different file's bucket-key fuzzer).

## Exception assessment

- Kernel-bug tripwire? No — `Unit` does not gate any cost or
  protocol check.
- Empirical LLM ergonomic? No — `flushCanonicalLine` is adapter-
  authoring surface, not LLM-zero-shot scaffold surface.
- Audience reach across deploy targets? No — both shipped adapters
  pass the same literal.

## Cut surface

- **Core:**
  - `packages/server/src/observability/canonical.ts:Unit` type alias
    (the `export type Unit = "http";` line)
  - `packages/server/src/observability/canonical.ts:FlushCanonicalLineOptions.unit`
    field type narrows to `"http"` literal
  - `packages/server/src/observability/index.ts` re-export of
    `type Unit`
- **Doc drift:** none — no docs file mentions `Unit` by name (grep
  across `docs/`, `AGENTS.md`, `examples/*/AGENTS.md`).
- **Test churn:** none — tests pass the literal `"http"` already.

## Risk

Low. Internal observability surface, single package, type system
catches any caller that drifts. The locked-by-name re-export in
`/observability` is the only external surface, and downstream
adapter authors who type `unit: "http"` (as both shipped adapters
do) are unaffected. Cutting the alias does not change any wire
contract or canonical-log-line output.
