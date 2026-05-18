# Dev landing: move off the kernel bundle

**Severity: MEDIUM. Kernel-bundle hygiene.**

`packages/server/src/dev-landing.ts` (82 lines) ships an HTML
template literal + an `escapeHtml` helper. It's exported from the
kernel barrel at `packages/server/src/index.ts:20`:

```ts
export { type DevLandingOptions, renderDevLanding } from "./dev-landing.ts";
```

Both adapters call it from their `GET /` handlers
(`packages/adapter-node/src/server.ts:326`,
`packages/adapter-cloudflare/src/worker.ts:263`) only when
`opts.dev` is truthy — but the symbol is statically reachable from
`index.js`, so it ships in every production bundle. The kernel
bundle is budgeted at 388 KiB raw / 112 KiB gzipped
(`tests/integration/bundle-size.test.ts:81`); dev-landing carries
~2 KiB of HTML literal that no prod request hits.

The `DevLandingOptions.appLabel` field is documented but never set
by any production caller — only test fixtures pass it
(`packages/adapter-node/src/server-routes.test.ts:304`,
`packages/adapter-cloudflare/src/worker-routes.test.ts:322`,
`packages/server/src/dev-landing.test.ts:9, 26`).

---

## Action — pick one

**(a) [preferred] Move to `@baerly/dev`.** Dev-landing fits the
package's existing role (Vite plugin, `LocalFsStorage`, dev
banner). Both adapters guard the call behind `opts.dev`, so the
import path moves from `@baerly/server` to `@baerly/dev` at the
two call sites. Production builds that don't depend on
`@baerly/dev` get a smaller kernel. Drop `DevLandingOptions.appLabel`
during the move (no production caller sets it).

**(b) Dynamic-import.** Keep the file in `@baerly/server` but
load it via `await import("./dev-landing.ts")` from each adapter's
`GET /` handler inside the `opts.dev` branch. Rolldown will emit a
separate chunk; the main bundle stops carrying the HTML. Drop
`appLabel` either way.

(a) is cleaner and matches where dev-only concerns belong; (b) is
smaller diff if `@baerly/dev` migration is too entangled with other
moves.

---

## Verification

After the workstream:

- `pnpm verify` — typecheck + lint pass.
- `pnpm test` — all default-project tests pass, including
  `packages/server/src/dev-landing.test.ts` (move tests with
  the file).
- `pnpm build` — confirm the kernel bundle drops the HTML
  literal. The existing `bundle-size.test.ts` budget tightens
  by ~2 KiB; nudge the budget down to lock the gain.
- `pnpm test:adapter-cloudflare` and `pnpm test:adapter-node` —
  `GET /` still serves the landing page when `opts.dev` is set.
- Manual: scaffold a CF app, set `vars.NODE_ENV = "development"`
  (or whatever the gate is in the adapter), confirm
  `GET /` returns the landing HTML.

## Out of scope

This workstream is purely the dev-landing move. The kernel's other
non-prod cargo (the `_raw` half-Storage stub in `since.ts`,
`logger-pretty.ts` + `picocolors`, the `BAERLY_SINCE_*` env knobs)
is tracked separately.
