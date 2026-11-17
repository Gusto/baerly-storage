---
name: stacked-prs
description: Batch related work into one native GitHub stacked-PR set (`gh stack`) and merge it in one go. Use when you are about to open more than one related PR, open a PR that builds on another unmerged PR, link or merge a stack, or coordinate a batch of parallel worktree workers.
---

# Stacked PRs

Several related changes go out as one linear GitHub stack, reviewed per layer and merged together atomically. CI and branch protection run on every PR; the merge is all-or-nothing. Tool: the `gh-stack` extension (`gh stack --help`).

## When to stack

- Stack when PRs touch shared files or one builds on another. One layer per reviewable concern.
- Independent PRs that share nothing stay separate PRs off `origin/main`.
- One PR is not a stack; open it normally.

## Build the linear chain

1. Order layers bottom to top so each layer compiles and passes on its own.
2. Base each branch on the one below it, the bottom on `origin/main`. Use `origin/<branch>` for bases, never a same-named local branch that may be a different history.
3. Rebase bottom to top with `git rebase --no-update-refs`, so a rebase never moves sibling branch refs.
4. On a `bundle-sizes.json` conflict, take the lower layer's file and re-run `pnpm bundle-sizes --write` for that layer. Put the reason in the commit message.
5. Per layer: run the quick gates (`pnpm verify:agent`, the focused tests the layer touches). At the tip, once: `pnpm build:agent`, then full `pnpm verify:agent` and `pnpm test:agent`.

## Create the stack

1. For every branch, `git log HEAD..origin/<branch>` must be empty (or the branch not yet pushed). A stale tracking ref passes a force-push lease; fetch first.
2. `gh stack link` pushes local branches by name. If the names are checked out in other worktrees, run it from a scratch clone that has them as plain branches.
3. Link bottom to top:

   ```sh
   gh stack link --base main --open <bottom> ... <top>
   ```

   `--open` is required: draft PRs cannot merge. This pushes, creates or reuses PRs with chained bases, and creates the stack.

4. Set each PR's title and body with `gh pr edit <n> --title ... --body-file ...`, following `.github/pull_request_template.md`. No AI attribution.
5. Verify with `gh stack view --json` (order, bases, PR numbers) or `gh stack checkout <stack#>`.

## Review fixes

Fold a fix into the layer that owns it (fixup commit plus autosquash, or amend on that branch), then re-cascade: rebase every layer above it with `--no-update-refs`, re-run per-layer gates, and push each branch with a lease after comparing the remote tip. Re-running `gh stack link` with the same branches updates the stack.

## Wait for CI

Merge only when every PR is green on its final head SHA. After any push, re-check the head SHA before trusting a green run.

## Merge

```sh
gh stack merge <stack#> --rebase --yes
```

- Pass the stack number, not a URL. A bare number is read as a stack number first, then a PR number; passing a PR number merges everything up to that PR.
- Run it only on the owner's explicit go, and only from the coordinating agent. The auto-mode permission check denies it for subagents. A subagent's job ends at "all green, ready".
- `gh pr merge` refuses every stack member; do not try it.
- GitHub evaluates branch protection at merge time; a failing PR fails the whole merge.

## After the merge

- Rebase-merge rewrites SHAs, so ancestry checks (`git branch --merged`, `git cherry`) report merged branches as unmerged. Confirm with `gh pr list --state merged` and a tree diff: `git diff <old-tip> origin/main` should be empty (or only changes that landed after).
- Rebase any dependent work with `git rebase --onto origin/main <old-base>`, where `<old-base>` is the pre-merge commit the work was based on. Re-run its gates.

## Gotchas

- A stack whose other members merged still holds its last open PR. Linking that PR into a new stack fails with 422 "PullRequest.base is invalid". Run `gh stack unstack <old-stack#>` first (merged PRs stay put), then `gh stack link` again.
- `gh stack link` with a branch that has an existing PR reuses it; it never removes PRs from an existing stack.

## Parallel batch pattern (optional)

For a batch of independent rows done by several workers:

1. One worktree per worker, branched off `origin/<base>`. One branch per row; rows that share files go in one worker as stacked commits or layers.
2. Serialize heavy commands across worktrees with a lock wrapper, so overlapping builds and broad suites do not cause load flakes. Wrap `build:agent`, `verify:agent`, `bundle-sizes`, full `test:agent`, adapter suites, and every `git commit` (lefthook). Focused per-file tests run unwrapped. Keep the script outside the repo (scratchpad) and delete it and its lock at the end.

   ```sh
   #!/bin/sh
   # usage: heavy.sh <cmd> [args...]
   export PATH="$PATH"   # set the PATH your tools need here
   LOCK="${HEAVY_LOCK:-/tmp/baerly-heavy.lock}"
   until mkdir "$LOCK" 2>/dev/null; do sleep 2; done
   trap 'rmdir "$LOCK"' EXIT INT TERM
   "$@"
   ```

3. One assembler rebases the layers bottom to top as above, then runs the full gates once at the tip.
4. An independent reviewer reads the branch diffs, not the coordinator's conclusions. Fix findings in the owning layer before `link`.
5. Do not let workers merge. The coordinator links, waits for CI, and merges on the owner's go.
