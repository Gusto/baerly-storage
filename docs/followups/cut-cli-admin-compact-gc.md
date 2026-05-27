# Cut `baerly admin compact` + `baerly admin gc` (verb shells)

**Severity: MEDIUM. Pre-launch cut. Manual triggers wrapping
scheduled maintenance — the on-call escape hatch for an audience
that does not own on-call.**

> **Second-pass review (2026-05-26).** A subagent argued for
> rejection under exception #3, citing deployers without a
> scheduler. That argument was weak: the verbs are citty wrappers
> over `compact()` / `runGc()` SDK functions any Node deployer
> (including container-only / air-gapped) can call directly via a
> one-shot Node script. The verbs don't *unblock* a deploy
> population — they add ergonomics. The discovery gap (a user not
> knowing to run compact periodically) is covered by `baerly
> doctor`'s cron-trigger check, which IS load-bearing under
> exceptions #1 and #3. Cut stands.

Both verbs are manual triggers for one pass of the maintenance
loop, with `--cloudflare-free-tier` profile caps and `--min-entries`
threshold overrides.

- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/admin/compact.ts`
  (~147 LoC)
- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/admin/gc.ts`
  (~123 LoC)

## The case for cutting

The scheduled maintenance loop already runs on cron (CF Workers
Cron Trigger / `node-cron`). The verbs exist as "on-call escape
hatch" per their own JSDoc — an on-call posture the audience
explicitly does not have:

- Thesis criterion #2: "No on-call for an app with fifteen users."
- Audience §: "an engineer's Saturday side project," "a $20/mo
  ChatGPT subscriber with a dream."

The `--min-entries` knob is the canonical "optional flag no one
in the prototype tier will tune" — a production-grade compaction-
policy override on a hello-world bucket. The `--cloudflare-free-tier`
profile cap is real ceiling arithmetic, but it belongs in the
kernel's default profile pick, not as a verb flag.

GC won't even sweep until the 7-day grace period elapses, making
back-to-back manual invocations a no-op users will be confused by
("I ran compact and gc but my bucket size didn't change"). The
verb shape invites misuse.

## What to do

1. Delete `packages/cli/src/admin/compact.ts` and
   `packages/cli/src/admin/gc.ts` (the verb shells).
2. **Keep** the underlying SDK functions (`runScheduledMaintenance`,
   `compact()`, `runGc()`) — they're load-bearing kernel mechanics.
3. Drop the rows from `CLAUDE.md`'s verification table.
4. If a real on-call moment materializes post-launch, a one-shot
   SDK call in a Node REPL suffices.

## What gets harder after

- An operator who wants to trigger a compaction right now has no
  CLI verb. **Acceptable** — `node -e 'await (await import(...)).compact(...)'`
  is two lines for the rare case.
- The `--cloudflare-free-tier` profile cap loses a user-facing
  surface. **Acceptable** — kernel picks the right profile by
  default from the target.

## Notes

This is a verb-shell cut, not a kernel-machinery cut. The
maintenance loop, the profile arithmetic, and the test gates
all stay. We're just removing two citty wrappers that exist to
make production-grade ops gestures available to an audience
that won't make them.

## Related cuts

- Part of the **admin verb bloat** theme.
- Pairs with `observability-trim-v2.md`'s critique of
  `runScheduledMaintenance` per-tick canonical-line enrichment —
  same underlying point: no human in this audience watches
  maintenance output.
