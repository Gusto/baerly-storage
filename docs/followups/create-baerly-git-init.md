# `create-baerly` should `git init` + initial commit after scaffold

**Severity: MEDIUM. First-touch DX gap. Agents and humans both forget
to `git init` post-scaffold and lose the "clean baseline diff"
superpower for subsequent work.**

`create-baerly` writes ~30+ files into the output dir and stops. The
user has to remember to `cd <name> && git init && git add . && git
commit -m "..."` before their first edit, or the diff against an
empty baseline is unusable.

## What to do

After the scaffold write completes and before the success summary,
offer to init a git repo and create the initial commit. Skip
silently when:

- Already inside a git repo (the user is scaffolding into an existing
  workspace — detect via `git rev-parse --is-inside-work-tree`).
- `git` is not installed (`git --version` fails).
- `--no-git` flag was passed, or the wizard answered "no".
- `git config user.name` or `git config user.email` is unset
  (committing would fail anyway).

Otherwise:

1. `git init --initial-branch=main` (fallback to plain `git init` if
   the flag is unsupported; older gits predate it).
2. `git add .`
3. `git commit -m "<rich message>" --no-verify`

Rich commit message body — include version + pm + git versions, the
same way C3 does:

```
Initial commit (by create-baerly)

Details:
  create-baerly = <version from package.json>
  project name  = <appName>
  target        = <cloudflare|node>
  starter       = <minimal|react>
  package mgr   = <pm>@<pm version>
  git           = <git version>
```

`--no-verify` is correct here — no `lefthook` is installed yet on
the fresh scaffold, and even if it were, the initial-commit pass
shouldn't be gated by hooks the user hasn't audited.

## Wiring

- New `git` arg on `CREATE_BAERLY_ARGS` in
  `packages/create-baerly/src/runner.ts`. Default-unset so the
  wizard can prompt; flag-driven callers pass `--git` / `--no-git`.
- New `promptGit` in `packages/create-baerly/src/prompts.ts`,
  defaulting to `true`. Skip the prompt when already inside a git
  repo (detect via the same `is-inside-work-tree` check; just set
  the wizard output to `false` and proceed).
- New module `packages/create-baerly/src/git.ts` with the detect /
  init / commit helpers. Keep it dep-free (spawn `git` directly via
  `node:child_process`); the bin must run before any
  `node_modules/` exists in the target dir.
- Call from `scaffold()` after `walk()` completes, or (cleaner) from
  `handleCreateBaerly` after `scaffold()` returns — that keeps
  `scaffold()` pure-file-write. The flag-driven branch in
  `handleCreateBaerly` needs the same fallthrough as `install` does
  today (`args.git === true` only when explicitly passed).

## In-place mode

`create-baerly .` (scaffold into current dir) needs care: if the
current dir is already inside a git repo (`is-inside-work-tree`
returns true), do not init. If it's NOT inside one, the dir
allowlist (see `scaffold-here-allowlist` in `scaffold.ts`) already
permits a pre-existing `.git/`, so a previously-init'd-but-empty
repo just gets the initial commit added on top.

## Tests

`packages/create-baerly/src/index.test.ts` already drives
`runCreateBaerly` in-process against a tmpdir. Add cases:

- `--git` on a fresh tmpdir creates `.git/`, commits, ends on `main`.
- `--no-git` does not create `.git/`.
- Default (no flag, non-TTY) does not run git (matches today's
  behavior — wizard is unreachable in vitest forks).
- Scaffolding into a pre-existing git repo (init in the tmpdir
  first) does not re-init or duplicate the commit.
- Git binary missing / `user.name` unset — gracefully skip with a
  warning to stderr, do not fail the scaffold.

## Out of scope

- Hooking up `lefthook` / `husky` in the scaffolded app. That's a
  template decision, separate followup if wanted.
- GitHub repo creation via `gh`. C3 doesn't do this either; the
  first commit is sufficient.
