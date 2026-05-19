# `@baerly/adapter-node` barrel: missing auth presets, escape-hatch too prominent

**Severity: MEDIUM. The Node adapter's public surface is both
under- and over-exposed: it's missing the auth-preset factories
every consumer uses, while exposing the low-level
`S3HttpStorage` escape hatch alongside the high-level factories.
Two small surface adjustments.**

## 1. Node adapter ships storage factories but no auth-preset factories

`packages/adapter-node/src/index.ts` exports four `*Storage`
factories (`memoryStorage`, `localFsStorage`, `s3HttpStorage`,
plus the `S3HttpStorage` class) but **no** `bearerJwt` /
`sharedSecret` factory. Every Node example has to:

```ts
import { createListener } from "@baerly/adapter-node";
import { sharedSecret } from "@baerly/server/auth";  // <- second package
```

CF examples have the same shape: storage from one place, auth
preset from `@baerly/server/auth` directly. The adapter looks
like a half-dep — users have to install / import two packages to
wire one app.

**Fix:** Re-export the relevant auth presets from each adapter's
barrel:

```ts
// packages/adapter-node/src/index.ts
export { bearerJwt, sharedSecret } from "@baerly/server/auth";

// packages/adapter-cloudflare/src/index.ts
export { cloudflareAccess, sharedSecret } from "@baerly/server/auth";
```

Saves one import line per Node / CF app. Makes the adapter look
like a single dep. Pure re-export, no runtime cost.

Coordinate with A1 (`unify-baerly-storage.md`) — if the public
surface consolidates to `baerly-storage`, the re-exports may
move with it. Either way, the user-facing goal is the same:
"one import path for the adapter."

## 2. `S3HttpStorage` is exported at the same prominence as the factories

`packages/adapter-node/src/index.ts:69-70`:

```ts
export { S3HttpStorage } from "@baerly/protocol";
export type { S3HttpStorageOptions } from "@baerly/protocol";
```

…lives next to the four high-level factories. The factories are
the intended user-facing API; `S3HttpStorage` is the
low-level "construct your own storage with full control" escape
hatch.

The discoverability gap is real: `manual-e2e/node/server-entry.ts:16`
reaches for `S3HttpStorage` directly even though the factories
would do the job. The escape hatch is **more prominent** than the
sugar, which is exactly backwards for first-touch DX.

`S3HttpStorage` also drags `xmldom`-typed symbols (via
`@baerly/protocol`) into the type surface — 99% of factory
callers don't touch those, but auto-complete shows them.

**Fix:** Move to a subpath:

```ts
// packages/adapter-node/src/advanced.ts (new)
export { S3HttpStorage } from "@baerly/protocol";
export type { S3HttpStorageOptions } from "@baerly/protocol";
```

`package.json`:

```jsonc
"exports": {
  ".": "./src/index.ts",
  "./advanced": "./src/advanced.ts"
}
```

The barrel `import { ... } from "@baerly/adapter-node"` shows
only `createListener` + factories + auth presets (per item 1).
Advanced users: `import { S3HttpStorage } from
"@baerly/adapter-node/advanced"`. Update the manual-e2e import
path; it's a one-line change.

## Why bundle

Both fixes are about "what's on the agent-facing barrel and what
isn't." Same file (`packages/adapter-node/src/index.ts`); same
PR; same review.

## Verify after fix

- A scaffolded Node example imports auth presets from
  `@baerly/adapter-node` (one fewer dep).
- `import * as N from "@baerly/adapter-node"` no longer shows
  `S3HttpStorage` in IDE autocomplete.
- `manual-e2e/node/server-entry.ts` uses the new
  `/advanced` path (or — better — switches to a factory).

## Cross-references

- A1 / `unify-baerly-storage.md` — if the package-name decision
  consolidates everything under `baerly-storage`, this file's
  fixes happen there with different import paths but the same
  shape.
- F10 (analyst's) is item 1 above; F11 is item 2.
