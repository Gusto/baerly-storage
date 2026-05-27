---
title: Cut maxEvents test knob from since-route options
target: "@gusto/baerly-storage/http:LongPollSinceOptions.maxEvents + ListEventsSinceOptions.maxEvents"
concern: configurability-without-consumers
consumers_source: 0
consumers_docs: 0
sample_consumers:
  - none
est_loc:
  core: 6
  doc_drift: 2
  test_churn: 0
  total: 8
risk: low
risk_score: 1
score: 8
exception_eligible: none
exception_reasoning: n/a
status: proposed
discovered: 2026-05-27
related: []
---

## Why this is a candidate

`LongPollSinceOptions` and `ListEventsSinceOptions` each carry an
optional `maxEvents?: number` field whose JSDoc says "Overrides for
tests". Both interfaces are exported from the public
`@gusto/baerly-storage/http` subpath, so the knob ships in the
locked surface — but no caller passes it. Production adapters
(`@baerly/adapter-node`, `@baerly/adapter-cloudflare`) construct
`createRouter` without touching it; the only references in the repo
are the two field declarations and two `opts.maxEvents ??
DEFAULT_MAX_EVENTS` reads inside `since.ts` itself. Per the cutting
lens "configurability-without-consumers" — a default value never
overridden, exposed as a public knob.

The thesis criterion #4 ("LLM-legible API") also applies: a
test-only knob on a `.d.ts` exported interface is cognitive load on
zero-shot scaffold authors who will never reach for it.

## Evidence

- `packages/server/src/http/since.ts:LongPollSinceOptions.maxEvents`
  — declared with comment "Overrides for tests".
- `packages/server/src/http/since.ts:ListEventsSinceOptions.maxEvents`
  — second declaration, same shape.
- `packages/server/src/http/index.ts` re-exports both
  `LongPollSinceOptions` and `ListEventsSinceOptions` (the file's
  whole content is the four-line `{type, type, fn, fn}` re-export).
- `packages/server/package.json:exports."./http"` publishes the
  subpath. The knob is in the locked surface.
- Grep across the whole repo for `maxEvents`: every hit lands in
  `packages/server/src/http/since.ts`. 0 hits in
  `packages/adapter-node/`, `packages/adapter-cloudflare/`,
  `tests/`, `examples/`, `docs/`, `bench/`, `manual-e2e/`.
- The existing `tests/integration/since-options.test.ts` exercises
  `sinceTimeoutMs` and `sincePollIntervalMs` but contains no
  `maxEvents:` assignment (also confirmed by the lens-1 grep).

## Exception assessment

- Kernel-bug tripwire? No — `DEFAULT_MAX_EVENTS` is already the
  hard ceiling; capping the per-poll batch is the kernel's
  responsibility, not a user-tunable.
- Empirical LLM ergonomic? No — there is no zero-shot scaffold
  case where an LLM would (or should) tune this. The knob's JSDoc
  literally says "Overrides for tests".
- Audience reach across deploy targets? No — every deploy target
  uses the default.

## Cut surface

- **Core:**
  - `packages/server/src/http/since.ts:LongPollSinceOptions.maxEvents` field
  - `packages/server/src/http/since.ts:ListEventsSinceOptions.maxEvents` field
  - The two `const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;`
    lines collapse to a direct `DEFAULT_MAX_EVENTS` reference (or the
    constant inlines, depending on call-site density).
  - The two destructured `maxEvents` pass-throughs inside
    `longPollSince` / `listEventsSince` collapse to use the constant
    directly.
- **Doc drift:**
  - The inline "Overrides for tests" JSDoc on each interface.
  - Inline comment "(hard ceiling per the module docstring)" near
    `endSeq = Math.min(...)` — the module docstring claim survives
    the cut, but the inline cross-ref to a now-absent knob can be
    pruned.
- **Test churn:** none. `tests/integration/since-options.test.ts`
  never sets the field.

## Risk

Low. Cuts an optional field on a documented public interface; the
TypeScript surface is the enforcement mechanism, and grep confirms
zero callers anywhere in the repo. Wire contract unaffected
(`maxEvents` is a server-side cap, not a query parameter). No
fan-out beyond `since.ts`.
