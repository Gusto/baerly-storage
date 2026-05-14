---
title: followups — unify-examples-templates branch
audience: meta
summary: Items surfaced while unifying packages/create-baerly/templates/ and examples/ into a single canonical catalog.
last-reviewed: 2026-05-14
status: open
tags: [followups]
related: ["../../examples/README.md", "../../packages/create-baerly/src/scaffold.ts"]
---

# Followups — `unify-examples-templates` branch

Primary work: moved `packages/create-baerly/templates/{cloudflare,node}/`
into `examples/minimal-{cloudflare,node}/`, switched the scaffolder from
`{{placeholder}}` regex to manifest-driven sentinel rename
(`.baerly/scaffold.json`), and promoted `examples/` to be both the
human-readable catalog and the CLI's template source.

## Open items

1. **Promote `examples/helpdesk` to a CLI-scaffoldable target.** Today
   helpdesk is dev-only: `LocalFsStorage`, hard-coded
   `sharedSecret("dev-shared-secret")`, single tenant
   (`helpdesk-demo`). Making it scaffoldable means choosing between
   (a) a `target: "local"` config switch in `baerly.config.ts` that
   toggles storage and auth at runtime, or (b) forking it into
   `helpdesk-cloudflare` and `helpdesk-node` variants. Either is its
   own design conversation. Suggested cleanup: brainstorm the
   target-toggle vs. fork question in a follow-on branch, then add a
   `.baerly/scaffold.json` and entry in `TARGET_TO_EXAMPLE`.
   **Status:** open

2. **Replace the `uint8array-base64.d.ts` shim in the moved examples.**
   Found in `examples/minimal-cloudflare/uint8array-base64.d.ts` and
   `examples/minimal-node/uint8array-base64.d.ts`. The workspace
   typechecks with tsgo (TS 7), which knows `Uint8Array.toBase64` /
   `fromBase64` (TC39 Stage 4). The moved examples typecheck with
   TS 5.6 (the version available via the local pnpm `.bin/tsc`) which
   doesn't ship those lib declarations. The shim is in-repo-only
   (scaffolder's manifest `excludePaths` strips it from user output),
   but it's still scaffolding debt. Suggested cleanup: bump each
   example's `typescript` devDep to `^5.8.0` (which has the methods
   in `lib.dom.d.ts`) and delete both `.d.ts` shims and the matching
   `excludePaths` manifest entries. **Status:** open

3. **`lefthook` `core.hooksPath` conflict bites first install.** Found
   while running `pnpm install` against the moved examples: pnpm's
   `prepare` script fails because `git config core.hooksPath` is set
   to something `lefthook install` doesn't expect. `pnpm install
   --ignore-scripts` worked around it. Pre-existing, not specific to
   this branch. Suggested cleanup: either document the reset in the
   root README (`lefthook install --reset-hooks-path` or
   `git config --unset core.hooksPath`) or have `prepare` auto-detect
   and recover. **Status:** open

4. **Update scaffolding-eval prompts to the new example names.** Found
   in `prompts/` and `scripts/run-eval.mjs` — the eval harness
   currently passes `--target=cloudflare` / `--target=node`. The
   scaffolder's `TARGET_TO_EXAMPLE` map handles this transparently, so
   no functional breakage today. Suggested cleanup: when the helpdesk
   promotion lands (item 1), also extend the eval harness to cover the
   richer corpus and to pass example names rather than target codes.
   **Status:** open

5. **Inline manifest reader in `packages/cli/src/deploy/node.ts`
   duplicates the scaffolder's logic.** `deployNode` reads
   `examples/minimal-node/.baerly/scaffold.json` and applies the same
   longest-first sentinel substitution as `substituteText` in
   `@baerly/create-baerly`. The two implementations are independent
   because `packages/cli/src/config.ts:6` documents a
   no-runtime-dep-on-create-baerly rule. Suggested cleanup: if that
   rule is ever relaxed, extract the rename logic to a shared utility
   (e.g. `@baerly/protocol/scaffold-rename.ts`) and re-use from both
   sides. **Status:** open
