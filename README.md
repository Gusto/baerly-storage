# baerly-storage

**A vendorless document database for software that's real enough to need
state, but not real enough to deserve a Postgres + Docker + on-call stack.**
Your bytes in your bucket. ~100 KB gzipped. Zero infra.

Tested with S3, GCS, R2, and self-hosted Minio.

## The whole backend

| What you'd reach for          | What this is                       |
|-------------------------------|------------------------------------|
| `docker-compose.yml`          | `// baerly.config.ts`              |
| `init.sql`                    | `export default defineConfig({`    |
| `prisma/schema.prisma`        | `  app: "tickets",`                |
| `migrations/0001_initial.sql` | `  collections: { tickets: {} },`  |
| RLS policies                  | `  target: "cloudflare",`          |
| `DATABASE_URL` secret         | `});`                              |
| connection pool (pgbouncer)   |                                    |
| pager rotation                | *that's the whole backend.*        |

You need three primitives in 2026: compute, tokens, storage. The first
two have answers. This is one shape of an answer for the third.

## In code

```ts
// baerly.config.ts — no DDL, no migrations
export default defineConfig({
  app: "tickets",
  collections: { tickets: {} },
  target: "cloudflare",
});

// server — writes land in your R2 bucket
await db.table("tickets").insert({ title: "Onboard Alex", status: "open" });

// client — live across every open tab
const { rows } = useLiveQuery<Ticket>({
  table: "tickets",
  where: { status: "open" },
});
```

That's the whole flow. No DDL. No SQL strings. Live across every tab.
Your data is in your bucket.

## Why

- **Idle rounds to zero.** No $5/mo floors multiplied across forty
  abandoned internal tools. The runtime is a rounding error against the
  bucket.
- **No hostage situation.** Log entries are shaped like Postgres
  logical-replication messages. `baerly export --target=postgres`
  graduates you out, mechanically, on the day you outgrow this.
- **An API an LLM can actually use.** The whole public surface fits in
  `.d.ts` files. No DDL. No raw SQL. Discriminated string errors.
  Provisioning is `pnpm install`, not a cloud-console detour.

## Quick start

> 🚧 Pre-publish — `create-baerly` isn't on npm yet. Scaffold inside this
> clone's `examples/` directory until publish; see
> [`docs/followups/publish-direction.md`](./docs/followups/publish-direction.md).

```sh
git clone https://github.com/<you>/baerly-storage && cd baerly-storage
pnpm install && pnpm -r build

cd examples
node ../packages/create-baerly/dist/index.js my-app --target=cloudflare --json

cd my-app
pnpm install
pnpm dev          # → vite + workerd on :5173
```

For the Cloudflare target, `pnpm dev` runs `vite`;
`@cloudflare/vite-plugin` boots the Worker inside `workerd` next to the
SPA dev server, so `/v1/*` and the React UI share `http://localhost:5173`.
For the Node target, `pnpm dev` runs over `LocalFsStorage` on
`http://localhost:3000` — no S3 creds needed.

Once `create-baerly` ships to npm the flow shortens to
`pnpm dlx create-baerly@latest my-app`.

For a runnable multi-tab demo see [`examples/helpdesk/`](./examples/helpdesk); for production-shaped scaffolds see [`examples/`](./examples).

## Go deeper

- 📖 **The essay** — *Storage Is the Missing Primitive for Agent-Built Software*
- 🧱 **Product thesis** — [`docs/about/thesis.md`](./docs/about/thesis.md)
- 🏗️ **Architecture** — [`docs/contributing/architecture.md`](./docs/contributing/architecture.md)
- 🔧 **Embed by hand** — [`docs/guide/embed.md`](./docs/guide/embed.md) (drop baerly into any existing Node app in ~30 lines)

## Where things live

- [`CLAUDE.md`](./CLAUDE.md) — agent + contributor entry point (the
  fastest map for humans too). `AGENTS.md` is a symlink.
- [`docs/README.md`](./docs/README.md) — topic map: architecture,
  conventions, ADRs, protocol specs, operating procedures.
- [`examples/`](./examples) — runnable scaffolds + the `helpdesk/`
  multi-tab demo.
