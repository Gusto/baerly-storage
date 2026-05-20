# Followups: `@baerly/protocol` package cleanup

**Source: 2026-05-19 analyst triage (D-series).** Most items shipped
on `protocol-cleanup-d-batch`. This file now tracks only what's
deferred.

## Shipped 2026-05-19 (this branch)

- **D1** — `protocol/src/db.ts` → `table-api.ts` (file rename;
  symbols unchanged).
- **D10** — `xml.ts` dead comments + 4 unused
  `ParsedListObjectsV2Output` fields stripped.
- **D11** — `verifier.ts` JSDoc trimmed to kernel contract.
- **D12** — `predicate.ts` (1226 LoC) split into
  `query/{validate,matches,merge,_internals}.ts`;
  `predicateImplies` moved to `@baerly/server/query-planner-implies.ts`.
- **D15** — `S3HttpStorage` moved from `@baerly/protocol` →
  `@baerly/adapter-node`. Public surface stays via the adapter
  re-export.
- **D17** — `InMemoryMetricsRecorder` moved from `@baerly/protocol` →
  `@baerly/server/observability`.
- **D18** — `lsn` JSDoc rewritten to acknowledge `lsnParts` as the
  canonical cursor decoder at the `/v1/since` boundary (the
  ticket's preferred "delete `lsnParts` and use `LogEntry.seq`"
  doesn't apply — the caller decodes an inbound cursor string
  where no `LogEntry` is in scope yet).
- **D19** — `parseRetryAfter` `export` dropped (module-private now).

**Also shipped 2026-05-19 (prior batch, `f80a873`):** D8 (brand
types), D9 (dead pre-collections symbols).

---

## Open

### D13. `Predicate<T>` index signature defeats key narrowing

**Severity: MEDIUM. Real type-safety hole. Deferred — needs design discussion.**

`packages/protocol/src/table-api.ts:99-103`:
```ts
{ readonly [K in keyof T]?: … } & { readonly [dottedPath: string]: … }
```

The string index signature dominates: any `keyof T` narrowing
is lost; `{ wrongField: "x" }` typechecks against any predicate.

The ticket's proposed fix — drop the string index signature and
require dotted paths via an explicit sub-key
(`where({ ... }, { dotted: {...} })`) — is a public-API change
that deserves a real design pass:

1. **Drop dotted-path support entirely.** Cleanest. Forces nested
   structures into top-level projected fields. Hurts ergonomics
   for nested-doc queries.
2. **Explicit sub-arg for dotted paths.** Preserves dotted-path
   queries with full type-safety on top-level fields.
3. **`as DottedPath<T>` brand on the dotted-path value.** Mirrors
   the brand-types philosophy elsewhere in the kernel.
4. **A `wherePath(["a","b","c"], op)` helper.** Decouples dotted
   syntax from the predicate object entirely.

Pre-launch, no compat burden. Worth a brainstorm + ADR before
implementation.

### D20. R2 free-tier constants belong in the CLI, not the protocol kernel

**Severity: LOW. Deferred — coupled to `cli-cleanup.md` §G3.**

`packages/protocol/src/constants.ts:227,237,251` declares
`R2_FREE_TIER_CLASS_A_OPS_PER_MONTH`,
`R2_FREE_TIER_CLASS_B_OPS_PER_MONTH`,
`R2_FREE_TIER_STORAGE_GB_PER_MONTH`. No external consumers found
via grep — these are dead in the kernel today but the analyst
flagged `packages/cli/src/cost/` as the eventual home. Resolves
once `cli-cleanup.md` §G3 (the strategic question about that
subtree) lands.

Keep `STORAGE_OPS_PER_LOGICAL_WRITE = 3` in protocol — that's a
real cost-model invariant, not a pricing literal.

---

## Closed / not pursued

- **D16** (`conformance.ts` imports vitest at module top). Theoretical
  cross-runtime risk only. Verified the `package.json` `exports`
  map does NOT expose `./conformance` on the default entry, and
  the test-only subpath uses static imports that bundlers
  tree-shake. No action.
