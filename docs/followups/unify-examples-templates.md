---
title: followups — unify-examples-templates branch
audience: meta
summary: Items surfaced while unifying packages/create-baerly/templates/ and examples/ into a single canonical catalog. Items 1 (helpdesk-cloudflare) and 3 (lefthook doc) shipped on the helpdesk-cloudflare-promotion branch; item 2 investigated and declined.
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

## Shipped on `helpdesk-cloudflare-promotion`

- **Helpdesk promoted to a CLI-scaffoldable Cloudflare target.** New
  `examples/helpdesk-cloudflare/` mirrors `minimal-cloudflare`'s shape
  with a real React+Vite frontend served by the Worker via Workers
  Assets. The scaffolder gained a `--starter=helpdesk` flag (compound
  `(target, starter)` lookup replacing `TARGET_TO_EXAMPLE`). Node
  helpdesk is deferred.
- **`lefthook` `core.hooksPath` workaround documented** in
  `docs/development.md` "Common pitfalls."

## Investigated and declined

- **Replace the `uint8array-base64.d.ts` shim.** The original premise —
  "TS 5.8 ships these methods in `lib.dom.d.ts`" — turned out to be
  wrong. TypeScript 5.9.3's command-line `--lib` flag does not
  recognize `esnext.typedarrays` as a valid lib name, so deleting the
  shim breaks per-example `tsc --noEmit` against the workspace's
  `@baerly/protocol` source. The shim is restored in all three
  examples (including `helpdesk-cloudflare`). Revisit when TS proper
  accepts `esnext.typedarrays` (or equivalent) in `--lib`; then add
  `ESNext.TypedArrays` to each example's `tsconfig.json:lib` and
  delete the shim plus the matching `excludePaths` / `SKIP_NAMES`
  entries. See `examples/*/uint8array-base64.d.ts` JSDoc for the
  cleanup instructions.

## Open items

1. **Update scaffolding-eval prompts to the new example names.** Found
   in `eval/prompts/` and `eval/run.mjs` — the eval harness
   currently passes `--target=cloudflare` / `--target=node`. The
   scaffolder's `STARTER_TO_EXAMPLE` map handles this transparently, so
   no functional breakage today. Suggested cleanup: extend the eval
   harness to cover the helpdesk corpus and to pass `--starter` (or
   example names) rather than target codes alone.
   **Status:** open

2. **Inline manifest reader in `packages/cli/src/deploy/node.ts`
   duplicates the scaffolder's logic.** `deployNode` reads
   `examples/minimal-node/.baerly/scaffold.json` and applies the same
   longest-first sentinel substitution as `substituteText` in
   `@baerly/create-baerly`. The two implementations are independent
   because `packages/cli/src/config.ts:6` documents a
   no-runtime-dep-on-create-baerly rule. Suggested cleanup: if that
   rule is ever relaxed, extract the rename logic to a shared utility
   (e.g. `@baerly/protocol/scaffold-rename.ts`) and re-use from both
   sides. **Status:** open
