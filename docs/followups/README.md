---
title: docs/followups/ — branch-scoped cleanup backlog
audience: meta
summary: One file per branch logging stale docs / drifted instructions to clean up later.
last-reviewed: 2026-05-13
tags: [followups, navigation]
related: ["../conventions/docs.md"]
---

# `docs/followups/` — branch-scoped cleanup backlog

This directory holds **transient backlog files**, one per branch
that found stale documentation, drifted agent instructions, or
comments out of sync with the code while doing its primary work.

**The job is to capture cheap, not to fix.** Each branch's main
work focuses on a specific deliverable; finds that aren't on
the critical path get logged here for a follow-on branch to
triage.

## Convention

- One file per producing branch: `<branch-slug>.md`.
- The file's frontmatter `status:` flips from `open` →
  `triaging` → `done` as the follow-on branch works through it.
- A `done` file can be deleted in the follow-on branch's
  cleanup commit; keep it around while any item is still
  `open`.

## Entry format

```
N. **<short title>** — <one-paragraph description>. Found in
   `<path:line>` while working on <ticket or context>. Suggested
   cleanup: <one sentence>. **Status:** open
```

Append-only within a file. Numbered list, monotonically
increasing. When fixing an entry, update its status inline; do
not renumber.
