---
"@gusto/baerly-storage": patch
---

Keep snapshot reclamation ahead of more frequent folds by recording a grace-aged fold floor in constant-size GC metadata. Superseded snapshots below that floor no longer occupy one candidate slot each for seven days. Deletion retains the existing grace, generation and fresh-manifest checks, and per-pass work budgets. The optional `gc/pending.json.snapshot_gc` field is additive; older binaries may discard it and safely restart the grace.
