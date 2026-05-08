# Engineering Principles

This repo is a prototype-stage, YC-style product. The goal is to learn quickly
from real usage while keeping the codebase easy to change. Build the simplest
version that proves the workflow, with enough engineering quality that future
iterations are not fighting avoidable mess.

## Default Bias

- Ship the smallest coherent slice that solves the user problem.
- Prefer changing the product contract over preserving old behavior.
- Keep the runtime footprint small: fewer services, fewer dependencies, fewer
  background processes, fewer places to debug.
- Choose readable direct code over generalized frameworks.
- Make data flow obvious from request to storage to UI.

## Backwards Compatibility

There is no backwards compatibility requirement unless the user says otherwise.

When changing behavior:

- Update all in-repo callers and tests to the new contract.
- Remove obsolete code paths in the same change.
- Do not add compatibility aliases, dual writes, old/new schemas, temporary
  adapters, or legacy fallbacks by default.
- Prefer a direct reset or replacement for prototype-only data when that is
  simpler than preserving every historical shape.

Use migration machinery only for real data that must survive the change, not as
an automatic reflex.

## What Good Looks Like

- One clear owner for each piece of state.
- A small API surface with explicit request/response shapes.
- Runtime validation at trust boundaries.
- Focused tests around parsing, persistence, ranking, AI prompt contracts, and
  user-visible workflows that can regress.
- Documentation that explains current behavior, not historical archaeology.

## Overengineering Smells

Pause and simplify if a change introduces any of these without an immediate
product need:

- plugin systems, event buses, lifecycle frameworks, or broad registries
- feature flags, rollout systems, or compatibility modes
- extra queues, daemons, scheduled jobs, caches, or external services
- abstract base classes or generic factories for one or two implementations
- audit/history tables, status state machines, or reconciliation processes
- config-driven behavior that would be clearer as a direct function
- support for future providers, tenants, platforms, or scale that is not needed
  by the current workflow

## Planning Guidance

Specs and implementation plans should state:

- the user workflow being proven
- the smallest acceptable end-to-end slice
- what is intentionally out of scope
- which old code or contract is being removed
- the focused checks that prove the slice works

If a plan is getting large, split by user-visible value rather than by layers.