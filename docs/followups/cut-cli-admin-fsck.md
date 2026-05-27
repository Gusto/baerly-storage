# Cut `baerly admin fsck`

**Severity: HIGH. Pre-launch cut. 445-LoC consistency walker whose
reference class (e2fsck, pg_amcheck) is wrong for a strongly
consistent CAS-advance system on S3.**

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
