# Strengthen the "small and elegant" message in `thesis.md`

**Severity: MEDIUM. Pre-launch doc tightening. The thesis already
makes the right points; two of them are buried where they should
be top-level.**

Two specific edits to `docs/about/thesis.md`. Both are restructure
+ promote, not new content.

- `/Users/eric.baer/workspace/baerly-storage/docs/about/thesis.md`

## Edit 1 — Promote "graduation is the success path"

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

## Edit 2 — Promote §4's "hallucinated vs redundant ceremony" to a first-class section

Thesis §4 (LLM-legible API) contains the strongest articulation
of the small-and-elegant philosophy — the **hallucinated vs
redundant ceremony** distinction. It's currently buried as a
sub-bullet under "criteria the rest of this document is shaped
around" (one of five criteria).

It should be its own first-class section heading, immediately
after the criteria list. Suggested title and shape:

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

This is the philosophical center, not a sub-bullet. Promoting it
makes ADR-002 readable on its own terms ("here's the doctrine the
ADR codifies") and gives the audit/cut conversations a single
canonical reference.

## Why both edits, together

The cut audit (this directory) repeatedly cites:

- "graduation is the success path" (justifies why ceilings stay
  small)
- "redundant ceremony" (justifies almost every ADR-002 violation
  cut)

Both phrases earn first-class billing in the thesis after the
audit ships. Together they give the prelaunch trim a coherent
"why" the user-facing thesis carries forward.

## What to do

1. Add the graduation paragraph to §"What prototype-tier storage
   needs" criterion #3.
2. Promote the hallucinated-vs-redundant-ceremony distinction to
   its own H2 section between "criteria" and "Plus one
   anti-feature".
3. Update the thesis `last-reviewed:` frontmatter.
4. Audit `cost-model.md`'s "cost is not the moat" callouts —
   they should link to the new graduation-is-success paragraph
   for reinforcement.

## What gets harder after

Nothing — these edits make existing principles explicit. No
behavior change.

## Related

- **`promote-surface-admission-adr.md`** — the ADR-meta
  companion: once the principles are first-class in the thesis,
  the ADR can cite them by name.
