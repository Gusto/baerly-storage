# `@baerly/adapter-cloudflare` worker surface: three dead/half-wired items

**Severity: MEDIUM. Three independent items on the CF worker
public surface that are unread, dead, or wrong by default.
Reviewable together; same file.**

## 1. `Env.TENANT` is required-non-optional but the adapter never reads it

`packages/adapter-cloudflare/src/worker.ts:63` declares
`TENANT: string` on `Env` (no `?`). JSDoc lines 48-55 explicitly
admits: "TENANT is **not** special-cased by baerlyWorker — the
configured Verifier resolves the tenant from the request."

So every consuming CF example has to bind a fake `TENANT` in
`wrangler.jsonc` to satisfy the type, then hard-code the same
tenant literal inside `src/server/index.ts` for `sharedSecret({
  tenantPrefix: ... })`. Two-place update for one literal.

**Fix — pick one:**

- **Drop `TENANT` from `Env`.** No code reads it; the user
  configures `tenantPrefix` inline. Smallest surface.
- **Wire `env.TENANT` through `selectVerifier`** so the wrangler
  binding becomes the single source of truth. Removes the
  literal from `src/server/index.ts`.

Either fixes the H10 cross-reference (CF templates' wrangler
bindings + hard-coded tenant literal) — see `cf-templates-cleanup.md`.

## 2. Default `scheduled` handler ships but never runs

`packages/adapter-cloudflare/src/worker.ts:403-406` is the
default cron handler:

```ts
async scheduled(event, env, ctx) {
  if (!env.CURRENT_JSON_KEY) return;
  // ...single-tenant maintenance fallback...
}
```

Zero scaffolded examples set `CURRENT_JSON_KEY` in their
wrangler config. The multi-tenant guidance points users at
`options.scheduled` instead. So the entire single-tenant
fallback — `env.CF_TIER`, profile selection, minute-parity
alternation — ships but is never exercised by test or scaffold.

**Fix — pick one:**

- **Remove the default `scheduled` path.** Require
  `options.scheduled` from the user. Smaller surface; honest
  about what works.
- **Wire `CURRENT_JSON_KEY` in `minimal-cloudflare`.** Provide a
  scaffolded user a working single-tenant maintenance loop out
  of the box. Larger code path; first-touch demo of cron
  maintenance.

The latter is more user-affirming if maintenance is meant to be
day-1 visible. The former is the right answer if the single-
tenant fallback is an artifact of an earlier design.

## 3. `BaerlyWorkerOptions.handler` / `WorkerHandler` is dead

`packages/adapter-cloudflare/src/worker.ts:108` declares an
optional `handler?: WorkerHandler` for users who want to inject
custom route handling. Zero examples, manual-e2e, or tests pass
this field — verified across the repo. Custom-route examples
(`minimal-cloudflare/src/server/index.ts:94-101`) already wrap
`baerlyWorker(...)` in their own outer `fetch` instead.

The Node adapter has no equivalent. The shape is asymmetric for
a feature nobody uses.

**Fix:** Delete `handler` and `WorkerHandler` from the public
surface. ~25 LoC plus a public API field gone. If a future user
asks for in-worker route injection, revisit then — and probably
with a better-named API.

## Why bundle

All three live in `packages/adapter-cloudflare/src/worker.ts`,
all three are pre-launch surface cuts/trims, and a single PR
keeps the type-shape changes in one diff. F1 also unblocks H10
in `cf-templates-cleanup.md`.

## Cross-references

- `cf-templates-cleanup.md` H10 — example side of F1.
- `examples/minimal-cloudflare/wrangler.jsonc:61` and
  `examples/helpdesk-cloudflare/wrangler.jsonc:62` need
  updating if F1 lands as "drop `TENANT`."
