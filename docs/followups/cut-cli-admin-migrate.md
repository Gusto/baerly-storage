# Cut `baerly admin migrate`

**Severity: HIGH. Pre-launch cut. Direct thesis violation — auto
migration is explicitly out of scope, yet this verb ships an auto
migration runner with version stamping.**

`baerly admin migrate` folds `(row) => row | null` across one
collection and writes a fresh L9 snapshot stamped with
`migrated_to`. The verb rejects `.ts` transform files and enforces
a `target-version` integer.

- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/admin/migrate.ts`
  (~170 LoC)

## The case for cutting

Thesis is unambiguous in two places:

- Line 158: **"No automatic schema migration. Migrations are
  versioned scripts."**
- Criterion #5: **"No DDL. The moment the loop requires
  CREATE TABLE, 'invent and preserve a schema across edits' is
  inserted into the part of the loop LLMs are worst at."**

What this verb actually ships *is* an automatic migration runner
with version stamping. That's the thing the thesis says we don't
do. The "versioned scripts" frame in line 158 means *the user owns
a `migrate-2026-05.ts` they run by hand* — not *we give them a
kernel-aware row-fold tool that stamps `migrated_to`*.

The artifact-tier audience handles schema drift two ways:

1. `_id`-keyed reads tolerating missing fields (the document
   model's whole point).
2. Graduating to D1/Postgres where real migration tooling exists.

Shipping a kernel-aware row-fold tool invites users to treat
baerly as a relational store with `ALTER TABLE` semantics —
re-introducing the exact "invent and preserve a schema across
edits" loop position the thesis says LLMs are worst at.

## What to do

1. Delete `packages/cli/src/admin/migrate.ts` and its citty
   subcommand wiring.
2. Drop the `admin migrate` row from `CLAUDE.md`'s verification
   table.
3. If any test or example references `baerly admin migrate`,
   delete it.
4. Audit `docs/` for any doc that recommends migrate as a flow;
   rewrite to either (a) the `_id`-tolerant read pattern, or (b)
   the graduation path via `baerly export`.

## What gets harder after

- A user who genuinely needs to backfill a field in 50K docs
  has no in-kernel tool. **Acceptable** — they write a Node
  script that reads via `Db`, transforms, and writes back. The
  scaffold pattern. This is the "versioned scripts" the thesis
  promises.
- The `migrated_to` snapshot stamp goes away. **Acceptable** —
  no real consumer in the prototype-tier audience.

## Notes

This is the single strongest cut in the audit: it's a direct
thesis violation, not a borderline call.
