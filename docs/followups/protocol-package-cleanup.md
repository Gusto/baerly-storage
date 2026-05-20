# Followups: `@baerly/protocol` package cleanup

## D13. `Predicate<T>` index signature defeats key narrowing

**Severity: MEDIUM. Real type-safety hole. Needs design discussion.**

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

## D20. R2 free-tier constants belong in the CLI, not the protocol kernel

**Severity: LOW. Coupled to `cli-cleanup.md` §G3.**

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
