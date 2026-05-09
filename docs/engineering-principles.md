# Engineering Principles

This repo is a robust, enterprise quality product. This has not launched and has no users, so all things can be changed.

## Default Bias

- Ship the smallest coherent slice that solves the user problem.
- Prefer changing the product contract over preserving old behavior.
- Prefer modern syntax and idioms. This project uses TypeScript 7 and Node 24+

## Backwards Compatibility

There is no backwards compatibility requirement unless the user says otherwise.

When changing behavior:

- Update all in-repo callers and tests to the new contract.
- Remove obsolete code paths in the same change.
- Do not add compatibility aliases, dual writes, old/new schemas, temporary
  adapters, or legacy fallbacks by default.
- Prefer a direct reset or replacement for prototype-only data when that is
  simpler than preserving every historical shape.

## What Good Looks Like

- A small API surface with explicit request/response shapes.
- Documentation that explains current behavior, not historical archaeology.
