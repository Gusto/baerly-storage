# Trim `docs/about/cost-model.md` (M-size table + `pricing-log.md`)

**Severity: MEDIUM. Pre-launch trim. The "Alternative DBs at M
size" table contradicts the thesis line "Cost is not the moat";
`pricing-log.md` is a one-entry "trust artifact" performing
seriousness.**

Two doc surfaces in `docs/about/` are doing borrowed-maturity work
the thesis explicitly disclaims.

- `/Users/eric.baer/workspace/baerly-storage/docs/about/cost-model.md`
  §"Alternative DBs at M size" (the comparison table)
- `/Users/eric.baer/workspace/baerly-storage/docs/about/pricing-log.md`
  (one-row "trust artifact")

## The case for cutting

### The M-size comparison table

Thesis line 164 is unambiguous: **"Cost is not the moat."** Then
`cost-model.md` spends a whole table benchmarking Baerly against
D1 / Supabase / Neon / Firebase Blaze at M-size.

The "Read this as positioning, not a cost claim" caveat is doing
damage control on a table that wouldn't exist if the thesis line
were taken literally. The thesis line is right: a user who cares
about M-size $/mo should be **graduating**, not comparing.

The table also explicitly cites `consistency("eventual")` as the
optimization that closes the gap with D1 — which adds load to the
"keep that modifier" argument (see
`cut-api-consistency-eventual.md`).

### `pricing-log.md` as a separate file

"Append-only trust artifact" with one row from 2026-05-11 is
borrowing the maturity of a product with a real change history.
Pre-launch, this *is* the change history. A one-entry file
performing seriousness about price-change discipline is exactly
the borrowed-maturity pattern the deferred changes-iterator memo
§5 calls out.

The trust-artifact mechanism is good; the *file* is premature.

## What to do

### Cost-model trim

1. Delete the "Alternative DBs at M size" table from
   `cost-model.md` entirely.
2. Replace with a one-paragraph summary: "At M-size we're roughly
   4× D1 because we're paying for schemaless docs + multi-instance
   causal consistency you don't get on D1; pick the one that
   matches your job."
3. Drop the L-workload row (R2 Class B $1500/mo example) — the
   graduation-cliff point is in the workload-ceiling section
   already.
4. Keep the per-line-item rate table and the **cost ceiling**
   commitment (those are load-bearing; they justify the
   architecture).

### Pricing log collapse

1. Delete `docs/about/pricing-log.md`.
2. Replace with a short "Price history" subsection at the bottom
   of `cost-model.md` containing the same content.
3. Re-promote to a separate file *if* and *when* there are five
   or more entries.
4. Drop the `related:` frontmatter cross-references.

## What gets harder after

- A user comparing $/mo vs. D1 doesn't find the table.
  **Acceptable** — the comparison was teaching the wrong frame
  (cost as moat).
- The "trust artifact" pre-commitment to logging price changes
  loses its standalone file. **Acceptable** — the *commitment*
  lives in `cost-model.md`'s history section; the file existed
  to *perform* the commitment.

## Related cuts

- **`cut-cli-cost-verb.md`** — same theme: cost-projection
  ceremony for an audience that reads the cloud bill.
- **`cut-api-consistency-eventual.md`** — the M-size table cites
  this modifier; cutting the table removes one of its few users.
- **`docs/about/thesis.md` §"What this deliberately is not"** —
  the "Cost is not the moat" doctrine wins more weight when the
  cost-comparison surface goes away.
