## DX / examples / dev orchestration

Items 8–10 are design-level DX questions that need a brainstorming
session before implementation, not a fix-it ticket. Listed together
because items 8 and 10 touch the same `examples/*-cloudflare/`
surface.

### 8. Node `baerly dev` boots the API but not the SPA in dev

**STATUS: deferred — design question, narrower scope after flatten.**
**Effort:** M (vite child-process + banner URL threading).

`baerly dev` (`packages/cli/src/dev.ts`) only boots the Node API
listener over `LocalFsStorage`. After the scaffold flatten the SPA
lives at `src/web/` in the same package, but `pnpm dev` still
launches only the API on `:3000`; a user has to `pnpm build` once
and then revisit, or spawn `vite` themselves. Cloudflare scaffolds
solved this via `@cloudflare/vite-plugin` (item 10); Node has no
equivalent because the Node listener isn't a Vite environment.

Options:
- Have `baerly dev --web` (Node target only) spawn `vite` from the
  scaffold root and thread its URL into
  `printDevBanner({ primaryUrl: ... })`.
- Or document the two-process flow in each Node example's README
  and ship a `dev:web` script.

### 9. `helpdesk-cloudflare` could adopt the banner / log helpers

**STATUS: deferred; revisit next time the example is touched.**
**Effort:** S–M (~0.5d, depends on wrapper shape).

`examples/helpdesk-cloudflare/` runs under wrangler, not a Node
`http.Server`. `printDevBanner` (or a thin wrapper that takes the
wrangler URL plus the vite URL) would improve first-touch UX.
Related to item 10 — same workspace, related fix.

### 10. ~~Cloudflare-side examples have `[ELIFECYCLE]` noise on Ctrl-C~~

**STATUS: RESOLVED by the scaffold-flatten branch.**

`examples/minimal-cloudflare/` and `examples/helpdesk-cloudflare/`
now run `@cloudflare/vite-plugin` (one Vite process; Worker runs
inside workerd inside Vite). The two-process noise is gone.
