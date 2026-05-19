# `examples/helpdesk-cloudflare`: first-touch bugs

**Severity: HIGH. Both bugs break the documented `pnpm dev`
on a brand-new clone of a scaffolded project. First impressions.**

Two distinct bugs in the same template, same fix session.

## 1. README "Quick start" tells the user the wrong secret command

`examples/helpdesk-cloudflare/README.md:9-15` tells the user to
run:

```sh
wrangler secret put SHARED_SECRET
pnpm dev
```

`pnpm dev` resolves to `vite` (per `package.json:7`), driven by
`@cloudflare/vite-plugin`, which reads secrets from `.dev.vars`
on disk. `wrangler secret put` uploads the secret to the
**deployed** Worker via the Cloudflare API — it does not touch
`.dev.vars`. So a new user follows the documented commands and
gets a 500 `No Verifier configured` on the first request.

The sibling `examples/minimal-cloudflare/README.md:82-87`
documents the correct flow:

```sh
cp .dev.vars.example .dev.vars
# edit .dev.vars to set SHARED_SECRET
pnpm dev
```

**Fix:** Replace the helpdesk-cloudflare quick-start block with
the `cp .dev.vars.example .dev.vars` pattern. The
`wrangler secret put` step belongs in a separate "Deploy" section,
not "Quick start."

## 2. `vite-env.d.ts` declares the wrong VITE_ variable name

`examples/helpdesk-cloudflare/vite-env.d.ts:4`:

```ts
readonly VITE_HELPDESK_SECRET?: string;
```

`examples/helpdesk-cloudflare/src/web/client.ts:13`:

```ts
import.meta.env.VITE_SHARED_SECRET
```

The typed accessor never matches the actual env var the code
reads. Today the client falls back to the literal
`"dev-shared-secret"` baked into the source, so the *demo* still
works — but any user trying to override the secret silently
fails. Worse, the TypeScript declaration suggests
`VITE_HELPDESK_SECRET` is the right key, so users who follow the
type hint will set the wrong variable.

**Fix:** Change `vite-env.d.ts` to declare `VITE_SHARED_SECRET`.
Add a one-line comment to `.dev.vars.example`
(and/or `.env.example` if present) documenting that
`VITE_SHARED_SECRET` is the client-visible mirror of
`SHARED_SECRET`.

```ts
// vite-env.d.ts
interface ImportMetaEnv {
  /** Client-visible mirror of SHARED_SECRET; set in .dev.vars / .env. */
  readonly VITE_SHARED_SECRET?: string;
}
```

## Verify after fix

- `cd examples/helpdesk-cloudflare && cp .dev.vars.example .dev.vars`
- `pnpm dev`
- Open the dev URL → first ticket list renders without console
  errors and without a 500 on `/v1/...`.
