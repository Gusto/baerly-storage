# Cut `baerly admin fsck`

**Status: REJECTED.** Kept under load-bearer exception #1
(kernel-bug tripwire). The original cut-case correctly identified
that consistency drift on a strongly-consistent S3 + CAS-advance
system is either a kernel bug or impossible — and that *is* the
exception #1 framing. `fsck` is the user-visible tripwire that
catches the "kernel bug" branch on the user's own bucket: a
regression in `compactor.ts` / `gc.ts` / `server-writer.ts` that
drops a log entry, a buggy custom `Storage` adapter that ACKs a
partial write, an operator who manually mutated bucket objects.
The CI gate (`phase5-crash-fuzz.test.ts`, `randomized.test.ts`)
catches these on `main`; `fsck` catches them on the user's bucket
against their own workload — exactly the "user feels it first when
something drifts" pattern in thesis §"What we keep even when it
looks like ceremony" exception #1. The e2fsck/pg_amcheck reference
class is a red herring: those tools target hardware corruption;
this one targets kernel-protocol divergence, which is the analogue
the thesis explicitly carves out a tripwire surface for.

See `docs/about/thesis.md` §"What we keep even when it looks like
ceremony" and `docs/followups/promote-surface-admission-adr.md`
test #6.

## Original analysis (preserved for context)

`baerly admin fsck` does a snapshot-hash + log-hole + index-drift
consistency walk with reserved exit code 4, plus `--indexes`,
`--fix`, and `--config` mode-switching.

- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/admin/fsck.ts`
  (~445 LoC)

## The case for cutting

The reference class is wrong:

- `fsck`, `e2fsck`, `pg_amcheck` are filesystem/RDBMS recovery
  tools for hardware-corruption regimes — bad blocks, torn writes,
  power-loss inconsistency.
- S3 has been strongly consistent since December 2020 (cited in
  `thesis.md` line 124).
- The kernel's CAS-advance invariant + content-addressed snapshots
  + immutable log entries mean "consistency drift" between snapshot
  / log / index is by construction either:
  - a kernel bug (which fsck won't fix — needs a kernel patch), or
  - impossible.

The exit-code-4-for-findings convention is `pg_dump --check`-flavor
borrowed maturity. Six severity tiers, JSON envelope, --fix mode —
all calibrated for the on-call posture the thesis says the audience
does not have.

Index drift specifically is already covered by `baerly admin
rebuild-index` (which the user would have to run anyway to
"fix" drift fsck reports). Having both is the **redundant
ceremony** failure mode flagged in `thesis.md` §4: two type-valid
paths to the same outcome — discover, then fix.

## What to do

1. Delete `packages/cli/src/admin/fsck.ts` and its citty
   subcommand wiring.
2. Drop the `admin fsck` row from `CLAUDE.md`'s verification
   table.
3. Keep `baerly admin rebuild-index` (if it exists; verify) — it
   is the right escape hatch when an operator suspects index
   drift.
4. If specific consistency walks are valuable for the kernel's
   own integration tests, keep them as test utilities under
   `tests/integration/` — not as a public CLI verb.

## What gets harder after

- An operator who suspects corruption has no diagnostic CLI.
  **Acceptable** — the diagnostic of last resort is "compare
  `baerly admin dump` between two replicas." The deep-walk a
  prototype-tier user would actually run is `inspect` plus a
  log read.
- The `--fix` flag's auto-remediation paths go away.
  **Acceptable** — every fix path either calls into
  `rebuild-index` or is a kernel-bug-class issue.

## Related cuts

- Part of the **admin verb bloat** theme. Pairs with `cut-cli-doctor-verb.md`,
  `cut-cli-admin-migrate.md`, and `cut-cli-admin-compact-gc.md`.
