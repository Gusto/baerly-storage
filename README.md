# baerly-storage

**Storage is the missing primitive for agent-built software, and all you need is a library.**

> _Currently a private Gusto preview, published as `@gusto/baerly-storage` privately under the `@gusto` org on npm (npmjs.com)._

`baerly-storage` is a library that turns an S3-compatible bucket into a document database. **There is no runtime. None.** All coordination — fencing, commit, compaction, garbage collection — runs inside the HTTP request that triggered it: no daemon, no leader, no service bill, no on-call. The only persistent component is your bucket.

Server bundle: ~110 KB gzipped on Cloudflare Workers, ~160 KB gzipped on Node. Browser client: ~5 KB gzipped. The whole public API fits in a single ~1000-line `dist/API.md` — small enough that an LLM can hold it in context.

[S3 does the hard parts](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/), `baerly-storage` is the coordination that fixes the API. Built like git: content-addressed documents, immutable log entries, and a single CAS-advanced pointer to HEAD. Document model, live queries, snapshot isolation — the whole surface in a `.d.ts` an LLM can use zero-shot.

Apps sized for this primitive — small, server-only writes, ~10 GB ceiling, mechanical exit to Postgres when they cross it — get a tool that matches their shape instead of a stack that doesn't.

```
Compute   →  FaaS
Tokens    →  LLM API
Storage   →  this.
```

Almost every team already has an S3-compatible bucket — for exports, backups, CSV graveyards. The security review happened years ago; the budget exists.

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
await db.collection("tickets")
  .insert({ title: "Onboard Alex", status: "open" });

// client — live across every open tab
const { rows } = useLiveQuery<Ticket>({
  collection: "tickets",
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
- **Honest about its envelope.** Sized for ~10 GB / tenant, ~30 writes/min/collection sustained, ~100 collections / tenant. Crossing any of those is the success signal to graduate.

## Quick start

```sh
pnpm create @gusto/baerly-storage@latest -- my-app --target=cloudflare
cd my-app && pnpm install && pnpm dev
```

`pnpm dev` boots Vite + workerd on `:5173`, so `/v1/*` and the React UI share one origin. For `--target=node`, it's `:3000` over `LocalFsStorage` — no S3 creds needed.

Production deploys: anywhere `node server.js` runs — Railway, Render, Fly, Docker, bare VMs, on-prem boxes.

For a runnable multi-tab demo see [`examples/react-node/`](./examples/react-node); for the full set of production-shaped scaffolds see [`examples/`](./examples).

## Go deeper

- 📖 **The essay** — [*Storage Is the Missing Primitive for Agent-Built Software*](https://docs.google.com/document/d/1jpMR-dV9wCprtzY2DUxAg_NZTrAf81OcB_vxKhiCPQ0/edit?tab=t.vo58xtzxjwr) [TODO: Replace with external link on publish]
- 🧭 **How it works** — [`docs/about/how-it-works.md`](./docs/about/how-it-works.md) (the plain-language mental model — bucket + one atomic pointer flip)
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
