---
description: Default bias and backwards-compatibility discipline for code changes
appliesTo: ["packages/**/*.ts", "packages/**/*.tsx", "scripts/**", "bench/**/*.ts", "examples/**/*.ts", "manual-e2e/**/*.ts"]
title: "Auto-load: change discipline"
audience: agent
summary: Triggers on source-code edits; routes the agent to docs/conventions/change-discipline.md.
last-reviewed: 2026-05-14
tags: [agent-rule, auto-load, discipline]
related: ["../../docs/conventions/change-discipline.md"]
---

# Change-discipline rules

Canonical content lives at [`docs/conventions/change-discipline.md`](../../docs/conventions/change-discipline.md).
Read that file before making non-trivial code changes — especially
before introducing compatibility shims or removing existing behavior.
