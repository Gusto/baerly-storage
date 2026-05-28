---
title: Troubleshooting
audience: coder
summary: "Common pain points: test gating, local stack ports, fuzzer, formatting CI."
last-reviewed: 2026-05-12
tags: [troubleshooting, operations]
related: [./development.md]
---

# Troubleshooting

Operational and "I-just-checked-out-the-repo" knowledge that doesn't fit
in code or `CLAUDE.md`. If you hit something not in here, consider
adding it.

## Test gating

Which tests need infra (Minio, credentials), which skip by default, and
which are always green is documented in
[CLAUDE.md → Test gating](../../CLAUDE.md#test-gating). New failures in
*other* files are the signal worth investigating.

## Local stack ports

`pnpm dev:storage` brings up two services via `docker-compose.yml`:

| Service | Port | Purpose |
|---|---|---|
| Minio API | `:9102` | Stable S3-compatible endpoint. Most tests target this. |
| Minio console | `:9103` | Web UI at <http://127.0.0.1:9103> (login `baerly` / see compose file). |
| Toxiproxy | `:9104` | Proxies `:9102` with chaos injection. Used by `randomized.test.ts` to simulate network failure. |
| Toxiproxy admin | `:8474` | For configuring toxics manually. |

The split matters: tests that want a *reliable* S3 use `:9102`; tests
that want to exercise retry/replay paths point one Baerly instance at
`:9104` and another at `:9102` so they share a backend but disagree
about reachability. See `randomized.test.ts`'s `unstableConfig`.

Toxiproxy's default config (in compose) creates a single `minio` proxy
with no toxics — tests add toxics at runtime via the admin port.

## What `pnpm test:randomize` actually does

`"test:randomize": "while pnpm test; [ $? -ne 1 ] ; do :; done"`

It loops `pnpm test` until a run exits non-zero — i.e. it's a *fuzzer*
that catches races and protocol violations missed by a single run of
`randomized.test.ts`. Run it for several minutes when:

- You touched `packages/server/src/writer.ts` or
  `packages/server/src/query.ts`.
- You changed timing constants in `packages/protocol/src/constants.ts`
  (`LAG_WINDOW_MILLIS`, `MANIFEST_LIST_LOOKAHEAD_MILLIS`, etc.).
- You're investigating a flaky test that reproduces "sometimes".

It is **not** a stress test (load) or a perf test (latency). It's a
property-based fuzzer realized as a shell loop.

## "Why is `pnpm format:check` red?"

It's red on `main`. ~20 pre-existing files don't match `oxfmt`'s
defaults; reformatting them all in one PR would touch unrelated diffs.
Use `pnpm format` to format only files you've touched, or diff your
output against `main` to see whether *your* edits added new violations.
The pre-commit hook does *not* run `format:check` for the same reason.

## "Pre-commit hook didn't fire"

`lefthook install` ran during your last `pnpm install`'s `prepare`
step. If you cloned with `--depth 1` or skipped install, run
`pnpm install` again. Verify with `cat .git/hooks/pre-commit` — it
should be a lefthook stub.

Bypass with `git commit --no-verify` for genuinely one-off cases (e.g.
WIP commits on a private branch). Don't bypass on merge commits or PR
branches.
