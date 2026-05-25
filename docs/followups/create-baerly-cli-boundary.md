# Tighten the `create-baerly` / `@baerly/cli` boundary

**Severity: LOW. Pre-launch cleanup; no user-facing bug.**

Two scaffold-time helpers live in `@baerly/cli` but are consumed only
by `create-baerly`, and the rule for which CLI handles what isn't
documented anywhere a new contributor or agent will land.

## 1. Relocate scaffold-time helpers into `create-baerly`

The only consumer of `@baerly/cli/wrangler-patch` and
`@baerly/cli/init-snippet` is
`packages/create-baerly/src/bolt-on.ts:19-20`. The helpers (252 LoC
total, both with co-located tests) belong in the scaffolder package.

### Files to move

- `packages/cli/src/wrangler-patch.ts` (191 LoC) → `packages/create-baerly/src/wrangler-patch.ts`
- `packages/cli/src/wrangler-patch.test.ts` → `packages/create-baerly/src/wrangler-patch.test.ts`
- `packages/cli/src/init-snippet.ts` (61 LoC) → `packages/create-baerly/src/init-snippet.ts`
- `packages/cli/src/init-snippet.test.ts` → `packages/create-baerly/src/init-snippet.test.ts`

### Steps

1. `git mv` the four files into `packages/create-baerly/src/`.
2. Rewrite `packages/create-baerly/src/bolt-on.ts:19-20`:
   ```diff
   -import { patchWranglerJsonc, readWranglerName, readWranglerMain } from "@baerly/cli/wrangler-patch";
   -import { renderWorkerEntrySnippet } from "@baerly/cli/init-snippet";
   +import { patchWranglerJsonc, readWranglerName, readWranglerMain } from "./wrangler-patch.ts";
   +import { renderWorkerEntrySnippet } from "./init-snippet.ts";
   ```
3. Delete the two subpath exports from `packages/cli/package.json:11-12`:
   ```diff
   -    "./wrangler-patch": "./src/wrangler-patch.ts",
   -    "./init-snippet": "./src/init-snippet.ts"
   ```
   If those were the only entries under `exports`, drop `exports`
   entirely — `@baerly/cli` is bin-only after this.
4. Drop `@baerly/cli` from `packages/create-baerly/package.json#dependencies`
   if no other import remains. Verify:
   ```sh
   git grep -n '@baerly/cli' packages/create-baerly/
   ```
5. Verify zero remaining consumers across the repo:
   ```sh
   git grep -n '@baerly/cli/wrangler-patch\|@baerly/cli/init-snippet'
   ```
   Expected: zero hits.
6. `pnpm verify:agent && pnpm test:agent`. The bundle-size test in
   `tests/integration/bundle-size.test.ts` may need a budget refresh
   for `dist/baerly.js` (smaller now).

No public API impact: `@baerly/cli` is workspace-internal and the
subpath exports were only ever consumed by `create-baerly`.

## 2. Name the rule for which CLI does what

Currently implicit. Agents will guess wrong without it. Add this
one-liner in three places:

> `create-baerly` puts baerly into a project. `baerly` does things
> to a project that already has baerly.

### Where to land it

- `docs/contributing/architecture.md` — one line near the package
  map / module list.
- `packages/create-baerly/AGENTS.md` — first sentence of the header
  (file already exists).
- `packages/cli/AGENTS.md` — create this file with the one-liner as
  its opening; mirror the pattern of `packages/create-baerly/AGENTS.md`
  for the rest (verb table, bundle-size note, etc.).

## When this is done

- Zero imports of `@baerly/cli/<scaffold-helper>` anywhere in the
  repo.
- `packages/cli/package.json` has no `exports` block (or only
  exports unrelated to scaffolding).
- The "which CLI" sentence appears in all three doc locations.
