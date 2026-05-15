# Bundle-trim workstream — ticket set

Three tickets that close out the open `bundle-size` budget item in
`docs/followups/first-touch-dx.md:67-86`. Two of them are
structural API-shape moves that happen to also shrink
`dist/index.js`; the third re-measures, re-baselines whatever
remains, and updates ADR-0001.

**Total effort:** ~1.5 days. **Why now:** the two over-budget
entries in `tests/integration/bundle-size.test.ts` have been
gated `skip: true` since 2026-05-14. The followup explicitly
proposes either trimming closure or re-baselining; the user
picked "do the obvious structural moves, then re-baseline what's
left." See ticket 03 for the re-baseline rationale.

**To execute this work**, see [`execute.md`](./execute.md) — a
self-contained orchestration plan for a fresh agent session
(branch + worktree topology, parallel subagent dispatch, merge
gates, finalize). The orchestrator merges the integration branch
back into local `main` directly (no remote PR).

## Dependency graph

```
01 (maintenance subpath)            ┐
                                     │── parallel (file-disjoint within `index.ts`)
02 (drop observability re-exports)  ┘
                                     ↓
03 (re-baseline + ADR-0001 + close followup)
```

01 and 02 both edit `packages/server/src/index.ts`, but on
disjoint line ranges (01 deletes lines 47-55, 02 deletes lines
61-88). They can run in parallel; if the merge surfaces a
conflict it means a subagent edited outside its assigned range
and the diff needs to be read.

Recommended order: **01 + 02 in parallel → 03**. 03 must run
last because it measures the post-trim closure size.

## The tickets

- [01 — `runScheduledMaintenance` → `baerly-storage/maintenance` subpath](./01-maintenance-subpath.md) (~0.75d, low)
- [02 — Drop observability re-exports from the kernel barrel](./02-drop-observability-reexports.md) (~0.5d, low)
- [03 — Re-baseline bundle-size budgets + ADR-0001 footnote + close followup](./03-rebaseline-and-adr.md) (~0.25d, low)

Each ticket is self-contained: an agent or contributor can start
from the ticket file alone, without consulting this README, the
execute.md, or the chat that produced them.

## Out of scope across the set

- **Replacing `@logtape/logtape`.** The library is `~85 KiB` raw of
  the observability chunk; swapping it for a minimal internal
  logger could shrink `dist/http.js` substantially, but the
  rewrite is multi-day and the user explicitly rejected it as
  ambition-chasing for a 1.6–7.7% regression.
- **Removing `auth` re-exports from the barrel.** Unlike
  maintenance and observability, auth presets are config-time
  and app-side — typical scaffolded apps call `sharedSecret(...)`
  or `bearerJwt(...)` in their server entry. The barrel
  re-export is justified.
- **Per-source byte attribution tooling.** Would tell us exactly
  which symbols cost which bytes, but the user prefers
  re-baselining over investigation when wins are ambiguous.
- **The public-npm-publish workstream** (open item #1 in
  `docs/followups/first-touch-dx.md`). Independent.
