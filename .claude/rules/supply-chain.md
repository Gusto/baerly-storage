---
description: Supply-chain conventions for dependency, install-policy and CI-workflow edits
paths:
  - "package.json"
  - "pnpm-workspace.yaml"
  - "examples/*/pnpm-workspace.yaml"
  - "docs/contributing/exception-register.json"
  - ".github/**"
title: "Auto-load: supply-chain conventions"
audience: agent
summary: Triggers on manifest, pnpm-workspace and .github edits; routes the agent to docs/contributing/conventions/supply-chain.md.
last-reviewed: 2026-11-17
tags: [agent-rule, auto-load, supply-chain]
related: ["../../docs/contributing/conventions/supply-chain.md"]
---

# Supply-chain rules

Canonical content lives at [`docs/contributing/conventions/supply-chain.md`](../../docs/contributing/conventions/supply-chain.md). Read it before editing.

Three things to know:

1. **A new dependency states its provenance, its install-script status, and whether it ships to users.** Runtime dependencies of published packages stay at the `CLAUDE.md` anti-pattern bar.
2. **Loosening a setting needs a comment and an entry in `docs/contributing/exception-register.json`** (reason, revisit trigger, expiry). `scripts/check-exceptions.ts` fails `pnpm verify` on an expired entry, an unregistered loosening, or an entry whose loosening is gone.
3. **Fail closed.** No `--ignore-registry-errors`, no `--ignore-unfixable`, no `trustPolicyExclude` to make a red install green.
