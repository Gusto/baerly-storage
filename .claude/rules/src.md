---
description: Conventions for source code under src/ (excluding tests)
appliesTo: src/**/*.ts
appliesNotTo: src/__tests__/**
---

# src/ rules

## Imports
- Relative paths only (`./types`, `./constants`). No `baseUrl` aliases —
  `tsconfig.json` doesn't define one.
- Type-only imports use `import type` (or inline `import { type X }`)
  because `verbatimModuleSyntax: true` is on.

## Branded types
- `Ref`, `ManifestKey`, `UUID`, `VersionId` exist in `src/types.ts` to
  prevent confusion bugs. Don't widen with `as string`. Use the
  constructor helpers (`uuid()`, `<VersionId>x`) at the boundary only.

## Constants
- New magic numbers / strings go in `src/constants.ts` with a JSDoc
  citing the source (often `docs/sync_protocol.md`). Inline constants
  inside protocol code are a smell.

## Errors
- All thrown errors must be `MPS3Error` instances (`src/errors.ts`).
- Use the `code` discriminant — `error.code === "NetworkError"` —
  not `instanceof` chains. Codes are strings so they're grep-friendly.
- Re-throws (`throw err` after a `catch`) are fine; don't wrap them.

## Public API surface
- The `MPS3` class in `src/mps3.ts` is the public API. Internal methods
  must be prefixed `_` and tagged `/** @internal */` so typedoc skips
  them.
- New public methods need JSDoc with `@param`, `@returns`, `@throws`,
  and an `@example` block. Typedoc consumes these into `docs/api/`.

## Protocol code (`syncer.ts`, `manifest.ts`)
- Read `docs/sync_protocol.md` and `docs/causal_consistency_checking.md`
  before changing these files. They encode invariants proven elsewhere.
- Manifest key suffixes are `<base32-time>_<session>_<seq>`. Don't
  invent a new shape without updating the protocol doc.
- The `LAG_WINDOW_MILLIS` (`constants.ts`) is the clock-skew tolerance.
  Anything outside that window is treated as invalid by `Syncer.isValid`.
