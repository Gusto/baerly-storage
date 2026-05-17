## DX / examples / dev orchestration

Items 8–10 are design-level DX questions that need a brainstorming
session before implementation, not a fix-it ticket. Listed together
because items 8 and 10 touch the same `examples/*-cloudflare/`
surface.

### 8. `baerly dev` does not orchestrate `apps/web/`

**STATUS: deferred — L-effort design question.**
**Effort:** L (workspace orchestration design + implementation).

`baerly dev` (`packages/cli/src/dev.ts`) only boots the Node API
listener over `LocalFsStorage`. For `examples/minimal-node-railway/`
and `examples/minimal-node-docker/` the root `package.json` has
`"dev": "baerly dev"`, so the React `apps/web/` workspace is **not**
started by `pnpm dev`. A user opens the banner's
`http://localhost:3000` URL, hits a 401 JSON page, then either reads
the example's README or gives up.

Options to weigh in brainstorming:

- Have `baerly dev` detect `apps/web/package.json` and concurrently
  run `vite` from that directory, then thread the vite URL into
  `printDevBanner({ primaryUrl: ... })`.
- Or document in each example's README that `pnpm dev` is API-only
  and ship a second script (`pnpm dev:web`, or a top-level
  `concurrently` wrapper).

The load-bearing design choice: should `baerly dev` be a workspace
orchestrator at all?

### 9. `helpdesk-cloudflare` could adopt the banner / log helpers

**STATUS: deferred; revisit next time the example is touched.**
**Effort:** S–M (~0.5d, depends on wrapper shape).

`examples/helpdesk-cloudflare/` runs under wrangler, not a Node
`http.Server`. `printDevBanner` (or a thin wrapper that takes the
wrangler URL plus the vite URL) would improve first-touch UX.
Related to item 10 — same workspace, related fix.

### 10. Cloudflare-side examples have `[ELIFECYCLE]` noise on Ctrl-C

**STATUS: deferred; blocked on `@cloudflare/vite-plugin` adoption.**
**Effort:** M (~0.5d once the plugin is wired).

`examples/helpdesk-cloudflare/` and `examples/minimal-cloudflare/`
still run `pnpm --parallel vite + wrangler`, so they exhibit the same
`[ELIFECYCLE]` / `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` noise on Ctrl-C
that the Node-side helpdesk had before the `helpdesk-single-vite`
branch. The fix shape is **different** there — the right tool is
`@cloudflare/vite-plugin`, which runs the Worker inside workerd
inside Vite (genuine single process). The Node-side `baerlyDev()`
plugin from `@baerly/dev/vite` isn't a fit (different runtime, no
`http.Server`).
