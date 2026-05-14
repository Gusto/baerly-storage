# Scaffolding eval

End-to-end harness that drives the public scaffolding flow with a real
coding agent (Claude Code or Codex CLI), scores the resulting workspace
against per-app acceptance criteria, and writes a comparative report.

| File | Purpose |
|---|---|
| `run.mjs` | Orchestrator. Scaffolds a workspace, runs the agent, checks acceptance, scores the transcript, emits the report. |
| `score.mjs` | Stand-alone scorer for one transcript + acceptance JSON pair. |
| `check-acceptance.mjs` | Per-app acceptance checker (binary pass/fail bullets). Runnable on its own against any scaffold root. |
| `prompts/` | One Markdown file per corpus app — the version-pinned input fed to the agent. See `prompts/README.md` for the corpus table. |
| `runs/` | Per-run output (transcripts, diffs, stderr, env). Gitignored. |

Start at `node eval/run.mjs --help` for the full decision matrix.
The first eval pass is `pnpm eval:run -- --app todo --tool both --trials 3`.

**Do not edit a prompt to make a failing run pass.** The prompt is
the experimental variable; mutating it post-hoc invalidates the
comparison. If a prompt is buggy, fix it and re-run all the trials
that used the old version.
