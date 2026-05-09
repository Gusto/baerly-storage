# 0003 — Error code discriminant over `instanceof`

## Context

Errors thrown by MPS3 need to be machine-pattern-matchable by callers
(retry on `NetworkError`, surface `InvalidConfig` to the user, etc.).
The two common patterns in TypeScript are:

1. A class hierarchy: `NetworkError extends MPS3Error extends Error`,
   matched with `instanceof`.
2. A single class with a `code` discriminant: `error.code === "NetworkError"`,
   typed as a discriminated union.

## Decision

Use one `MPS3Error` class with a `code: MPS3ErrorCode` discriminant.
Definition in [`src/errors.ts`](../../src/errors.ts).

## Consequences

- **Survives serialization.** `instanceof` breaks across worker / iframe /
  postMessage boundaries because each realm has its own constructor
  identity. The `code` string survives `JSON.stringify` round-trips,
  which matters because IDB-restored writes can replay across realms.
- **Grep-friendly.** Searching for `"NetworkError"` finds throws,
  catches, tests, and docs at once.
- **Plays well with `verbatimModuleSyntax: true`.** No subclass-import
  graph to manage.
- **One file to update** when adding an error. Adding a new code
  requires a single union extension; the compiler then flags every
  `switch` that doesn't handle it.
- Cost: a slightly less natural API for callers used to
  `try { ... } catch (e: NetworkError)` patterns. The
  [`docs/conventions/tests.md`](../conventions/tests.md) rule
  documents the expected assertion style:
  `expect(...).rejects.toMatchObject({ code: "NetworkError" })`.
