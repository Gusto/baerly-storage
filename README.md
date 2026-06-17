# baerly-storage

**Storage is the missing primitive for agent-built software, and all you need is a library.**

`baerly-storage` is a library that turns AWS S3, Cloudflare R2, or a
conformant S3-compatible bucket into a document database. **There is
no runtime. None.** No baerly-storage daemon, no leader, no scheduler, no
catalog, no database service bill, no on-call. Coordination rides the
request path — Cloudflare can finish bounded maintenance with `ctx.waitUntil`,
Node runs it inline — and the only persistent component is your bucket.

The server bundles is ~100 KB gzipped, and the browser client is ~5 KB gzipped.
The whole public API fits in a single ~12k-token `dist/API.md` — small enough
that an LLM can hold it in context.

[S3 does the hard parts](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/),
`baerly-storage` is the coordination that fixes the API. Built like git:
content-addressed documents, immutable numbered log entries, and one
conditional log create as the commit, per collection. Document model,
live queries, snapshot isolation — the whole surface in a `.d.ts`
designed for zero-shot use.

Apps sized for this primitive — small, server-only writes, ~10 GB
ceiling, mechanical exit to Postgres when they cross it — get a tool
that matches their shape instead of a stack that doesn't.

```
Compute   →  FaaS
Tokens    →  LLM API
Storage   →  this.
```

Almost every team already has an object-storage bucket — for exports,
backups, CSV graveyards. The security review happened years ago; the
budget exists.

## Quick start

```sh
pnpm create @gusto/baerly-storage@latest -- my-app --target=cloudflare --starter=react
cd my-app && pnpm install && pnpm dev
```

For the Cloudflare target, `pnpm dev` boots Vite + workerd on `:5173`,
so `/v1/*` and the React UI share one origin. No S3 creds are needed
in development.

For Node, scaffold with `--target=node --starter=react`; `pnpm dev` also runs on
`:5173` through Vite middleware over `LocalFsStorage`, and production
uses `pnpm start` to run the Node listener anywhere Node runs —
Railway, Render, Fly, Docker, bare VMs, on-prem boxes.

## The storage backend

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

Your data lives in your bucket. The entire public surface fits in `.d.ts`
files — no DDL, no SQL strings, no generated migration ceremony for
ordinary schema shape changes.

## In code

```ts
// server — writes land in your R2 bucket
await db.collection("tickets").insert({ title: "Onboard Alex", status: "open" });

// client — reactive across every open tab
const open = useQuery((c) => c.collection("tickets").where({ status: "open" }).all(), []);
// open.status → "loading" | "ok" | "error"; open.data → your rows
```

## Cheat sheet

```ts
// reads — Collection or, after a modifier, Query
db.collection("tickets").get(id); // by id
db.collection("tickets").where({ status: "open" }).all();
db.collection("tickets")
  .where((q) => q.gte("count", 1))
  .count();

// writes — by id on Collection, bulk on Query
db.collection("tickets").insert({ status: "open", title: "ship it" });
db.collection("tickets").update(id, { status: "closed" }); // merge-patch
db.collection("tickets").where({ status: "closed" }).delete();
```

| Surface       | Vocabulary                                                                            |
| ------------- | ------------------------------------------------------------------------------------- |
| **Verbs**     | `first` `all` `count` `get` · `insert` `update` `replace` `delete`                    |
| **Modifiers** | `where` `order` `limit`                                                               |
| **Operators** | `eq` `gt` `gte` `lt` `lte` `in`                                                       |
| **Errors**    | one `BaerlyError`, discriminate by `.code` (`Conflict`, `NotFound`, `SchemaError`, …) |

Full reference: [`docs/guide/cheatsheet.md`](./docs/guide/cheatsheet.md), or
`cat node_modules/@gusto/baerly-storage/dist/API.md` in an installed app.

## Why?

- **An API an LLM can use first try.** The whole public surface fits in
  `.d.ts` files. No DDL. No raw SQL. Discriminated string errors.
  Provisioning is `pnpm install`, not a cloud-console detour. The
  vocabulary is intentionally small enough to hold in context.
- **Idle rounds to zero.** No $5/mo floors multiplied across forty
  abandoned internal tools the loop produced last quarter. There is
  no per-app database service bill; the runtime is a rounding error
  against the bucket.
- **No hostage situation.** Per-collection snapshot export is shipped:
  `baerly export --target=postgres --collection=<name>` dumps a
  collection to SQL — run it per collection to hand off a whole app.
  Log entries are already a Debezium-style CDC envelope, so an
  incremental CDC exit stays mechanical (the shape is fixed; the
  incremental exporter itself is future work).
- **Honest about its envelope.** Sized for ~10 GB / tenant,
  ~30 writes/min/collection sustained, ~100 collections / tenant.
  Crossing any of those is the success signal to graduate.

For a runnable multi-tab demo see
[`examples/react-node/`](./examples/react-node); for the full set of
production-shaped scaffolds see [`examples/`](./examples).

## Go deeper

- 🧭 **How it works** —
  [`docs/about/how-it-works.md`](./docs/about/how-it-works.md) (the
  plain-language mental model — bucket + one conditional log create)
- 🧱 **Product thesis** — [`docs/about/thesis.md`](./docs/about/thesis.md)
- 🏗️ **Architecture** — [`docs/contributing/architecture.md`](./docs/contributing/architecture.md)
- 🔧 **Embed by hand** —
  [`packages/server/API.md`](./packages/server/API.md) (the
  embed-by-hand + custom-routes recipes — `baerlyNode().fetch` is the
  canonical shape; ships as `dist/API.md` in the package)

## Where things live

- [`CLAUDE.md`](./CLAUDE.md) — agent + contributor entry point (the
  fastest map for humans too). `AGENTS.md` is a symlink.
- [`docs/README.md`](./docs/README.md) — topic map: architecture,
  conventions, ADRs, protocol specs, operating procedures.
- [`examples/`](./examples) — runnable scaffolds + the `react-node/`
  multi-tab demo.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
