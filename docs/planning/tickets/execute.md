# Execute: first-touch DX overhaul

**For a fresh session.** This plan is self-contained. You don't
need any prior chat context — read this file, then `docs/planning/
tickets/README.md`, then the individual ticket files as you reach
each phase.

You are the **orchestrator agent**. You will not write the
implementation code yourself. You will:

1. Set up a feature branch + worktree.
2. Dispatch implementation work to subagents (each in its own
   isolated worktree), one ticket per subagent.
3. Merge each subagent's branch back into the integration branch,
   running verification gates between phases.
4. Open a PR back to `main` when everything is green.

## Quick start (what you do first)

```sh
# 1. Verify you're at the right base commit.
git rev-parse --abbrev-ref HEAD                  # expect: unify-examples-templates OR main
git log --oneline -3
# You should see commit 103289c ("refactor(examples,create-baerly):
# unify scaffolding into examples/ catalog") in recent history.
# If not, stop and read `Prerequisites` below.

# 2. Create the integration branch off current HEAD.
git checkout -b first-touch-dx

# 3. Confirm the tickets are present.
ls docs/planning/tickets/                        # expect: README.md, execute.md, 00..04-*.md
```

Then continue with **Phase A** below.

## What you are building

After this work merges, the canonical first-touch flow is:

```sh
pnpm install && pnpm -r build
pnpm -F create-baerly pack
pnpm -F @baerly/cli pack

pnpm dlx file:/.../create-baerly-0.1.0.tgz my-app  # interactive wizard
cd my-app
pnpm install
pnpm dev   # → `baerly dev` → http://localhost:3000
```

Five tickets ship this:

| # | Ticket | Effort | Depends on |
|---|---|---|---|
| 00 | ADR 0020: `create-baerly` + `@baerly/cli` split rationale | 0.5d | — |
| 01 | `baerly dev` unified local-dev verb | 2d | — |
| 02 | `create-baerly` interactive wizard via `@clack/prompts` | 1.5d | — |
| 03 | Scaffolded `scripts.dev` calls `baerly dev` | 0.5d | 01 |
| 04 | Staged `pnpm pack` install path + README rewrite | 1d | 01, 02, 03 |

Each ticket file (`docs/planning/tickets/0N-*.md`) is self-contained
with all the file paths, line numbers, code shapes, and verification
commands an implementing agent needs.

## Prerequisites

Before running Phase A, confirm:

1. **You are at or above commit `103289c`** in the current branch's
   history (`git log --oneline | grep 103289c`). That commit landed
   the manifest-driven `examples/`-as-templates work this builds on.
   - If `unify-examples-templates` has already merged to `main`,
     branch off `main` instead.
   - If `unify-examples-templates` is unmerged but a colleague has
     a newer state, rebase / fetch first.
2. **The working tree is clean.** `git status` shows no uncommitted
   changes. If not clean, ask the user before proceeding.
3. **Repo verification is green at HEAD.** Run `pnpm install` then
   `pnpm verify` once. If red on HEAD, fix or surface to the user
   before dispatching subagents — they will inherit the red state
   and waste cycles diagnosing it.
4. **You have access to the `Agent` tool with `isolation:
   "worktree"` and `subagent_type: "general-purpose"`.** This plan
   depends on isolated subagent worktrees for the parallel phase.
   If your harness doesn't support worktree isolation, fall back to
   the **Sequential fallback** at the bottom of this document.

## Branch + worktree topology

```
main
 └── unify-examples-templates (or merged into main)
      └── first-touch-dx                ← integration branch (you create this)
           ├── ft-dx/00-adr             ← subagent T01's branch (isolated worktree)
           ├── ft-dx/01-baerly-dev      ← subagent T02's branch
           ├── ft-dx/02-wizard          ← subagent T03's branch
           ├── ft-dx/03-templates       ← subagent T04's branch (Phase B)
           └── ft-dx/04-pack-readme     ← subagent T05's branch (Phase C)
```

Subagent branches are created automatically by `Agent({ isolation:
"worktree" })`; you don't `git branch` them yourself. You merge each
back into `first-touch-dx` after the subagent returns and you've
verified its work.

## Phase A — parallel dispatch (tickets 00, 01, 02)

**Goal.** Three independent tickets, dispatched simultaneously,
each in its own worktree. They touch separate files (verified — see
each ticket's "Conflict notes" section) so no merge collision is
expected.

### A.1 Dispatch (single message, three Agent tool calls)

Send **one message with three parallel `Agent` tool calls** — this
runs them concurrently. Use these arguments per subagent (paste the
prompts verbatim; they cite the ticket files which contain the rest
of the context):

```
Agent #1 — T01 (ADR):
  description: "Implement ticket 00 — ADR 0020"
  subagent_type: "general-purpose"
  isolation: "worktree"
  prompt: see § A.2 below
  run_in_background: true

Agent #2 — T02 (baerly dev):
  description: "Implement ticket 01 — baerly dev"
  subagent_type: "general-purpose"
  isolation: "worktree"
  prompt: see § A.2 below
  run_in_background: true

Agent #3 — T03 (clack wizard):
  description: "Implement ticket 02 — clack wizard"
  subagent_type: "general-purpose"
  isolation: "worktree"
  prompt: see § A.2 below
  run_in_background: true
```

Use `run_in_background: true` so the three calls return immediately
and you're notified as each completes. While they run, you have no
other work to do — wait for the notifications. Do not poll, do not
sleep.

### A.2 Subagent prompt template

For each subagent, paste this prompt, substituting the ticket path
and a one-line summary at the top:

```
You are implementing ticket <PATH> from baerly-storage's first-
touch DX overhaul. The ticket file is self-contained — read it
end to end before writing code.

Setup (already done for you):
- Your worktree is branched from `first-touch-dx`.
- Your branch name is auto-generated; treat it as your work branch.
- `pnpm install` may not have been run in this worktree yet; run
  it once at the start if `node_modules` is absent.

Constraints:
- Implement exactly what the ticket specifies. Do not refactor
  unrelated code. Do not add features beyond the ticket.
- Follow `CLAUDE.md` (toolchain: pnpm, vitest, tsgo, oxlint,
  oxfmt, rolldown). Relative imports use the `.ts` extension.
- Atomic commits, conventional-commits style (e.g.
  `feat(cli): add baerly dev command`). One commit per ticket is
  fine if cohesive; split if it's two distinct units of work.
- Run the ticket's "Verification" block in full before reporting
  done. The ticket gives exact `pnpm` commands.
- Do NOT push your branch. The orchestrator will merge.

When done, return a single message containing:
1. Branch name (from `git rev-parse --abbrev-ref HEAD`).
2. Commit SHA(s) you made.
3. Files changed (output of `git diff --name-only first-touch-dx..HEAD`).
4. Verification output: paste the last line of each `pnpm`
   command from the ticket's Verification section.
5. Anything you deviated from in the ticket and why (one or two
   sentences, or "no deviations").

Do not open a PR. Do not push. Do not modify the integration
branch. Stay inside your worktree.
```

### A.3 Per-subagent ticket path

Drop in the right path at the top of each prompt:

- Agent #1: `docs/planning/tickets/00-create-baerly-cli-split-adr.md`
- Agent #2: `docs/planning/tickets/01-baerly-dev-command.md`
- Agent #3: `docs/planning/tickets/02-create-baerly-interactive-wizard.md`

### A.4 When all three return

For each subagent (in the order they finished — order doesn't
matter, no conflicts expected):

```sh
# In your integration worktree (the first-touch-dx checkout):
git fetch <subagent-worktree-path>                      # or whatever your harness exposes
git merge --no-ff <subagent-branch> -m "merge: T0N — <title>"
```

If the Agent tool's worktree isolation doesn't surface a remote
ref, the alternative is to `git fetch` from the subagent's worktree
path directly (`git fetch /tmp/<worktree-path> <branch>:<branch>`).
The exact mechanic depends on your harness; consult the
`superpowers:using-git-worktrees` skill if available.

**Gate before continuing to Phase B:**

```sh
pnpm install                                            # in case T02 added @baerly/adapter-node
pnpm verify
pnpm test
pnpm -F create-baerly test
pnpm -F @baerly/cli test
```

All four must pass. If any fail, do not proceed to Phase B —
either fix in-place on `first-touch-dx` (small issues) or send the
relevant subagent a follow-up via `SendMessage` to re-implement
(larger issues). Re-merge.

### A.5 Conflict-resolution playbook (Phase A)

The tickets are file-disjoint by design, but a few sites are worth
sanity-checking after merge:

- **`packages/cli/package.json`** — T02 only adds
  `@baerly/adapter-node` to `dependencies`. Nothing else in Phase
  A touches it.
- **`packages/create-baerly/package.json`** — T03 adds
  `@clack/prompts`. Nothing else in Phase A touches it.
- **`packages/create-baerly/rolldown.config.ts`** — T03 adds
  `@clack/prompts` to the `external:` list. T01 (docs) doesn't
  touch it; T02 doesn't either.
- **`docs/adr/README.md`** — T01 adds one index entry. Sole
  toucher in Phase A.

If a conflict surfaces, prefer the **union** of both edits over a
"pick one" — the tickets were designed to be additive.

## Phase B — sequential dispatch (ticket 03)

**Goal.** Ticket 03 wires the scaffolded `package.json:scripts.dev`
to invoke `baerly dev`. It depends on T02 having landed, so it
runs after Phase A.

### B.1 Dispatch (single Agent call)

```
Agent — T04 (templates wire):
  description: "Implement ticket 03 — templates use baerly dev"
  subagent_type: "general-purpose"
  isolation: "worktree"
  prompt: same template as A.2, with ticket path:
          docs/planning/tickets/03-scaffolded-dev-script-baerly-dev.md
  run_in_background: false   # short ticket; foreground is fine
```

You can run this foreground because the ticket is short and there's
nothing else to parallelize.

### B.2 Merge gate

```sh
git merge --no-ff <subagent-branch> -m "merge: T03 — templates use baerly dev"
pnpm install
pnpm verify
pnpm test
pnpm -F create-baerly test

# Manual smoke: scaffold from source and check the dev script
pnpm -r build
node packages/create-baerly/dist/index.js test-smoke --target=cloudflare --json /tmp/
grep -E '"dev":|@baerly/cli' /tmp/test-smoke/apps/server/package.json
# Expected: "dev": "baerly dev"  and  "@baerly/cli": "^X.Y.Z"
rm -rf /tmp/test-smoke
```

Don't proceed to Phase C until this passes.

## Phase C — sequential dispatch (ticket 04)

**Goal.** Stage publishing via `pnpm pack`, rewrite the root
README's Quick Start, update `docs/operating/day-one-gate.md`.

### C.1 Dispatch

```
Agent — T05 (pack + README):
  description: "Implement ticket 04 — pnpm pack + README"
  subagent_type: "general-purpose"
  isolation: "worktree"
  prompt: same template as A.2, with ticket path:
          docs/planning/tickets/04-pnpm-pack-install-path-and-readme.md
```

### C.2 Final integration gate

After the subagent returns and you merge:

```sh
git merge --no-ff <subagent-branch> -m "merge: T05 — pnpm pack + README"
pnpm install
pnpm verify
pnpm test
pnpm format:check

# Full end-to-end smoke
pnpm -r build
pnpm -F create-baerly pack
pnpm -F @baerly/cli pack

TARBALL=$PWD/packages/create-baerly/create-baerly-0.1.0.tgz
mkdir -p /tmp/ft-dx-smoke && cd /tmp/ft-dx-smoke && rm -rf my-app
pnpm dlx "file:$TARBALL" my-app --target=cloudflare --json
cd my-app && pnpm install && pnpm dev &
sleep 2
curl -sf http://localhost:3000/v1/since?app=my-app | head -1   # expect non-empty 200
kill %1
cd / && rm -rf /tmp/ft-dx-smoke
```

If the smoke fails, the README's instructions are wrong (most
likely) or one of the upstream tickets regressed. Diagnose, fix on
`first-touch-dx`, re-verify.

## Finalize — open PR back to main

```sh
cd <your-first-touch-dx-worktree>
git push -u origin first-touch-dx

# If unify-examples-templates is unmerged, base the PR on it.
# Otherwise base on main.
BASE=$(git ls-remote --heads origin main | wc -l) && [ "$BASE" -eq 1 ] && BASE=main || BASE=unify-examples-templates

gh pr create --base "$BASE" --title "First-touch DX: npm create baerly + baerly dev" --body "$(cat <<'EOF'
## Summary

- Adds `baerly dev`, a unified local-dev verb that boots a Node
  listener over `LocalFsStorage` regardless of deploy target;
  `--wrangler` flag delegates to `wrangler dev` for CF parity.
- Adds an interactive `@clack/prompts` wizard to `create-baerly`
  for the no-args TTY case; flag-driven and `--json` modes
  unchanged.
- Wires the scaffolded examples' `scripts.dev` to `baerly dev`.
- Stages distribution via `pnpm pack` (no public npm publish yet).
- Documents the architecture in ADR 0020.

Ships five tickets from `docs/planning/tickets/`:
- T00 — ADR 0020
- T01 — `baerly dev`
- T02 — `@clack/prompts` wizard
- T03 — scaffolded `scripts.dev` → `baerly dev`
- T04 — `pnpm pack` install path + README rewrite

## Test plan

- [ ] `pnpm verify` clean
- [ ] `pnpm test` green
- [ ] `pnpm -F create-baerly test` green
- [ ] `pnpm -F @baerly/cli test` green
- [ ] Manual: `pnpm pack` both packages, scaffold via `pnpm dlx`,
      `pnpm install`, `pnpm dev`, `curl /v1/since` returns 200
EOF
)"
```

## Failure recovery

**A subagent's verification fails inside its worktree.** Two
options:

1. **Send a `SendMessage` follow-up** with the failure output and a
   pointer to what to fix. The subagent retains its worktree and
   can iterate. Use this when the failure is a clear miss (test
   assertion off-by-one, missing file, etc.).
2. **Discard the subagent's branch** and re-dispatch a fresh Agent
   with a more pointed prompt. Use this when the subagent has
   gone off-rails (refactoring beyond scope, ignoring the ticket).

**A merge fails on Phase A.** Don't force-merge. Read both diffs,
decide whether the tickets need a clarifying tweak, edit the
relevant ticket file on `first-touch-dx`, then re-dispatch the
affected subagent.

**The Phase C smoke fails.** Most likely cause: README's tarball
filename doesn't match the actual `pnpm pack` output. Inspect
`packages/create-baerly/*.tgz` and `packages/cli/*.tgz`, update the
README to match. Re-run the smoke.

**You discover a ticket has a wrong file path or line number.** Fix
the ticket file on `first-touch-dx` as a separate commit before
dispatching the subagent that uses it. Don't ask the subagent to
infer.

## Verification matrix (rollup)

By the time you open the PR, all of these should be true:

| Check | Command | Expected |
|---|---|---|
| Typecheck + lint | `pnpm verify` | exit 0 |
| Default test suite | `pnpm test` | all pass |
| create-baerly suite | `pnpm -F create-baerly test` | all pass |
| @baerly/cli suite | `pnpm -F @baerly/cli test` | all pass |
| Format | `pnpm format:check` | exit 0 on changed files |
| Build | `pnpm -r build` | exit 0 |
| Pack create-baerly | `pnpm -F create-baerly pack` | `*.tgz` produced |
| Pack @baerly/cli | `pnpm -F @baerly/cli pack` | `*.tgz` produced |
| Tarball includes templates | `tar -tzf packages/create-baerly/*.tgz \| grep -c dist/templates/` | ≥ 2 |
| End-to-end smoke | scaffold + install + `baerly dev` + curl | 200 on `/v1/since` |
| ADR exists | `ls docs/adr/0020-*.md` | one file |
| ADR indexed | `grep 0020 docs/adr/README.md` | one match |

## Sequential fallback (if worktree isolation isn't available)

If `Agent({ isolation: "worktree" })` isn't supported by your
harness:

1. Skip the parallel dispatch. Stay on `first-touch-dx` in a single
   worktree.
2. Dispatch subagents sequentially, **without** isolation: T01 →
   T02 → T03 → T04 → T05. Each subagent works directly in the
   integration worktree.
3. Between subagents, run the merge gate's `pnpm verify && pnpm
   test` before dispatching the next.
4. Wall-clock time roughly doubles (no parallel work in Phase A),
   but the topology is simpler and merge conflicts are impossible.

Order in fallback mode: **T01 → T02 → T03 → T04 → T05** (T01 first
so a subsequent subagent can cite the ADR if needed; T02 before
T03 because T03 depends on the new `dev` verb existing in source).

## What you do NOT do

- Push to `origin` until **Finalize**.
- Open a PR until the **Verification matrix** is fully green.
- Touch the `main` branch directly.
- Modify the ticket files mid-execution unless you find a wrong
  file path / line number; in that case fix it on `first-touch-dx`
  as a separate commit and tell the user.
- Delete or move `docs/planning/tickets/` — the tickets are the
  record of decisions and stay in-tree.
- Squash the integration branch's merges. Each `merge: T0N` commit
  is the audit trail showing what landed in what order.

## What you report when done

A single end-of-turn summary containing:

1. PR URL.
2. Total commits on `first-touch-dx`.
3. Verification matrix row-by-row pass/fail (should be all pass).
4. Any deviations from the tickets (file paths corrected, scope
   expanded, etc.) — one bullet each.
5. Suggested follow-ups (e.g. the public-npm-publish ticket, watch
   mode for `baerly dev`).

That's it. Don't write code in this orchestration session yourself
unless `Sequential fallback` is in play or a ticket-file correction
is required.
