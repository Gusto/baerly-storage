---
description: Default bias and backwards-compatibility discipline for code changes
paths: ["packages/**/*.ts", "packages/**/*.tsx", "scripts/**", "bench/**/*.ts", "examples/**/*.ts", "manual-e2e/**/*.ts"]
title: "Auto-load: change discipline"
audience: agent
summary: Triggers on source-code edits; routes the agent to docs/contributing/conventions/change-discipline.md.
last-reviewed: 2026-05-14
tags: [agent-rule, auto-load, discipline]
related: ["../../docs/contributing/conventions/change-discipline.md"]
---

# Change-discipline rules

Canonical content lives at [`docs/contributing/conventions/change-discipline.md`](../../docs/contributing/conventions/change-discipline.md).
Read that file before making non-trivial code changes — especially
before introducing compatibility shims or removing existing behavior.

## Cutting a field from a public function-arg type

Typecheck will not find every caller. The excess-property check fires
on object *literals* but not on spreads, so
`...(cond && { droppedKey: x })` compiles clean and carries the removed
key into the runtime call, where the narrowed API silently ignores it.

After any field cut, grep for both the direct form and
`\.\.\.[^)]*<droppedKey>:`. The spread variant is the one a green
`verify:agent` doesn't rule out.
