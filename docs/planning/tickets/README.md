# First-touch DX overhaul — ticket set

Five tickets that ship `npm create baerly@latest <name>` → `cd <name>
&& pnpm install && pnpm dev` as the canonical first-touch flow,
staged via local tarballs (no public npm publish).

**Total effort:** ~5.5 days. **Why now:** see ticket 00 (ADR 0020
captures the architectural rationale for the two-package split that
this work depends on).

**To execute this work**, see [`execute.md`](./execute.md) — a
self-contained orchestration plan for a fresh agent session
(branch + worktree topology, parallel subagent dispatch, merge
gates, final PR).

## Dependency graph

```
00 (ADR)        ── docs only; can land anytime
01 (baerly dev) ── blocks 03
02 (wizard)     ── parallel to 01
03 (templates)  ── after 01
04 (pnpm pack)  ── after 01 + 02 + 03 (final integration + README)
```

Recommended serial order: **01 → 02 → 03 → 04 → 00**. The ADR
lands last so it can cite the verbs the rest of the work shipped.
01 and 02 can run in parallel if two contributors / agents are
available — they touch separate packages.

## The tickets

- [00 — ADR 0020: `create-baerly` and `@baerly/cli` split](./00-create-baerly-cli-split-adr.md) (0.5d, low)
- [01 — `baerly dev` unified local-dev verb](./01-baerly-dev-command.md) (2d, medium)
- [02 — `create-baerly` interactive wizard via `@clack/prompts`](./02-create-baerly-interactive-wizard.md) (1.5d, low-medium)
- [03 — Scaffolded `scripts.dev` calls `baerly dev`](./03-scaffolded-dev-script-baerly-dev.md) (0.5d, low)
- [04 — Staged `pnpm pack` install path + README rewrite](./04-pnpm-pack-install-path-and-readme.md) (1d, low)

Each ticket is self-contained: an agent or contributor can start
from the ticket file alone, without consulting this index or the
chat that produced it.

## Out of scope across the set

- Publishing to public npm (separate follow-up ticket; needs
  registry choice, publish workflow, and decisions for the rest of
  the `@baerly/*` workspace packages).
- Watch mode / HMR for `baerly dev`.
- Additional templates (`helpdesk` etc.) as scaffolder targets.
- Migrating `baerly init` away from its current scaffolder-config
  boundary (the typed `defineConfig` boundary is intentional; ADR
  0020 covers it).
