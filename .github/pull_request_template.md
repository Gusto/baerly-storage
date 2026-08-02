<!-- Write for a maintainer reading this in six months, not for a reviewer
     watching you work. Default to short — a few sentences of framing is the
     norm, not the exception. Match length to the change: a one-line fix needs
     one line. A body that looks long and structured is not more valuable; it
     usually buries the framing under scaffolding.

     Delete any section that doesn't apply. Don't leave empty headings. -->

## What & why

<!-- The problem, then the change. Two to five sentences.

     Lead with the conclusion — someone who stops reading after the first
     sentence should still be correct about what this PR does.

     Don't restate the diff, don't tour the changed files, don't explain what a
     function does. The diff is right there. -->

## Key points

<!-- One line each. Tradeoffs accepted, alternatives rejected, and anything a
     maintainer would otherwise have to guess at or rediscover.

     This is the ONLY section that may mention an approach that was tried and
     abandoned, or a plan that changed along the way. One line, stated as a
     fact about the code — not as a story about how you got here:

       - Bounds the pre-image scan by a fixed GET budget rather than flooring it
         at `log_seq_start`: a floored walk that finds nothing computes no stale
         keys and leaks them silently.

     Not: "My original plan was to floor at log_seq_start, but after
     investigating I realized that sub-floor entries survive GC, so I decided
     instead to..." -->

## Verification

<!-- The commands you actually ran, and their results. Nothing else — no
     test-by-test descriptions, no coverage narration, no "all green ✅".

       | `pnpm verify:agent` | clean       |
       | `pnpm test:agent`   | 2617 passed |
       | `pnpm bundle-sizes` | 34/34       |

     Never claim a gate you didn't run. If you skipped one, name it and say why
     (missing infra, credentials, etc.). -->

## Notes for reviewers

<!-- Optional. Where to start reading, what's risky, what you're unsure about. -->

<!-- ROUTING — this content has a home, and it isn't this body:

       user-facing behavior change   → a changeset (`.changeset/*.md`)
       design rationale, invariants  → `docs/spec/` or `docs/adr/`
       why a constant has its value  → JSDoc at the constant
       a bundle-size rebaseline      → regenerated `bundle-sizes.json` + why,
                                       in the commit message
       work you didn't do            → an issue, linked here as one line

     Never include: a changelog of your branch, ticket bookkeeping beyond
     `Refs #N`, deferred-work inventories, file-by-file walkthroughs, sections
     defending something you chose not to build, or AI attribution.

     Proposing a maintenance, coordination, or background-work mechanism? Cite
     [change-discipline.md](../docs/contributing/conventions/change-discipline.md#operator-burden-test-for-new-mechanisms)
     and answer the three operator-burden questions explicitly. -->
