# CF `.dev.vars.example` vs Node `.env.example` observability asymmetry

**Severity: LOW. Comparing the two examples side-by-side is harder
than it needs to be. One-line comment in each file solves it.**

`examples/minimal-node/.env.example:39-42` includes:

```env
LOG_LEVEL=info
LOG_SAMPLE=0.1
```

`examples/minimal-cloudflare/.dev.vars.example` does **not**
declare `LOG_LEVEL` / `LOG_SAMPLE` — they live in
`wrangler.jsonc:62-64`:

```jsonc
"vars": {
  "LOG_LEVEL": "info",
  "LOG_SAMPLE": "0.1",
  ...
}
```

This is correct for both runtimes:

- Node reads observability config from environment variables on the
  host (`.env` → `process.env`).
- CF Workers expose `vars` as a static config block in
  `wrangler.jsonc`; `.dev.vars` is for **secrets**, not config.

But a reader doing a literal diff between the two examples sees
`LOG_LEVEL` in one file and not in the other and asks "is this
deliberate?". The asymmetry deserves a one-line header in each.

## Fix

Add a one-line comment to each file explaining the location.

`examples/minimal-cloudflare/.dev.vars.example`:

```env
# Secrets only — `.dev.vars` is for things you'd run
# `wrangler secret put` against in production.
# Non-secret config (LOG_LEVEL, LOG_SAMPLE, APP, TENANT) lives
# in wrangler.jsonc:vars.

SHARED_SECRET=dev-shared-secret
```

`examples/minimal-node/.env.example`:

```env
# Node reads config from process.env. Both secrets and non-secret
# config live here. (CF Workers split these: secrets → .dev.vars,
# non-secrets → wrangler.jsonc:vars.)

SHARED_SECRET=dev-shared-secret
LOG_LEVEL=info
LOG_SAMPLE=0.1
```

Total diff: ~6 lines across two files. Removes a real source of
"is this on purpose?" confusion for users comparing the two
templates.
