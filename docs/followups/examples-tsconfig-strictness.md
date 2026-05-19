# Example tsconfigs: weaker than root, target one ES version behind

**Severity: MEDIUM. Scaffolded users inherit the weakened config —
the type signals real code defects in their app. Bundle both fixes:
they're the same set of files, same review session.**

The four scaffoldable templates each carry their own per-target
tsconfigs:

- `examples/minimal-cloudflare/tsconfig.{app,worker}.json`
- `examples/minimal-node/tsconfig.{app,server}.json`
- `examples/helpdesk-cloudflare/tsconfig.{app,worker}.json`

None of them `extends: "../../tsconfig.json"`. Two distinct gaps.

## 1. Strictness flags dropped silently

The example tsconfigs declare `"strict": true` and stop there.
Root `tsconfig.json:19-25` enables seven flags *beyond* `strict`:

- `noUncheckedIndexedAccess`
- `noUnusedLocals`
- `noUnusedParameters`
- `noImplicitOverride`
- `noFallthroughCasesInSwitch`
- `verbatimModuleSyntax`
- `isolatedModules`
- `erasableSyntaxOnly`

A scaffolded user gets `strict` but none of the extras — including
the high-value `noUncheckedIndexedAccess`, which catches the
exact class of bug that `JSONArraylessObject` is trying to prevent.

## 2. `target` is one ES revision behind

Root `tsconfig.json:3-4`:

```json
"target": "ES2025",
"lib": ["ES2025", "ESNext.TypedArrays", "DOM", "DOM.Iterable"]
```

Every example `tsconfig.{worker,server,app}.json`:

```json
"target": "ES2023",
"lib": ["ES2023", "DOM", "DOM.Iterable"]
```

Both Node 24 and current `workerd` support
`Array.prototype.toSorted`, `Promise.withResolvers`,
`Object.groupBy`, and base-64 typed arrays. The downlevel is
free of any runtime-compat justification today.

## Fix — two paths

Two approaches; choose deliberately because the scaffolder flattens
the per-target tree:

**Option A — `"extends": "../../tsconfig.json"`.** Works in-monorepo
but **breaks once scaffolded** because `../../tsconfig.json` won't
exist in the user's repo. Requires the scaffolder to either
(a) rewrite `extends` at scaffold time, or (b) drop it and inline.
Adds complexity for no DX win.

**Option B — inline the strict flags in each example tsconfig.**
Heavier diff (8 flags × 8 tsconfigs = ~64 lines), but
self-contained. This is what scaffolded users actually see, so it's
also the *honest* representation of "we ship strict examples."
**Recommended.**

Coordinate the ES2023 → ES2025 bump in the same diff. The
`ESNext.TypedArrays` lib entry interacts with each template's
`uint8array-base64.d.ts` shim — once TypeScript proper lists the
base-64 methods natively, the shim can go (see memory
`reference_uint8array_base64_shim` and
`uint8array-base64-shim-parity.md` for the holding-pattern check).

## Verify after fix

- `cd examples/minimal-cloudflare && pnpm typecheck` (and repeat
  for each example) — expect new findings in real code, not just
  red squiggles in tsconfig.
- Scaffold one template into a fresh tmp dir; confirm tsconfig
  carries the explicit flags (not a broken `extends`).
