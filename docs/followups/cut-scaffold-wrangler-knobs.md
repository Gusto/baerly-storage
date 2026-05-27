# Strip production-tier knobs from CF scaffolds' `wrangler.jsonc`

**Severity: MEDIUM. Pre-launch cut. Operational tuning knobs the
prototype-tier audience can't read and will trip over.**

CF scaffolds ship `wrangler.jsonc` with production-tier Worker
config: log sampling rate `0.1`, CPU-ms limit `50`, observability
on.

- `/Users/eric.baer/workspace/baerly-storage/examples/minimal-cloudflare/wrangler.jsonc:23-36`
- `/Users/eric.baer/workspace/baerly-storage/examples/react-cloudflare/wrangler.jsonc`
  (same shape)

Specific fields:

- `vars.LOG_LEVEL`
- `vars.LOG_SAMPLE` (set to `"0.1"` — drops 90% of logs)
- `limits.cpu_ms: 50`
- `observability.enabled`

## The case for cutting

These are operational knobs that the prototype-tier audience does
not know to interpret and will trip over the first time they
debug:

- `LOG_SAMPLE: "0.1"` means *drop 90% of logs*. The user will
  console.log something, not see it, and reach for ChatGPT
  asking why. **Borrowed maturity** — production-Worker observability
  posture imported wholesale into a hello-world.
- `cpu_ms: 50` is the free-tier limit, but pinning it
  *teaches the agent the limit exists* before they've felt the
  pain. Better to let the platform error naturally when the
  limit is hit, then the audience reads a clear platform error.
- `observability.enabled` is fine as a default but doesn't need
  to be in the scaffold's wrangler.jsonc — the wrangler default
  picks it up.

The thesis is explicit that observability ceremony belongs on the
graduation side (criterion #2: "No on-call for an app with
fifteen users").

## What to do

1. Strip `vars.LOG_LEVEL` and `vars.LOG_SAMPLE` from both CF
   scaffolds' `wrangler.jsonc`.
2. Strip the `limits.cpu_ms` block.
3. Strip `observability.enabled` (let wrangler default win).
4. Audit the scaffold worker code for any `env.LOG_LEVEL` /
   `env.LOG_SAMPLE` reads; remove the consumption.
5. Audit `loadDevVars` / `.dev.vars*` for related leftovers.
6. Pairs with `observability-trim-v2.md` cut #4 (head sampling)
   — if sampling is gone from the kernel, `LOG_SAMPLE` is doubly
   dead.

## What gets harder after

- A user who *does* want sampled logs has to add the knobs back.
  **Acceptable** — they're well into the on-call posture by then.
- A user hitting the 50 ms CPU limit gets the platform error
  rather than a pinned `wrangler.jsonc` line. **Acceptable** —
  same effective experience; one fewer baerly-specific surface
  to learn.

## Related cuts

- Part of the **scaffold weight** theme.
- Cross-references `observability-trim-v2.md` (#4: head sampling).
