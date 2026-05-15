# baerly-storage

A vendorless document database that runs over any S3-compatible
storage API. The data lives in _your_ bucket; mechanical export to
SQL is a first-class feature, not an afterthought.

Tested with S3, Backblaze, R2 and self-hosted Minio.

## Quick start

> 🚧 **Pre-publish preview.** `create-baerly` and `@baerly/cli` are
> not on npm yet, so the canonical `pnpm dlx create-baerly@latest`
> flow doesn't resolve end-to-end. Until publish, scaffold inside
> this clone's `examples/` directory — `pnpm-workspace.yaml`
> resolves `@baerly/*` / `create-baerly` to the in-tree packages.
> Tracking the npm-publish work in
> [`docs/followups/first-touch-dx.md`](./docs/followups/first-touch-dx.md).

```sh
git clone https://github.com/<you>/baerly-storage && cd baerly-storage
pnpm install && pnpm -r build

# Scaffold into the workspace so @baerly/* + create-baerly resolve:
cd examples
node ../packages/create-baerly/dist/index.js my-app --target=node-railway --json

cd my-app
pnpm install
pnpm dev          # → baerly dev → http://localhost:3000
```

`pnpm dev` runs `baerly dev`: a local Node listener over
`LocalFsStorage`. The same verb works for both Cloudflare-Workers
and self-hosted-Node targets — pick your deploy target at scaffold
time and the appropriate `apps/server/` shell is written, but
day-1 iteration is target-agnostic. (Cloudflare users can
`pnpm dev:wrangler` for parity testing.)

Once `create-baerly` + `@baerly/cli` ship to npm the flow shortens
to `pnpm dlx create-baerly@latest my-app` (interactive wizard),
followed by `pnpm install && pnpm dev` in any directory of your
choice. The local tarballs from `pnpm -F create-baerly pack` /
`pnpm -F @baerly/cli pack` will work end-to-end once the
scaffolded `package.json` references them via `file:` URLs — see
the followup.

The `create-baerly` / `@baerly/cli` split is intentional — see
[ADR 0020](./docs/adr/0020-create-baerly-and-cli-split.md).

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
import { createListener } from "@baerly/adapter-node";
import { sharedSecret } from "@baerly/server/auth";
import { LocalFsStorage, ensureTable } from "@baerly/dev";

const storage = new LocalFsStorage({ root: "./.baerly-data" });
await ensureTable(storage, { app: "tickets", tenant: "acme", table: "items" });

const listener = createListener({
  app: "tickets",
  storage,
  verifier: sharedSecret({ secret: "dev-secret", tenantPrefix: "acme" }),
});
createServer(listener).listen(3000);
```
