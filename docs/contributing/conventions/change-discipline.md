---
title: Conventions for changing code
audience: coder
summary: Default bias for changes in a pre-launch prototype — ship the smallest slice, prefer changing the contract over preserving old behavior, no compat aliases without asking.
last-reviewed: 2026-05-14
tags: [conventions, discipline]
related: [docs.md, tests.md, "../product-thesis.md"]
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
