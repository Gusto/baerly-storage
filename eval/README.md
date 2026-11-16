# Baerly zero-shot eval harness

A manual, opt-in eval that measures how well a fresh Claude agent can use
the published `@gusto/baerly-storage` surface zero-shot — no in-context
examples, no repo source, no `AGENTS.md` steering (by default). The agent
is given only `dist/API.md` + `dist/*.d.ts` and asked to write a
`solution.ts` for each task.

This is **not a CI gate**. The harness self-tests (`eval/*.test.ts`) run
in the default vitest project and are green-on-main; those are the gate.
The live eval run is a developer/maintainer tool that costs tokens.

## How the agent runs

Each attempt spawns headless Claude Code (`claude -p`) in a fresh empty
directory under `os.tmpdir()`, outside the repo, with
`--tools Write --setting-sources "" --strict-mcp-config
--no-session-persistence --permission-mode acceptEdits --model <alias>`
and `CLAUDECODE` unset in the child env. The surface and task go in on
stdin. The agent has the Write tool only: no repo file, `CLAUDE.md`,
settings, MCP server or other tool reaches it. `--bare` is not used
because it skips keychain reads and drops the subscription login.

**The agent runs under Claude Code's own system prompt, not a bare API
call.** Pass rates measure "Claude Code, given only the published
surface", and they bill the maintainer's Claude Code login. Each result
records the model alias and `claude --version`.

The agent's `solution.ts` is copied into an in-repo sandbox
(`eval/.sandboxes/`, gitignored) for checking, so third-party imports such
as `zod` resolve like they do in a real app while
`@gusto/baerly-storage` still resolves to the built `dist/`.

## Lifecycle

1. Build the dist: `pnpm build` (the agent is fed the built artifacts).
2. Make sure `claude` is logged in (`claude auth login`).
3. Run: `pnpm eval --model=opus` (all tasks, 5 runs each).
4. Inspect `eval/results/<timestamp>.json` and the printed summary.
5. Optionally refresh `docs/spec/attachments/eval-baseline.json` with
   the new numbers and commit.

The self-tests never spawn `claude`; the driver takes an injectable
spawner.

## Tasks

Twelve tasks, each in `eval/tasks/<name>/`:

| Task | What it exercises |
| --- | --- |
| `insert-get` | Insert a row, then read it back by id via `.get(_id)` |
| `where-eq` | `.where({ field: value })` object-equality predicate |
| `range-dsl` | `gte` range predicate; the golden uses the callback builder |
| `delete-by-status` | Read all rows, filter by `status`, delete the non-`open` ones by id |
| `schema-validate` | `defineConfig` + a Zod schema; an invalid insert rejects |
| `get-by-id` | Discover the seeded row via `.all()`, then fetch it by id with `.get(id)` |
| `update-vs-replace` | By-id `update` as a merge patch: set one field, delete another (`null`), keep the rest |
| `error-code-branch` | Read `code` and `retriable` off the `BaerlyError` from a duplicate-`_id` insert |
| `retry-helper` | Write a retry wrapper that retries exactly the retriable codes and honours `retryAfter` |
| `ambiguous-commit` | Reconcile an `AmbiguousCommit` by reading the row back by `_id` before re-inserting |
| `top-n-ordered` | `order` + `limit` to get the top rows |
| `no-ne-operator` | Count rows "not equal" to a value, where no `ne` operator exists |

Each task directory contains:

- `prompt.md` — the task description fed to the agent.
- `check.ts` — the correctness checker (an exported `check(db, result)` function) run against
  the agent's `solution.ts`.
- `golden.ts` — a known-good reference solution (proves the task
  is solvable; verified by `eval/tasks.test.ts`).
- `setup.ts` (some tasks) — fixture data seeded before the checker runs.

### Coverage (and what this eval does NOT prove)

These tasks are a deliberately small, growable sample — not full
vocabulary coverage. They touch `insert` / `get` / `first` / `all` /
`count` / `update` / `delete`, the `where`, `order` and `limit` modifiers,
the `eq` / `gte` / `in` operators, and the `BaerlyError` `code` /
`retriable` / `retryAfter` model. `replace`, the `gt` / `lt` / `lte`
operators and pagination over `/v1/since` are not exercised. The
`retry-helper` and `ambiguous-commit` tasks check the agent's exported
function against fake operations, because a `MemoryStorage` `Db` cannot
raise `MaintenancePending` or `AmbiguousCommit`.

This eval measures whether an agent reaches a **working** answer zero-shot.
It does **not** prove the closed-vocabulary _type_ guarantees (e.g. that
`.where({ _id })` does not type-check while `.get(id)` does, or that
`or` / `ne` / `regex` / `exists` are absent). Those are locked at the type
level in `packages/protocol/src/collection-api.test-d.ts` (under the `tsgo`
gate) — that is their home, not here.

## Scoring

Pass-rate per task = (passing runs) / (total runs). A run passes when:

1. The generated `solution.ts` typechecks against `dist/*.d.ts` via
   `tsgo --noEmit`.
2. The checker (`eval/tasks/<name>/check.ts`) passes when run against
   the solution with a fresh `MemoryStorage` `Db`.

A pass-rate of **≥ 80% is the target signal**, not a hard gate. Lower
pass-rates indicate the surface or the task prompt needs improvement.

The `--with-agents-md` flag additionally feeds
`examples/minimal-node/AGENTS.md` (the steering doc) to the agent.
Comparing strict vs. with-agents-md pass-rates measures how much the
steering doc helps.

## Cost

Each agent run is one headless Claude Code session fed the full surface
(`dist/API.md` plus every `dist/*.d.ts`, about 425 KB or roughly 100k input tokens) plus the task prompt. It bills the Claude Code login,
not an API key. Use `--runs=1` or `--task=<name>` to reduce cost while
iterating.

## Baseline

`docs/spec/attachments/eval-baseline.json` holds the pass rates of the
last maintainer run, per model alias, with the CLI version and surface
hash. Refresh it by hand from `eval/results/<ts>.json` after a run.

## Out of scope

- Automated CI integration (the harness self-tests are the CI gate).
- Automated multi-model comparison (pass `--model` per run).
- Pluggable surface variants beyond `--with-agents-md` (the seam exists
  in `eval/surface.ts`; `surface_kind` and `surface_hash` are recorded
  in every report).
