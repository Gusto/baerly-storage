# baerly-storage

**Storage is the missing primitive for agent-built software, and all you need is a library.**

`baerly-storage` is a ~100 KB library that turns an S3-compatible bucket into a document database. All coordination — fencing, commit, compaction, garbage collection — runs inside the HTTP request or cron invocation that triggered it: no daemon, no leader, no service bill, no on-call. The only persistent component is your bucket; the kernel is small enough that an LLM can hold the whole `.d.ts` in context.

[S3 is does the hard parts](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/), `baerly-storage` is the coordination that fixes the API. Document model, live queries, snapshot isolation — the whole surface in a `.d.ts` an LLM can use zero-shot.

The apps LLMs spit out by the dozen don't deserve Postgres + Docker + a pager; they deserve this.

```
Compute   →  FaaS
Tokens    →  LLM API
Storage   →  this.
```

## The whole backend

```diff
- docker-compose.yml
- init.sql
- prisma/schema.prisma
- migrations/0001_initial.sql
- RLS policies
- DATABASE_URL secret
- connection pool (pgbouncer)
- pager rotation
-
+ // baerly.config.ts
+ export default defineConfig({
+   app: "tickets",
+   collections: { tickets: {} },
+   target: "cloudflare",
+ });
```

Your data lives in your bucket. The entire public surface fits in `.d.ts` files — no DDL, no SQL strings, no migrations to chase across deploys.

## In code

```ts
// server — writes land in your R2 bucket
await db.table("tickets")
  .insert({ title: "Onboard Alex", status: "open" });

// client — live across every open tab
const { rows } = useLiveQuery<Ticket>({
  table: "tickets",
  where: { status: "open" },
});
```

## Why?

- **An API an LLM can use first try.** The whole public surface fits in
  `.d.ts` files. No DDL. No raw SQL. Discriminated string errors.
  Provisioning is `pnpm install`, not a cloud-console detour. Verified
  with zero-shot eval suites.
- **Idle rounds to zero.** No $5/mo floors multiplied across forty
  abandoned internal tools the loop produced last quarter. The runtime
  is a rounding error against the bucket.
- **No hostage situation.** Log entries are shaped like Postgres
  logical-replication messages. `baerly export --target=postgres`
  graduates you out, mechanically, on the day an app outgrows this.

## Quick start

Not on npm yet — clone the repo:

```sh
git clone https://github.com/<you>/baerly-storage && cd baerly-storage
pnpm install && pnpm -r build

cd examples
node ../packages/create-baerly/dist/index.js my-app --target=cloudflare
cd my-app && pnpm install && pnpm dev
```

`pnpm dev` boots Vite + workerd on `:5173`, so `/v1/*` and the React UI share one origin. For `--target=node`, it's `:3000` over `LocalFsStorage` — no S3 creds needed.

Production deploys: anywhere `node server.js` runs — Railway, Render, Fly, Docker, bare VMs, on-prem boxes.

Once `create-baerly` ships to npm: `pnpm dlx create-baerly@latest my-app`.

For a runnable multi-tab demo see [`examples/react-node/`](./examples/react-node); for the full set of production-shaped scaffolds see [`examples/`](./examples).

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
- [`examples/`](./examples) — runnable scaffolds + the `react-node/`
  multi-tab demo.
