# baerly-storage

A vendorless document database for the new middle — software that's
real enough to need state but not real enough to deserve a Postgres
+ Docker + on-call stack. It runs over any S3-compatible storage
API; your data lives in _your_ bucket, the protocol kernel is small
enough that an LLM can use the public API zero-shot from the
`.d.ts` files alone, and mechanical export to SQL is a first-class
feature, not an afterthought. The positioning story is in
[`docs/about/thesis.md`](./docs/about/thesis.md).

Tested with S3, GCS, R2, and self-hosted Minio.

## Quick start

> 🚧 **Pre-publish preview.** `create-baerly` and `baerly-storage`
> are not on npm yet, so the canonical `pnpm dlx create-baerly@latest`
> flow doesn't resolve end-to-end. Until publish, scaffold inside
> this clone's `examples/` directory — `pnpm-workspace.yaml`
> resolves `baerly-storage` / `create-baerly` to the in-tree packages.
> Tracking the npm-publish work in
> [`docs/followups/first-touch-dx.md`](./docs/followups/first-touch-dx.md).

```sh
git clone https://github.com/<you>/baerly-storage && cd baerly-storage
pnpm install && pnpm -r build

# Scaffold into the workspace so baerly-storage + create-baerly resolve:
cd examples
node ../packages/create-baerly/dist/index.js my-app --target=cloudflare --json

cd my-app
pnpm install
pnpm dev          # → vite (with @cloudflare/vite-plugin) on :5173
```

`create-baerly` emits a flat single-package scaffold — one
`package.json`, `src/server/` + `src/web/`, dev/build/deploy verbs
that match the target. For the Cloudflare target, `pnpm dev` runs
`vite`; `@cloudflare/vite-plugin` runs the Worker inside `workerd`
next to the SPA dev server, so `/v1/*` and the React UI share
`http://localhost:5173`. For the Node-Railway / Node-Docker targets,
`pnpm dev` runs `baerly dev` — a Node listener on
`http://localhost:3000` over `LocalFsStorage` with no S3 creds
needed; `pnpm build && pnpm start` produces the production-shaped
run that serves the built SPA from `dist/client/` via
`createApp({ webRoot })`.

Once `create-baerly` + `baerly-storage` ship to npm the flow shortens
to `pnpm dlx create-baerly@latest my-app` (interactive wizard),
followed by `pnpm install && pnpm dev` in any directory of your
choice. The local tarballs from `pnpm -F create-baerly pack` /
`pnpm pack` will work end-to-end once the
scaffolded `package.json` references them via `file:` URLs — see
the followup.

For a runnable, multi-tab demo see [`examples/helpdesk/`](./examples/helpdesk); for production-shaped Cloudflare and Node scaffolds (also the source for `create-baerly`) see [`examples/`](./examples).

## Where things live

- [`CLAUDE.md`](./CLAUDE.md) — agent entry point (also the fastest
  map for human contributors). `AGENTS.md` is a symlink to this
  file, so tools that read either name see the same content.
- [`docs/README.md`](./docs/README.md) — topic map: architecture,
  conventions, ADRs, protocol specs, operating procedures.
- [`examples/helpdesk/`](./examples/helpdesk) — runnable demo
  (90-second start, multi-tab live updates via `/v1/since`).

## Or wire it by hand

If you'd rather embed baerly into an existing app, the kernel is
about 30 lines:

```ts
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "baerly-storage/node";
import { sharedSecret } from "baerly-storage/auth";
import { LocalFsStorage, ensureTable } from "baerly-storage/dev";

const storage = new LocalFsStorage({ root: "./.baerly-data" });
await ensureTable(storage, { app: "tickets", tenant: "acme", table: "items" });

const app = createApp({
  app: "tickets",
  storage,
  verifier: sharedSecret({ secret: "dev-secret", tenantPrefix: "acme" }),
});
createServer(getRequestListener(app.fetch)).listen(3000);
```
