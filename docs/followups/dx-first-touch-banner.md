# Followups: dx/first-touch-banner

Loose ends from the first-touch DX work — `@baerly/dev` gained the
`printDevBanner` + `withRequestLogging` helpers; the helpdesk example
and the `baerly dev` CLI adopted them.

## 1. `baerly dev` does not orchestrate `apps/web/`

`baerly dev` (`packages/cli/src/dev.ts`) only boots the Node API
listener over `LocalFsStorage`. For `examples/node-railway/` and
`examples/node-docker/` the root `package.json` has `"dev": "baerly dev"`,
so the React `apps/web/` workspace is **not** started by `pnpm dev`.
A user opens the banner's `http://localhost:3000` URL, hits a 401
JSON page, then either reads the example's README or gives up. The
banner change in this branch sharpens the messaging but does not
solve the underlying gap.

Options:

- Have `baerly dev` detect `apps/web/package.json` and concurrently
  run `vite` from that directory, then thread the vite URL into
  `printDevBanner({ primaryUrl: ... })`.
- Or document in each example's README that `pnpm dev` is API-only
  and ship a second script (`pnpm dev:web`, or a top-level
  `concurrently` wrapper).

Not in the first-touch banner change because the "should `baerly dev`
be a workspace orchestrator" question is bigger than the banner
shape itself.

## 2. `helpdesk-cloudflare` could adopt the helpers

`examples/helpdesk-cloudflare/` runs under wrangler, not a Node
`http.Server` — so `withRequestLogging` does not apply directly.
But `printDevBanner` (or a thin wrapper that takes the wrangler URL
plus the vite URL) would still improve its first-touch UX. Worth
revisiting next time that example is touched.

## 3. Vite/server log interleaving in `examples/helpdesk/`

`pnpm dev` runs `@helpdesk/server` and `@helpdesk/web` in parallel
under pnpm `--parallel`. pnpm prefixes lines by workspace name,
which is enough to make the output scannable, but during heavy
request bursts the interleaving can still be noisy. If this becomes
a real friction point, the fix is either a thin dev orchestrator
(`concurrently --raw` with explicit colors) or holding Vite's start
until the server's `listen` callback fires. Re-open on user signal,
not pre-emptively.
