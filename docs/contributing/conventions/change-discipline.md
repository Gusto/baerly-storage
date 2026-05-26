---
title: Conventions for changing code
audience: coder
summary: Default bias for changes in a pre-launch prototype — ship the smallest slice, prefer changing the contract over preserving old behavior, no compat aliases without asking.
last-reviewed: 2026-05-26
tags: [conventions, discipline]
related: [docs.md, tests.md, "../../about/thesis.md"]
---

# Change discipline

This repo is enterprise-quality but has not launched and has no users.
Any contract can be changed. The conventions below codify the bias that
follows from that fact — they apply to non-trivial code changes across
`packages/`, `scripts/`, `bench/`, `examples/`, and `manual-e2e/`.

## Default bias

- Ship the smallest coherent slice that solves the user problem.
- Prefer changing the product contract over preserving old behavior.
- Prefer modern syntax and idioms. This project uses TypeScript 7 and
  Node 24+.

## Backwards compatibility

When changing behavior:

- Update all in-repo callers and tests to the new contract.
- Remove obsolete code paths in the same change.
- Do not add compatibility aliases, dual writes, old/new schemas,
  temporary adapters, or legacy fallbacks **without asking the user**.
- Prefer a direct reset or replacement for prototype-only data when
  that is simpler than preserving every historical shape.

## One canonical form per operation

The kernel ships one type-valid path per operation. Two paths to the
same call (e.g. `.get(id)` and `.where({_id}).first()`) is *redundant
ceremony* — a defect against criterion #4 of the
[product thesis](../../about/thesis.md), and out of scope of the
[additive-only lock](../../adr/002-api-surface-lock.md).

When adding a method, ask: does an existing path already express this
operation in a type-valid way?

- **No** — straightforward addition. ADR-002 §"Allowed additive
  changes" applies.
- **Yes** — pick one form. Pre-launch the cheap move is making the
  non-canonical form not type-check (narrow a `Predicate<T>` field,
  remove an overload, etc.). If the ceremony path must stay legal
  (e.g. because it composes with operators the canonical path
  doesn't), amend ADR-002 with the justification.

The bias is toward type-level enforcement over JSDoc steering. LLMs
reason from type shapes; JSDoc anti-pattern callouts do not override
training-distribution priors. If `.where({_id: x}).first()` compiles,
some fraction of generated code will use it regardless of what the
`@remarks` block says.
