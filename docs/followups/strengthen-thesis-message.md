# Strengthen the "small and elegant" message in `thesis.md`

**Status: PARTIALLY SHIPPED (2026-05-26).** Edit 2 landed in
expanded form (hallucinated vs redundant ceremony is now spelled
out as sub-bullets under criterion #4, not its own H2). A
companion §"What we keep even when it looks like ceremony"
section was added covering the three load-bearer exceptions
(kernel-bug tripwires, empirical LLM ergonomics, audience reach).
Edit 1 (graduation is the success path) remains unshipped.

**Severity: MEDIUM. Pre-launch doc tightening. The thesis already
makes the right points; two of them are buried where they should
be top-level.**

Two specific edits to `docs/about/thesis.md`. Both are restructure
+ promote, not new content.

- `/Users/eric.baer/workspace/baerly-storage/docs/about/thesis.md`

## Edit 1 — Promote "graduation is the success path" — NOT SHIPPED

The thesis says "graduate to D1 / Postgres" three times, always
as the *ceiling above which* the system stops being right. The
implicit message — **graduation is what success looks like, not
the failure mode** — is never stated.

Add one sentence to §"What prototype-tier storage needs" criterion
#3 ("Graduation path with no hostage situation"):

> *Graduation is the success path, not a failure mode.* A
> prototype-tier app that crossed the ceiling and moved to D1 is
> a baerly **win**, not a churn event. The "no hostage" promise
> is what makes the prototype-tier bet safe in the first place.

This is doctrine, not new policy — it makes load-bearing what's
already implicit, and it earns the right to push back on every
future feature that tries to extend the workload ceiling.

## Edit 2 — Promote §4's "hallucinated vs redundant ceremony" — SHIPPED (in-place)

Thesis §4 (LLM-legible API) contains the strongest articulation
of the small-and-elegant philosophy — the **hallucinated vs
redundant ceremony** distinction. It's currently buried as a
sub-bullet under "criteria the rest of this document is shaped
around" (one of five criteria).

**As shipped:** the distinction is now spelled out as named
sub-bullets directly under criterion #4 ("An API an LLM can use
from the type definitions alone"), with explicit "Fix:" lines
for each failure mode and an explicit pointer to ADR-002. This
is the in-place expansion, not the standalone-H2 promotion the
original edit called for. The in-place expansion is now the
canonical articulation referenced by ADR-002 and the followup
audit.

The originally-proposed standalone-H2 shape, preserved for
historical context:

> ## Two failure modes the surface has to prevent
>
> When an LLM authors against baerly, two distinct things can go
> wrong:
>
> 1. **Hallucinated ceremony.** The agent invents an API the
>    kernel does not ship (`.findOneById()`). Fix: teach the real
>    surface via `@example` blocks and the `dist/API.md`
>    quickref.
>
> 2. **Redundant ceremony.** The kernel ships two type-valid
>    paths for the same operation (`.get(id)` *and*
>    `.where({_id}).first()`). Fix: making one of the paths not
>    type-check. JSDoc steering does not override
>    training-distribution priors. The additive-only lock on the
>    public surface is codified in
>    [ADR-002](../adr/002-api-surface-lock.md).
>
> Every public-surface decision in baerly is held against these
> two failure modes.

## Bonus shipped — §"What we keep even when it looks like ceremony"

Not in the original doc but landed alongside Edit 2. Three
load-bearer exceptions to the cutting lens:

1. **Kernel-bug tripwires** — surfaces that let maintainers AND
   users catch protocol regressions before the invoice.
2. **Empirical LLM ergonomics** — pre-wired surfaces validated
   against real zero-shot scaffold use.
3. **Audience reach across deploy targets** — "self-hosted Node"
   includes container-only / air-gapped / no-PaaS.

Cited by `promote-surface-admission-adr.md` test #6 and by every
REJECTED followup in this directory.

## Why both edits, together (original framing)

The cut audit (this directory) repeatedly cites:

- "graduation is the success path" (justifies why ceilings stay
  small) — **still unshipped**.
- "redundant ceremony" (justifies almost every ADR-002 violation
  cut) — **shipped in-place under criterion #4**.

Both phrases earn first-class billing in the thesis after the
audit ships. Together they give the prelaunch trim a coherent
"why" the user-facing thesis carries forward.

## What to do (remaining)

1. ~~Add the graduation paragraph to §"What prototype-tier storage
   needs" criterion #3.~~ — still TODO.
2. ~~Promote the hallucinated-vs-redundant-ceremony distinction to
   its own H2 section between "criteria" and "Plus one
   anti-feature".~~ — shipped in-place under criterion #4 instead;
   re-promotion to standalone H2 is no longer load-bearing once
   the in-place expansion exists.
3. ~~Update the thesis `last-reviewed:` frontmatter.~~ — done.
4. Audit `cost-model.md`'s "cost is not the moat" callouts —
   they should link to the new graduation-is-success paragraph
   for reinforcement (still TODO; depends on Edit 1).

## What gets harder after

Nothing — these edits make existing principles explicit. No
behavior change.

## Related

- **`promote-surface-admission-adr.md`** — the ADR-meta
  companion: once the principles are first-class in the thesis,
  the ADR can cite them by name. The new §"What we keep…"
  section is cited by that ADR's test #6.
