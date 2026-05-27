# Cut `baerly doctor`

**Severity: HIGH. Pre-launch cut. 412-LoC invariant walker that
duplicates what `wrangler` already surfaces inline.**

`baerly doctor --target=cloudflare` walks deploy invariants —
wrangler.jsonc presence, R2 bindings, secrets, CF Access
audienceTag hex validity, cron triggers, domain/routes coherence —
and emits ok/warning/error findings with `--fix` auto-creating
buckets.

- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/doctor.ts`
  (~142 LoC)
- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/doctor/cloudflare.ts`
  (~412 LoC)

## The case for cutting

The audience deploys via `pnpm baerly deploy`. Wrangler itself
surfaces the real failures — `wrangler.jsonc` parse errors, missing
secrets, R2 binding mismatches — inline at deploy time with stack
traces that point at the actual line.

A bespoke 412-line invariant walker borrows maturity from
k8s-style `cluster-admin` tooling that 30-write/min internal
trackers don't need. The thesis is explicit: **"No on-call for an
app with fifteen users"** (criterion #2). `baerly doctor` is the
on-call posture made explicit — six severity tiers, a `--fix`
auto-remediation flag, and a JSON envelope ready for piping to
a monitoring system that the audience doesn't run.

The Node target *already* doesn't have a doctor backend ("the
example IS the contract" — `doctor.ts` near line 128). That's
the right answer for CF too.

## What to do

1. Delete `packages/cli/src/doctor.ts` and `packages/cli/src/doctor/`.
2. Drop the `doctor` row from `CLAUDE.md`'s verification table.
3. If specific bucket-creation logic in `--fix` is genuinely useful,
   fold it into `baerly deploy --create-missing-buckets` and let
   wrangler error normally on the rest.
4. Remove any doc page that points at `baerly doctor` as a
   diagnostic step.

## What gets harder after

- A user mid-deploy with a misconfigured `wrangler.jsonc` gets the
  wrangler error directly instead of a curated baerly summary.
  **Acceptable** — wrangler errors are clear; the curation isn't
  doing load-bearing work.
- The CF Access audienceTag hex-format check loses its dedicated
  surface. **Acceptable** — a runtime check at server boot can
  surface the same error with the request that hits it; or the
  scaffold's `.env.example` documents the format.

## Related cuts

- This is part of the **admin verb bloat** theme (CLI has 6
  admin verbs + 4 top-level; this trim collapses it toward
  what the audience actually uses: `init`, `deploy`, `export`,
  `inspect`, `admin dump`, `admin restore`).
