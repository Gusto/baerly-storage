# CF templates: dead env var, server verbosity, wrangler.jsonc bloat

**Severity: MEDIUM. Three cleanups in the two Cloudflare templates
(`minimal-cloudflare`, `helpdesk-cloudflare`). All polish, no
correctness bugs — but the templates are scaffolded as-is into
user repos, so noise multiplies.**

## 1. `Env.TENANT` is bound but never read

Both `examples/minimal-cloudflare/wrangler.jsonc:61` and
`examples/helpdesk-cloudflare/wrangler.jsonc:62` declare:

```jsonc
"vars": {
  "TENANT": "minimal-demo",     // or "helpdesk-demo"
  ...
}
```

Both `src/server/index.ts` files then hard-code the same tenant
literal *separately*:

```ts
// examples/minimal-cloudflare/src/server/index.ts:62
sharedSecret({ ..., tenantPrefix: "minimal-demo" })
```

`env.TENANT` is never read in either example's worker code, nor
threaded through `selectVerifier`. So the user has to update the
tenant in two places, and the wrangler binding is dead.

**Fix — pick one:**

- **Drop `TENANT` from both `wrangler.jsonc` files.** Single source
  of truth in the TS literal. Easiest.
- **Wire `env.TENANT` through `selectVerifier`** in both worker
  entries. Removes the literal from TS, makes the deploy config the
  single source. Slightly heavier but matches how a real
  multi-tenant deploy would look.

Cross-reference: this is the example-side of analyst Finding F1
("`Env.TENANT` is a required worker field that the adapter never
reads"). The F1 cleanup in `@baerly/adapter-cloudflare/src/worker.ts`
should land first or in the same change.

## 2. `wrangler.jsonc` files are ~90% comment

`wc -l`: minimal-cloudflare 90 lines, helpdesk-cloudflare 91 lines.
The two files differ only in:

- `name`
- `bucket_name`
- `APP` / `TENANT` vars (`minimal-demo` vs `helpdesk-demo`)

The remaining ~85 lines are byte-identical comment blocks
(lines 2-4, 11-13, 36-42, 43-59, 66-84, 86-90 of either file).
Wrangler tolerates minimal config — let users see how small it can
be.

**Fix:** Trim per-file commentary to one or two lines pointing at
`AGENTS.md` for the long-form explanation. Move the
"reference these fields if you want X" content into the example
`AGENTS.md` once, not twice with byte-for-byte duplication.

## 3. `minimal-cloudflare/src/server/index.ts` is mostly JSDoc

`examples/minimal-cloudflare/src/server/index.ts` is 101 lines;
roughly 70 of those are JSDoc / comment blocks. Lines 81-85 contain
a multi-line commented description of the dev-landing-page
feature (not a code snippet, but still verbose explanation).

`examples/helpdesk-cloudflare/src/server/index.ts` does the same
logical job in 60 lines because the verbose commentary lives in
AGENTS.md.

**Fix:** Trim minimal-cloudflare's worker entry to the
helpdesk-cloudflare shape. Move long-form commentary to
`examples/minimal-cloudflare/AGENTS.md`. The principle: examples
should look like *production code*, not tutorials.

## Why bundle these

All three live in the two CF templates; all three are reviewable
side-by-side; the "wrangler.jsonc trim" and "src/server/index.ts
trim" share the same "move commentary to AGENTS.md" treatment.
