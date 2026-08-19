---
description: Bundle-size policy for bundle-affecting edits (delta gate, do-not-golf-comments rule)
paths:
  [
    "packages/*/src/**/*.ts",
    "packages/*/src/**/*.tsx",
    "rolldown.config.ts",
    "bundle-sizes.json",
    "!packages/**/*.test.ts",
    "!packages/**/*.test.tsx",
  ]
title: "Auto-load: bundle budget policy"
audience: agent
summary: Triggers on bundle-affecting source — packages/*/src, rolldown.config.ts, and the bundle-sizes.json snapshot itself — and routes the agent to docs/contributing/conventions/bundle-budgets.md before it writes.
last-reviewed: 2026-08-02
tags: [agent-rule, auto-load, bundle-size]
related: ["../../docs/contributing/conventions/bundle-budgets.md"]
---

# Bundle budget rules

Canonical content lives at [`docs/contributing/conventions/bundle-budgets.md`](../../docs/contributing/conventions/bundle-budgets.md).

Three things to know before you edit:

1. **`min-gz` is the axis a consumer pays.** `raw`/`gz` are diagnostics. All
   three are delta-gated, so growth rate — not an absolute number — is what
   bounds size. The lone exception is `app-config.js`, which carries absolute
   `raw`/`gz` ceilings asserting it has no runtime closure at all.
2. **Never trim JSDoc, comments, or error text to fit a budget.** Comments ship
   un-stripped in `raw`/`gz` but vanish under a consumer's minifier, so golfing
   them buys bytes nobody pays while costing documentation quality.
3. **Intended growth is cleared with `pnpm bundle-sizes --write`** plus a reason
   in the commit message. Do not write a changelog entry into any file. A
   ceiling violation is not clearable this way — `--write` refuses, because
   that failure means the entry gained a closure, not bytes.
