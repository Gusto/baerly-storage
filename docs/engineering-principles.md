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

## Vendorless by default

The runtime depends on object storage and HTTP — primitives every
cloud has. We don't take a runtime dep on any vendor SDK or product
that locks the user in. Our data lives in *the user's* bucket, in a
shape that's mechanically exportable to Postgres / SQLite / D1.
Graduation is a tool we ship, not a feature we promise.

## Agent-friendly primitives, real engineering hidden

The API surface is small enough that an LLM can use it zero-shot
from `.d.ts` alone. Five verbs, four modifiers, one transaction.
Stable error codes (`BaerlyError.code`); stable error messages.
Examples in JSDoc that are tested.

Underneath, the protocol is a real distributed system: descending
base32-time keys, RFC 7386 merge patch, fence tokens, randomized
property tests against multi-Worker fault injection. The user never
sees any of it. Simple is a feature; the work to keep it simple is
the product.

## Strong path to production

The log entry shape is fixed at Phase 1 of the plan and stable across
all future versions. `baerly export --target=postgres` is a
mechanical translator, not a marketing line. When a prototype
graduates, the user moves to D1 / Postgres without rewriting business
logic; only the storage layer swaps. We design every feature to keep
this property true.

## Honest about limits

Baerly is for ~30 writes/min/collection, ~10 GB/tenant, ~100
collections/tenant. Above any of those: graduate. We document the
ceiling in the deploy docs. We ship query operators one at a time,
gated on a passing SQL translator test. Equality + dotted-path
nesting on day one — that's the contract on day one. We don't promise
what we haven't built.

## What Good Looks Like

- A small API surface with explicit request/response shapes.
- Documentation that explains current behavior, not historical archaeology.
