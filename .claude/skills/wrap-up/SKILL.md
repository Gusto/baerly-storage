---
name: wrap-up
description: End-of-session or post-merge cleanup for this repo — reconcile .plans with what landed, remove merged branches and worktrees, and fast-forward main. Use when the user says a PR merged, asks to clean up, wrap up, or whether they can close the session.
---

# Wrap-up

Do these in order. Report a short checklist at the end, and say plainly
what you skipped and why.

1. **What landed.** `gh pr list --author @me --state all --limit 15 --json number,title,state,headRefName,mergedAt`.
   PRs are rebase-merged, so `git branch --merged` and `git cherry` report
   merged branches as unmerged. Trust the PR state.
2. **Branches and worktrees.** Delete a branch only when its PR is
   `MERGED` and `git diff --quiet origin/main <branch> -- $(git diff --name-only $(git merge-base origin/main <branch>) <branch>)`
   shows its files match main. For each worktree (`git worktree list`):
   skip it if `git -C <wt> status --short` is non-empty, and report it.
   `.claude/worktrees/agent-*` worktrees stay locked after their agent
   exits; `git worktree unlock` before `git worktree remove`. Delete
   `backup/*` branches belonging to merged work. Leave branches you didn't
   create in this session alone unless the user says otherwise.
3. **Main.** `git switch main && git pull --ff-only`. Then rebuild
   `dist/` (`pnpm build:agent`) if the pull changed `packages/**`.
4. **Plans.** For each merged or opened PR and each ruling made this
   session, update the file that owns the fact per the program's
   `AGENTS.md` (one owner per fact; others link). Grep `.plans` for this
   session's branch names and PR numbers to find stale references:
   `rg -n --hidden --no-ignore '<branch>|#<pr>' .plans`. Record diagnosed
   flakes in `.plans/trackers/observed-test-issues.md`.
5. **Memory.** Save only durable lessons. Don't copy PR numbers, SHAs, or
   merge status into memory; `.plans` owns status.
