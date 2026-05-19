# Repo-config tuning: `lefthook.yml` and `.oxfmtrc.json`

**Severity: LOW. Two small repo-hygiene fixes. Bundle together
because they touch the same kind of file and the same risk
class.**

## 1. `lefthook.yml`: typecheck is unscoped, hook fires during rebases

`lefthook.yml`'s `typecheck` step has no `glob:`. Every commit
(including docs-only commits) runs the full project typecheck.
`tsgo` is fast — the wall-clock cost is bearable — but two
small fixes are essentially free:

```yaml
pre-commit:
  skip:
    - merge
    - rebase
  jobs:
    - name: typecheck
      glob: "*.{ts,tsx}"
      run: pnpm typecheck
    ...
```

The `glob` change saves a couple of seconds on the common
docs-only-commit path. The `skip: [merge, rebase]` change is the
high-value piece: today the hook fires during
`git rebase --continue` after manual conflict resolution and can
either reject the commit (frustrating mid-rebase) or surface a
typecheck error that's actually mid-conflict noise.

## 2. `.oxfmtrc.json` is effectively empty

```json
{ "$schema": "https://...", "ignorePatterns": [] }
```

No `printWidth`, `tabWidth`, `useTabs`, `semi`, `singleQuote`,
`trailingComma`, etc. The defaults presumably match the
repo's actual style today, but an explicit config is more
self-documenting for a 1.0 project — and insurance against an
oxfmt default flip silently reformatting the tree on upgrade.

**Fix:** Run `pnpm format` once and codify whatever options match
the resulting formatting. Even one or two explicit settings
(`printWidth`, `singleQuote`, `semi`) lock in intent. Avoid
listing options that are already the oxfmt default *if* you trust
oxfmt's defaults — but list at least the load-bearing ones.

## Why bundle these

Both touch a single repo-root config file, both are reviewable in
a 50-line diff, and both are "obvious in hindsight" once a future
change surfaces the implicit behaviour. One small PR closes both.

## Cross-references

- The doc-rot cleanup memory (`project_doc_rot_cleanup_shipped`)
  surfaced the lefthook race issue separately
  (`feedback_lefthook_stage_fixed_race`); that's about
  `stage_fixed: true`, not the typecheck glob — these are distinct
  fixes.
- Item I13 in the original next-batch.md was a duplicate; subsumed
  here.
