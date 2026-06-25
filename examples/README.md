# examples/

**The bucket is the durable state.** The Worker or Node process is
trusted app code with bucket credentials; it applies the
baerly-storage protocol, but it is not a database server. No daemon,
lock table, scheduler, or idle database bill; maintenance is automatic
and write-triggered.

Catalog of runnable baerly-storage example apps. Each subdirectory
is a self-contained pnpm workspace — `cd` in, `pnpm install`, and
`pnpm dev` (or the example's own script) brings it up. The same
tree doubles as the template source for `@gusto/create-baerly-storage`: the CLI
reads `examples/<name>/`, applies the `.baerly/scaffold.json`
manifest (rename sentinels, copy exclusions, devDep drops), and
writes the result into the user's target directory.

## Auth posture

Every scaffold below ships `auth: "none"` in `baerly.config.ts` so
the day-1 happy path works with zero env vars. The adapter reads
`config.auth` and synthesizes its verifier; for production, each
scaffold's `AGENTS.md` "Going to production" section documents the
upgrade recipes. Cloudflare examples use Pattern A for CF Access and
Pattern B for shared-secret auth; Node examples use Pattern B for
shared-secret auth and Pattern C for JWKS-backed JWTs.
`baerly doctor --target=cloudflare` warns on `auth: "none"` for
Worker deploy targets and fails on `"shared-secret"` without
`SHARED_SECRET` reachable from the runtime env. Node targets use
`baerly doctor --bucket=<s3-uri>` plus the deployed `/v1/healthz`
probe today.

## minimal-cloudflare

Bare Cloudflare Workers scaffold. R2-backed, schema-less. Ships
`auth: "none"` (the adapter synthesizes a no-op verifier and pins
every request to `config.tenant`). See the scaffold's `AGENTS.md`
"Going to production" recipes — Pattern A flips to CF Access via an
env-aware factory `verifier:` override; Pattern B flips
`auth: "shared-secret"`. The "what does a production CF Worker
entry look like?" answer.

**Audience:** anyone scaffolding a new CF Worker target, or
reading the canonical wiring for `@gusto/baerly-storage/cloudflare` +
R2 bindings + CF Access.

**Run it:**

```sh
cd examples/minimal-cloudflare
pnpm install
pnpm dev
```

**Read first:** `src/server/index.ts` (the verifier
selector + `baerlyWorker`), then `wrangler.jsonc`
(R2 binding + observability config).

## minimal-node

Bare self-hosted Node scaffold. Zero-config local filesystem storage by
default; promote to AWS S3 / Cloudflare R2 via
`@gusto/baerly-storage/node` for production (the server fails loud rather
than silently running a deployment on local-fs). MinIO is for local
conformance, and other S3-compatible endpoints need
`baerly doctor --bucket` plus owner validation. Ships `auth: "none"`; see the scaffold's
`AGENTS.md` "Going to production" recipes — Pattern B flips
`auth: "shared-secret"`; Pattern C wires `bearerJwt` against your
OIDC IdP via an env-aware factory `verifier:` override. Runs anywhere
`node server.js` runs — Railway, Render, Fly without Docker, Heroku,
a VM, any process manager. Scaffolded with `--target=node`.

For a production Dockerfile alongside the scaffold, use
`--target=node --with=docker`. The add-on writes a distroless
multi-stage Dockerfile, `healthcheck.js`, and `.dockerignore`; it lives
at `packages/create-baerly-storage/templates/addons/docker/` and is
layered on top of this same shape — no second template directory.

**Audience:** anyone scaffolding a self-hosted Node baerly-storage app —
the modal "I just want a Node HTTP server, local-first, with an S3 / R2
upgrade path" user.

**Run it:**

```sh
cd examples/minimal-node
pnpm install
pnpm dev
```

`pnpm dev` runs a single `vite` process — `baerlyDev()` from
`@gusto/baerly-storage/dev/vite` mounts the Node HTTP listener as Connect
middleware on `:5173` next to the SPA dev server, backed by
`LocalFsStorage`. No credentials needed; `pnpm start` also runs
local-first, and the `BUCKET` / `AWS_*` env vars promote it to a durable
bucket — required for a production deploy, where the server fails loud
rather than silently using local-fs.
Auth-related env vars (`SHARED_SECRET` / `JWKS_URL` etc.) only
appear if you adopt one of the "Going to production" recipes.

**Read first:** `src/server/index.ts` (the `node:http` listener and
verifier selector).

## react-cloudflare

Cloudflare Workers scaffold with a React + Vite SPA. Schema-bound
`notes` collection (Zod-validated, 3-field), R2-backed storage via
`@gusto/baerly-storage/cloudflare`. Ships `auth: "none"` (the SPA hits
`/v1/*` unauthenticated; the schema validates writes server-side
regardless of the auth posture). See the scaffold's `AGENTS.md`
"Going to production" recipes — Pattern A flips to CF Access via an
env-aware factory `verifier:` override; Pattern B flips
`auth: "shared-secret"` (re-enable `baerlyDevAuth` in
`vite.config.ts` for browser bearer injection). Demonstrates the
full React hook surface (`useQuery` for reactive reads, `useMutation`
for writes) over a generic placeholder domain you extend.

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
edits in one tab appear in the other over the
`/v1/since?collection=notes&cursor=...` long-poll.

**Read first:** `src/web/NoteList.tsx` (the `useQuery` reactive
read), then `baerly.config.ts` (the `NoteSchema` shape you extend),
then `src/server/index.ts` (the verifier selector + `/v1/*` ↔
Assets split).

**Scaffold from the CLI:** `pnpm create @gusto/baerly-storage@latest my-app --target=cloudflare --starter=react`.

## react-node

Self-hosted Node scaffold with a React + Vite SPA. Local filesystem
storage by default (dev via `baerlyDev()` — single Vite process serving
both `/v1/*` and the SPA — and local `pnpm start` runs); promote to AWS
S3 / Cloudflare R2 via `@gusto/baerly-storage/node` for production. MinIO is for local
conformance, and other S3-compatible endpoints need
`baerly doctor --bucket` plus owner validation. Ships `auth: "none"`; see the scaffold's
`AGENTS.md` "Going to production" recipes — Pattern B flips
`auth: "shared-secret"`; Pattern C wires `bearerJwt` against your
OIDC IdP via an env-aware factory `verifier:` override. Demonstrates
the full React hook surface (`useQuery` for reactive reads,
`useMutation` for writes) over the same `NoteSchema` as
`react-cloudflare`.

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

**Read first:** `src/web/NoteList.tsx` (the `useQuery` reactive
read), then `baerly.config.ts` (the `NoteSchema` shape), then
`src/server/index.ts` (the local-fs → `s3Storage` / `r2Storage`
selector + `baerlyNode` invocation).

**Scaffold from the CLI:** `pnpm create @gusto/baerly-storage@latest my-app --target=node --starter=react`
(add `--with=docker` for a Dockerfile + healthcheck).

## Make a new example

If the example should be CLI-scaffoldable, drop a
`.baerly/scaffold.json` manifest at its root and wire it into
`STARTER_TO_EXAMPLE` in `packages/create-baerly-storage/src/scaffold.ts`.
The manifest shape is strict JSON:

```json
{
  "renames": [
    { "from": "minimal-cloudflare", "fromKey": "appName" },
    { "from": "minimal-demo", "fromKey": "tenant" }
  ],
  "excludePaths": ["uint8array-base64.d.ts", ".baerly/scaffold.json"],
  "dropDevDeps": ["@gusto/create-baerly-storage"]
}
```

`renames` search-and-replaces strings in file contents and path
segments; `excludePaths` skips paths relative to the example root;
`dropDevDeps` strips workspace-only dev dependencies from the
scaffolded `package.json`.

Examples without a manifest are runnable but not CLI-
scaffoldable. The rolldown build copies every example into
`dist/templates/<name>/` so the published `@gusto/create-baerly-storage` binary
is self-contained.
