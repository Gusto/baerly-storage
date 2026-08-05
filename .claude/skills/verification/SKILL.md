---
name: verification
description: Full catalog of this repo's verification, test, fuzz, bench, and operator commands, plus which test suites are gated behind Minio, credentials, Postgres, or Workerd. Use when a needed command is not in CLAUDE.md's resident table, when a test is skipping and the reason is unclear, or when running benches, mutation testing, manual e2e, or the baerly operator CLI.
---

# Verification, in full

`CLAUDE.md` carries the commands an agent runs in-loop. Everything else lives
here. Read only the file you need — each is self-contained.

- **[reference/commands.md](reference/commands.md)** — the full command table:
  every `verify:*` sub-check, the infra-gated and credentialed test suites,
  `test:mutate`, `model:multilevel`, `freeze:fold-stage0`, all `bench:*`, the
  `baerly` deploy/doctor/export/inspect/admin surfaces, `test:manual-e2e`, and
  the published `dist/API.md` + `dist/CHANGELOG.md` references.
- **[reference/test-gating.md](reference/test-gating.md)** — why a suite
  skipped: the `MINIO=1` / credentials / Postgres / `cloudflare-pool` gates,
  the four `randomized.test.ts` storage variants, and the always-green
  pure-unit list.

## Standing rules

Both apply for the rest of the session, not just the turn that loaded this.

- Don't pipe `verify:agent` / `test:agent` / `bundle-sizes` through
  `tail`/`head` — they are already compact, and empty output means the gate
  passed.
- Never call `vitest` via `pnpm exec vitest` or `./node_modules/.bin/vitest`;
  both skip the `pretest` build hook and leave `dist/` stale. `test:agent`
  does **not** rebuild `dist/` either — run `pnpm build` first when a test
  consumes it.
