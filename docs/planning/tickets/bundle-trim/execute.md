# Execute: bundle-trim workstream

**For a fresh session.** This plan is self-contained. You don't
need any prior chat context — read this file, then
[`README.md`](./README.md), then the individual ticket files as
you reach each phase.

You are the **orchestrator agent**. You will not write the
implementation code yourself. You will:

1. Verify your worktree state.
2. Dispatch implementation work to subagents in isolated
   worktrees, one ticket per subagent (Phase A in parallel,
   Phase B serial).
3. Merge each subagent's branch back into the integration
   branch, running verification gates between phases.
4. Merge the integration branch back into local `main`. No
   remote PR.

## Quick start (what you do first)

```sh
# 1. Verify you're at the right base commit. This plan assumes
#    you're already in the integration worktree at
#    `../baerly-storage-bundle-trim` with branch `bundle-trim`
#    checked out off `main`. If not, set it up:
git rev-parse --abbrev-ref HEAD                  # expect: bundle-trim
git rev-parse main                               # remember this SHA — bundle-trim was branched off it

# 2. Confirm the tickets are present.
ls docs/planning/tickets/bundle-trim/            # expect: README.md, execute.md, 01..03-*.md

# 3. Baseline must be green BEFORE dispatching subagents.
pnpm install   # if not done; ignore prepare-hook failure on worktrees
pnpm verify
pnpm test       # `bundle-size.test.ts` passes today via skip: true on index.js + http.js
```

Then continue with **Phase A** below.

## What you are building

After this work merges, two structural moves clean up
`packages/server/src/index.ts` and one re-baseline updates
`tests/integration/bundle-size.test.ts`. The kernel barrel
slims to `Db`, `Table`, `Query`, error types, auth presets,
HTTP routing, schema, query helpers, indexes, and a handful of
config helpers — operator-side maintenance + observability are
behind their own subpath entries
(`@baerly/server/maintenance`, `@baerly/server/observability`).

The full first-touch flow is unchanged; only library-internal
import paths shift. The library isn't published, so consumer
churn is contained to this monorepo.

## Prerequisites

Before running Phase A, confirm:

1. **Working tree is clean** in the integration worktree.
   `git status` shows no uncommitted changes apart from any
   committed ticket files.
2. **Baseline verify + test are green.** `pnpm verify` exits 0
   and `pnpm test` reports `40 skipped` (the existing
   bundle-size + Minio-gated skips). If red, fix or surface to
   the user before dispatching subagents.
3. **You have access to the `Agent` tool with `isolation:
   "worktree"` and `subagent_type: "general-purpose"`.** This
   plan depends on isolated subagent worktrees for the parallel
   phase. If your harness doesn't support it, fall back to the
   **Sequential fallback** at the bottom of this document.

## Branch + worktree topology

```
main
 └── bundle-trim                          ← integration branch (your worktree)
      ├── bt/01-maintenance-subpath       ← subagent T01's branch
      ├── bt/02-drop-obs-reexports        ← subagent T02's branch
      └── bt/03-rebaseline                ← subagent T03's branch
```

Subagent branches are created automatically by `Agent({
isolation: "worktree" })`; you don't `git branch` them yourself.
You merge each back into `bundle-trim` after the subagent
returns and you've verified its work.

## Phase A — parallel dispatch (tickets 01 + 02)

**Goal.** Two file-disjoint structural moves, dispatched
simultaneously, each in its own worktree. Both edit
`packages/server/src/index.ts` but on disjoint line ranges
(01 = 47-55, 02 = 61-88).

### A.1 Dispatch (single message, two Agent tool calls)

Send **one message with two parallel `Agent` tool calls** — this
runs them concurrently. Use these arguments per subagent (paste
the prompts verbatim; they cite the ticket files which contain
the rest of the context):

```
Agent #1 — T01 (maintenance subpath):
  description: "Implement ticket 01 — maintenance subpath"
  subagent_type: "general-purpose"
  isolation: "worktree"
  prompt: see § A.2 below
  run_in_background: true

Agent #2 — T02 (drop observability re-exports):
  description: "Implement ticket 02 — drop observability re-exports"
  subagent_type: "general-purpose"
  isolation: "worktree"
  prompt: see § A.2 below
  run_in_background: true
```

Use `run_in_background: true` so the calls return immediately
and you're notified as each completes. While they run, you have
no other work to do — wait for the notifications. Do not poll,
do not sleep.

### A.2 Subagent prompt template

For each subagent, paste this prompt, substituting the ticket
path and a one-line summary at the top:

```
You are implementing ticket <PATH> from baerly-storage's
bundle-trim workstream. The ticket file is self-contained —
read it end to end before writing code.

Setup (already done for you):
- Your worktree is branched from `bundle-trim`.
- Your branch name is auto-generated; treat it as your work branch.
- `pnpm install` may not have been run in this worktree yet; run
  it once at the start if `node_modules` is absent. If the
  `prepare` lefthook script fails (worktree gotcha — the parent
  repo's core.hooksPath leaks), ignore it; deps are still linked.

Constraints:
- Implement exactly what the ticket specifies. Do not refactor
  unrelated code. Do not add features beyond the ticket. Do not
  adjust bundle-size budgets — that's ticket 03's job.
- Follow `CLAUDE.md` (toolchain: pnpm, vitest, tsgo, oxlint,
  oxfmt, rolldown). Relative imports use the `.ts` extension.
- Atomic commits, conventional-commits style
  (e.g. `refactor(server): move runScheduledMaintenance to maintenance subpath`).
  One commit per ticket is fine if cohesive; split if it's two
  distinct units of work.
- Run the ticket's "Verification" block in full before reporting
  done. The ticket gives exact `pnpm` commands.
- Do NOT push your branch. The orchestrator will merge.

When done, return a single message containing:
1. Branch name (from `git rev-parse --abbrev-ref HEAD`).
2. Commit SHA(s) you made.
3. Files changed (output of `git diff --name-only bundle-trim..HEAD`).
4. Verification output: paste the last line of each `pnpm`
   command from the ticket's Verification section.
5. Anything you deviated from in the ticket and why (one or two
   sentences, or "no deviations").

Do not open a PR. Do not push. Do not modify the integration
branch. Stay inside your worktree.
```

### A.3 Per-subagent ticket path

Drop in the right path at the top of each prompt:

- Agent #1: `docs/planning/tickets/bundle-trim/01-maintenance-subpath.md`
- Agent #2: `docs/planning/tickets/bundle-trim/02-drop-observability-reexports.md`

### A.4 When both return

For each subagent (order doesn't matter — file-disjoint):

```sh
# In your integration worktree:
git merge --no-ff <subagent-branch> -m "merge: T0N — <title>"
```

How you reach the subagent's branch depends on your harness. If
`Agent({ isolation: "worktree" })` uses on-disk worktree paths,
you can `git fetch <subagent-worktree-path>` to pull the ref;
otherwise consult the `superpowers:using-git-worktrees` skill.

**Gate before continuing to Phase B:**

```sh
pnpm install         # T01 changes the package.json exports map
pnpm verify          # catches every missed import-path rename via type errors
pnpm test            # default suite, including bundle-size with skip: true on the over-budget entries (still skipped at this stage)
# Optional but recommended:
pnpm dev:storage     # bring up Minio
pnpm test:adapters   # exercises both adapter packages, which T01 + T02 both touched
```

All must pass. If any fail, do not proceed to Phase B — either
fix in-place on `bundle-trim` (small issues like missed renames)
or send the relevant subagent a follow-up via `SendMessage`
(larger issues). Re-merge.

### A.5 Conflict-resolution playbook (Phase A)

Both tickets edit `packages/server/src/index.ts`, but on
disjoint line ranges:

- **T01** deletes `index.ts:47-55` (the maintenance re-export
  block).
- **T02** deletes `index.ts:61-88` (the observability re-export
  block).

If `git merge` raises a conflict on `index.ts`, the safe
resolution is the **union of both deletions** — both subagents
should have left the rest of the file untouched. Read the diff
to confirm one of them didn't also touch surrounding
re-exports; if they did, that's a scope creep — open a
SendMessage follow-up rather than papering over it.

Other potential conflict sites (verified disjoint):

- `packages/adapter-node/src/server.ts` — T01 splits out
  `runScheduledMaintenance` + `NODE_PROFILE`; T02 splits out the
  observability symbols. Different import lines, no conflict
  unless a subagent reformatted the import block.
- `packages/adapter-cloudflare/src/worker.ts` — same shape as
  adapter-node.
- `tests/integration/observability.test.ts` — only T02 touches
  it (no maintenance symbols imported here).

## Phase B — sequential dispatch (ticket 03)

**Goal.** With both moves landed, re-measure the bundle, update
the budget table, and close the followup.

### B.1 Dispatch (single Agent call)

```
Agent — T03 (re-baseline + ADR):
  description: "Implement ticket 03 — re-baseline + ADR + close followup"
  subagent_type: "general-purpose"
  isolation: "worktree"
  prompt: same template as A.2, with ticket path:
          docs/planning/tickets/bundle-trim/03-rebaseline-and-adr.md
  run_in_background: false   # short ticket; foreground is fine
```

Foreground is fine — the ticket is short and there's nothing
else to parallelize.

### B.2 Final gate

```sh
git merge --no-ff bt/03-rebaseline -m "merge: T03 — re-baseline + ADR + close followup"
pnpm install
pnpm verify
pnpm test            # bundle-size.test.ts now runs with NO `skip: true` flags
pnpm format:check
pnpm build           # confirm dist/maintenance.js is produced
```

All must pass. If `pnpm test` reports bundle-size failures, the
subagent's measured numbers were off — fix the BUDGETS table
inline on `bundle-trim` and re-run `pnpm test`. Don't ship with
flaky budgets.

## Finalize — merge integration branch back to local main

The user opted for "merged back into local main" — no remote
PR. Choose `--no-ff` to preserve the audit trail of the three
ticket merges:

```sh
# Switch to the main worktree (the original checkout, not the bundle-trim one):
cd /Users/eric.baer/workspace/baerly-storage
git switch main
git merge --no-ff bundle-trim -m "merge: bundle-trim workstream"

# Then clean up the integration worktree + branch:
git worktree remove ../baerly-storage-bundle-trim
git branch -d bundle-trim
```

If the parent worktree is on a feature branch (`feature/deep-research`
or whatever was checked out when this started), don't switch it.
The user may want to return to that branch — just do the merge
in a separate `git switch main` step and confirm with the user
before deleting the original feature-branch checkout.

## Failure recovery

**A subagent's verification fails inside its worktree.** Two
options:

1. **Send a `SendMessage` follow-up** with the failure output
   and a pointer to what to fix. The subagent retains its
   worktree and can iterate. Use this when the failure is a
   clear miss (one import-block split missed, off-by-one in
   the rolldown config, etc.).
2. **Discard the subagent's branch** and re-dispatch with a
   more pointed prompt. Use this when the subagent has gone
   off-rails (refactoring beyond scope, ignoring the ticket).

**A merge fails on Phase A.** Don't force-merge. Read both
diffs to confirm the line ranges actually are disjoint as
documented. If one subagent edited outside its assigned range,
that's the bug to fix.

**The Phase B test fails with a bundle-size budget violation.**
The subagent's measured numbers are stale. Re-measure with the
`measureClosure` semantics at
`tests/integration/bundle-size.test.ts:87-99`, update BUDGETS
inline on `bundle-trim`, re-run `pnpm test`.

**You discover a ticket has a wrong file path or line number.**
Fix the ticket file on `bundle-trim` as a separate commit
before dispatching the affected subagent. Don't ask the
subagent to infer.

## Verification matrix (rollup)

By the time `bundle-trim` merges into `main`, all of these
should be true:

| Check | Command | Expected |
|---|---|---|
| Typecheck + lint | `pnpm verify` | exit 0 |
| Default test suite | `pnpm test` | all pass; **zero `skip: true`** in bundle-size `BUDGETS` |
| Build | `pnpm build` | `dist/maintenance.js` exists alongside `dist/{index,auth,http,observability}.js` |
| Adapter suites | `pnpm dev:storage && pnpm test:adapters` | all pass |
| Followup closed | `grep -A2 'Status:' docs/followups/first-touch-dx.md` for item 2 | `Status: resolved` |
| ADR updated | `git log -1 -- docs/adr/0001-vendorless.md` on `main` | shows T03's commit |
| Maintenance imports clean | grep below | zero hits |
| Observability imports clean | grep below | zero hits |

Maintenance-import cleanliness grep (must return zero hits):

```sh
grep -rnE '\brunScheduledMaintenance\b|\bNODE_PROFILE\b|\bCLOUDFLARE_FREE_TIER\b|\bCLOUDFLARE_PAID_TIER\b|\bMaintenanceArgs\b|\bMaintenanceOptions\b|\bMaintenanceResult\b' \
  bench tests packages examples \
  | grep 'from "@baerly/server"' \
  | grep -v '/maintenance"'
```

Observability-import cleanliness grep (must return zero hits):

```sh
grep -rnE '\bconfigureObservability\b|\bgetLogger\b|\bCATEGORY\b|\bobservableStorage\b|\balsAwareRecorder\b|\bwithObservability\b|\bflushCanonicalLine\b|\bcreateObservabilityContext\b|\bRequestScopedMetricsRecorder\b|\brunWithContext\b|\bgetCurrentContext\b|\bpeekContext\b|\bdecideSample\b|\bgetEffectiveSampleRate\b|\bserializeError\b|\bFriendlyLogLevel\b|\bObservabilityConfig\b|\bObservabilityContext\b|\bObservabilityContextInit\b|\bObservationRow\b|\bMetricsSnapshot\b|\bMetricsSummary\b|\bCategoryName\b|\bFlushCanonicalLineOptions\b|\bSerializedError\b|\bUnit\b' \
  bench tests packages examples \
  | grep 'from "@baerly/server"' \
  | grep -v '/observability"'
```

## Sequential fallback (if worktree isolation isn't available)

If `Agent({ isolation: "worktree" })` isn't supported by your
harness:

1. Skip the parallel dispatch. Stay on `bundle-trim` in a
   single worktree.
2. Dispatch subagents sequentially, **without** isolation:
   T01 → T02 → T03. Each subagent works directly in the
   integration worktree.
3. Between subagents, run the merge gate's `pnpm verify &&
   pnpm test` before dispatching the next.
4. Wall-clock time roughly doubles (no parallel work in Phase
   A), but the topology is simpler and merge conflicts are
   impossible.

Order: **T01 → T02 → T03**.

## What you do NOT do

- Push to a remote. The user said "merged back into local
  main" — this is local-only.
- Open a PR.
- Squash merges. `--no-ff` per ticket is the audit trail.
- Touch the `main` branch directly (until Finalize).
- Modify the ticket files mid-execution unless you find a
  wrong file path or line number; in that case fix it on
  `bundle-trim` as a separate commit and proceed.
- Delete or move `docs/planning/tickets/bundle-trim/` — the
  tickets are the record of decisions and stay in-tree.

## What you report when done

A single end-of-turn summary containing:

1. Commits on `bundle-trim` (the `git log main..bundle-trim`
   range).
2. Final bundle-size numbers for all five entries (index, auth,
   http, observability, maintenance) — raw + gz.
3. Verification matrix row-by-row pass/fail (should be all
   pass).
4. Any deviations from the tickets (file paths corrected,
   scope adjusted, etc.) — one bullet each.
5. Suggested follow-ups, if any.
