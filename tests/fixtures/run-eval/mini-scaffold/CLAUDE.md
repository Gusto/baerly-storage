# Mini scaffold for run-eval integration test.

This directory is copied verbatim by `eval/run.mjs` when
`EVAL_SCAFFOLD_OVERRIDE` points at it. It deliberately ships **just**
the post-scaffold prerequisites the runner checks: `CLAUDE.md` (for
the AGENTS.md/CLAUDE.md parity invariant) plus a stub
`apps/server/src/` tree so the acceptance checker has something to
walk.
