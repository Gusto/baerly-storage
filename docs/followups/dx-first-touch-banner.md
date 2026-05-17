# Followups: dx/first-touch-banner

Loose ends from the first-touch DX work — `@baerly/dev` gained the
`printDevBanner` helper; the helpdesk example and the `baerly dev` CLI
adopted it. The standalone access-logger wrapper was later retired in
favour of the kernel's built-in observability layer.

## 1. `baerly dev` does not orchestrate `apps/web/`

`baerly dev` (`packages/cli/src/dev.ts`) only boots the Node API
listener over `LocalFsStorage`. For `examples/minimal-node-railway/` and
`examples/minimal-node-docker/` the root `package.json` has `"dev": "baerly dev"`,
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
`http.Server`. `printDevBanner` (or a thin wrapper that takes the
wrangler URL plus the vite URL) would improve its first-touch UX.
Worth revisiting next time that example is touched.

## 3. Vite/server log interleaving in `examples/helpdesk/` — **resolved**

Resolved on the `helpdesk-single-vite` branch: `examples/helpdesk/`
now boots a single Vite process. The Baerly HTTP listener is mounted
as Vite middleware via `baerlyDev()` from `@baerly/dev/vite`, so the
React app and `/v1/*` API share an origin (`:5173`) and a process —
no `--parallel`, no proxy, no interleaved logs, and Ctrl-C exits
cleanly with no `[ELIFECYCLE]` noise.

## 4. Cloudflare-side equivalents have the same Ctrl-C noise

`examples/helpdesk-cloudflare/` and `examples/minimal-cloudflare/`
still run `pnpm --parallel vite + wrangler`, so they exhibit the
same `[ELIFECYCLE]` / `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` noise on
Ctrl-C that the Node-side helpdesk had before this branch. The fix
shape is **different** there — the right tool is `@cloudflare/vite-plugin`,
which runs the Worker inside workerd inside Vite (genuine single
process). The Node-side `baerlyDev()` plugin from `@baerly/dev/vite`
isn't a fit (different runtime, no `http.Server`). Deliberately left
untouched on this branch.
