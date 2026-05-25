# `randomized.test.ts > local-fs > causal consistency all-to-all` intermittent flake

**Severity: LOW. Reproduces once across two full-suite runs; passes
deterministically when run in isolation.**

Observed during the `graduated-auth` workstream while verifying
ticket 03 (commit `a824fe3`). A full `pnpm test:agent` run failed at:

```
FAIL  |default| tests/integration/randomized.test.ts >
  randomized (Db + Writer) > local-fs >
  causal consistency all-to-all, single key (multi-instance)

AssertionError: expected true to be false // Object.is equality
- false
+ true
  ❯ handle tests/fixtures/randomized-cascade.ts:355:32
```

Re-running the same file in isolation
(`pnpm exec vitest run --project=default tests/integration/randomized.test.ts`)
passed all 4 variants in ~1.3s. Subsequent full-suite runs (verify
gates for tickets 04, 05, 06, 07) also passed without retrying any
seed. The failure has not reproduced.

## Why it's interesting

`randomized.test.ts` is the all-to-all causal-consistency cascade
across four storage adapters; the `local-fs` variant uses
`LocalFsStorage` from `@baerly/dev`. The cascade is fault-injection-
driven — `FC_NUM_RUNS` is a no-op for it (see CLAUDE.md verification
table) — so the variation between runs is the Node scheduler /
disk-cache state, not fast-check arbitraries.

The most likely causes, in order:

1. **Sibling-test contamination on shared tmp roots.** The cascade
   spins up N `Db` + `Writer` instances pointing at the same
   `mkdtemp` root. A neighbouring test in the default project that
   also uses `mkdtemp` (or that runs heavy disk I/O) could nudge
   inode cache warmth or fsync timing. Vitest pool defaults to
   threads with fresh module graphs but shares the same filesystem.
2. **Pool worker reuse across files.** Vitest can re-use worker
   threads. If a prior test leaks an unclosed `LocalFsStorage` write
   into the cascade's working dir, the all-to-all observer could see
   an unexpected key.
3. **fsck-style read-after-write timing on `current.json` CAS.**
   `LocalFsStorage`'s atomic rename + content-addressed ETag is
   correct on POSIX (rename is atomic on the same FS), but the
   cascade asserts on the observability of a CAS-rotated etag from
   another writer's view. macOS APFS has rare windows where
   `rename`'s linearisation is delayed across volumes — possible
   but unlikely on a single tmpdir.

## How to chase it

If it reproduces, the fastest signal is:

```sh
# Reproduce the failing context:
pnpm test:agent  # full suite; observe the same FAIL

# Then narrow:
pnpm exec vitest run --project=default \
  tests/integration/randomized.test.ts \
  --reporter=verbose --pool=forks --poolOptions.forks.singleFork=true
```

`--pool=forks --singleFork` rules out worker-reuse contamination.
If isolating the cascade still passes but full-suite fails, the
next step is bisecting which sibling file primes the failure
(`vitest --shard` or running the cascade as the LAST file in the
default project's glob).

The `system.knowledge_base` dump at the start of the failure
message (the big multi-line object literal printed via
`console.error(system.knowledge_base)` on
`tests/fixtures/randomized-cascade.ts:353`) is the canonical
postmortem artifact — capture it on the next repro.

## Why we're not chasing it now

- Not reproducible after one observed failure.
- Local-fs is the cheapest variant of a property-based protocol
  test; the kernel invariants it gates (causal consistency under
  the all-to-all observer) are also covered by the in-memory
  variant in the same file, plus `tests/unit/consistency.test.ts`,
  plus the `node-minio` and `cloudflare-r2` variants when their
  gates run.
- Pre-launch agent friction priorities sit above kernel-test
  hardening at the moment.

## Out of scope

This followup is observation-only. The graduated-auth workstream
did not touch `randomized-cascade.ts`, `LocalFsStorage`, or the
underlying `Writer`/`Db` paths in a way that should affect causal
consistency. If a future workstream touches any of the above,
re-validate the suite under `--pool=forks --singleFork` before
shipping.
