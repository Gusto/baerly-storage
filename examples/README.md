# examples/

Catalog of runnable baerly-storage example apps. Each subdirectory
is a self-contained pnpm workspace — `cd` in, `pnpm install`, and
`pnpm dev` (or the example's own script) brings it up. The same
tree doubles as the template source for `create-baerly`: the CLI
reads `examples/<name>/`, applies the `.baerly/scaffold.json`
manifest (rename sentinels, copy exclusions, devDep drops), and
writes the result into the user's target directory.

## minimal-cloudflare

Bare Cloudflare Workers scaffold. R2-backed, schema-less, ships
the `cloudflareAccess` → `sharedSecret` verifier chain in
`src/server/index.ts`. The "what does a production CF
Worker entry look like?" answer.

**Audience:** anyone scaffolding a new CF Worker target, or
reading the canonical wiring for `baerly-storage/cloudflare` +
R2 bindings + CF Access.

**Run it:**

```sh
cd examples/minimal-cloudflare
pnpm install
pnpm dev
```

**Read first:** `src/server/index.ts` (the verifier
selector + `baerlyWorker`), then `wrangler.jsonc`
(R2 binding + cron + observability config).

## minimal-node

Bare self-hosted Node scaffold. S3-compatible bucket via
`baerly-storage/node`, JWKS verifier with `sharedSecret` fallback for
`pnpm dev` parity. Runs anywhere `node server.js` runs — Railway,
Render, Fly without Docker, Heroku, a VM, any process manager.
Scaffolded with `--target=node`.

For a production Dockerfile alongside (distroless multi-stage build
+ `healthcheck.js` + `.dockerignore`), scaffold with
`--target=node --with=docker`. The Docker add-on lives at
`packages/create-baerly/templates/addons/docker/` and is layered on
top of this same shape — no second template directory.

**Audience:** anyone scaffolding a self-hosted Node baerly app —
the modal "I just want a Node HTTP server with S3 storage" path.

**Run it:**

```sh
cd examples/minimal-node
pnpm install
pnpm dev
```

`pnpm dev` runs a single `vite` process — `baerlyDev()` from
`baerly-storage/dev/vite` mounts the Node HTTP listener as Connect
middleware on `:5173` next to the SPA dev server, backed by
`LocalFsStorage`. No credentials needed; the `BUCKET` / `AWS_*` /
`SHARED_SECRET` env vars are only required for `pnpm start` and the
production deploy.

**Read first:** `src/server/index.ts` (the `node:http` listener
+ verifier selector).

## react-cloudflare

Cloudflare Workers scaffold with a React + Vite SPA. Schema-bound
`notes` collection (Zod-validated, 3-field), R2-backed storage via
`baerly-storage/cloudflare`, `sharedSecret` verifier. Demonstrates
the full React hook surface (`useLiveQuery`, `useLiveDocument`,
`useInsert`, `useUpdate`, `useDelete`) over a generic placeholder
domain you extend.

**Audience:** the modal full-stack web user — scaffold this when
you want a working React + CF + R2 app to build on top of, not
a tutorial app to gut.

**Run it:**

```sh
cd examples/react-cloudflare
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev
```

Open <http://localhost:5173>. Type a note. Open a second tab —
edits in one tab appear in the other over the `/v1/since`
long-poll.

**Read first:** `src/web/NoteList.tsx` (the `useLiveQuery`
live-updates hook), then `baerly.config.ts` (the `NoteSchema`
shape you extend), then `src/server/index.ts` (the verifier
selector + `/v1/*` ↔ Assets split).

**Scaffold from the CLI:** `pnpm create baerly my-app --target=cloudflare --starter=react`.

## react-node

Self-hosted Node scaffold with a React + Vite SPA. LocalFs-backed
storage in dev via `baerlyDev()` (single Vite process — Vite serves
both `/v1/*` and the SPA), any S3-compatible bucket in production
via `baerly-storage/node`. Demonstrates the full React hook surface
(`useLiveQuery`, `useLiveDocument`, `useInsert`, `useUpdate`,
`useDelete`) over the same `NoteSchema` as `react-cloudflare`.

Runs anywhere `node server.js` runs — Railway, Render, Fly, a VM,
a container.

**Audience:** the modal "I want a self-hosted full-stack web app
on my own bucket" user. The Node-target sibling of
`react-cloudflare`.

**Run it:**

```sh
cd examples/react-node
pnpm install
cp .env.example .env
pnpm dev
```

Open <http://localhost:5173>. No credentials needed for dev —
`baerlyDev()` writes to `./.baerly-data/` via `LocalFsStorage`.

**Read first:** `src/web/NoteList.tsx` (the `useLiveQuery`
live-updates hook), then `baerly.config.ts` (the `NoteSchema`
shape), then `src/server/index.ts` (the `s3Storage` / `r2Storage`
selector + `baerlyNode` invocation for production).

**Scaffold from the CLI:** `pnpm create baerly my-app --target=node --starter=react`
(add `--with=docker` for a Dockerfile + healthcheck).

## helpdesk-cloudflare

A reference example — full Cloudflare-deployable ticket CRUD app
on R2 + CF Access + Workers Assets. **Browse it for a fully-
fleshed-out example** of a schema-bound app (status / priority /
assignee enums on the `Ticket` schema), not as a CLI starter — for
that, use `react-cloudflare`.

**Audience:** anyone reading source code to understand what a
"real" baerly-storage app on Cloudflare looks like end-to-end with
a richer schema than `notes`.

**Run it:**

```sh
cd examples/helpdesk-cloudflare
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev
```

Then open <http://localhost:5173>.

**Read first:** `src/server/index.ts` (the verifier selector +
the `/v1/*` ↔ Assets split), then `wrangler.jsonc` (the R2 +
Assets bindings), then `baerly.config.ts` (the Zod ticket schema
with enum fields).

## Make a new example

If the example should be CLI-scaffoldable, drop a
`.baerly/scaffold.json` manifest at its root and wire it into
`STARTER_TO_EXAMPLE` in `packages/create-baerly/src/scaffold.ts`.
The manifest shape:

```jsonc
{
  // Each `from` string is search-and-replaced in file contents
  // and path segments; `fromKey` names which scaffold input
  // (e.g. "appName", "tenant") provides the replacement value.
  "renames": [
    { "from": "minimal-cloudflare", "fromKey": "appName" },
    { "from": "minimal-demo", "fromKey": "tenant" }
  ],
  // Paths skipped at copy time (relative to the example root).
  "excludePaths": ["uint8array-base64.d.ts", ".baerly/scaffold.json"],
  // devDependencies stripped from the scaffolded `package.json`
  // (e.g. workspace-internal tooling that doesn't ship).
  "dropDevDeps": ["create-baerly"]
}
```

Examples without a manifest are runnable but not CLI-
scaffoldable. The rolldown build copies every example into
`dist/templates/<name>/` so the published `create-baerly` binary
is self-contained.
