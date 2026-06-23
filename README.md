# baerly-storage

**No database server. No daemon. No database runtime. Just your app and a bucket.**

baerly-storage targets software real enough to need shared state, but
not yet important enough to deserve a database service, migration stack,
pager rotation, and idle bill. It is not a database service whose
storage layer happens to be S3. It is a bucket layout and commit
protocol for turning AWS S3 or Cloudflare R2 into a document database,
plus a TypeScript library that applies that protocol from your app.

baerly-storage runs wherever the bucket credentials safely live. For a
browser-facing app, that is usually a Worker, Node server, or
Lambda-style handler. The handler is trusted app code: it handles auth,
validates writes, and applies the protocol. The bucket is the durable
state. When the request ends, baerly-storage is gone. The bucket
remains.

```text
before: browser -> app handler -> database server
after:  browser -> app handler with baerly-storage -> S3/R2 bucket
```

No lock table, catalog, mandatory scheduler, connection pool, resident
compactor, or idle database bill.

A bucket can store objects; it cannot run a transaction coordinator.
The hard part is the commit: one writer must win, and every reader must
be able to tell what won. [S3's strong consistency][s3-strong] makes
object storage usable as shared state; conditional writes supply the
one-writer-wins operation.

Concretely, a collection is a table-like set of JSON documents. Each
collection has content-addressed documents, immutable numbered log
entries, and rolled-up snapshots. A write prepares the document and
lookup objects, then tries to create the next log entry with a
create-if-absent write. That create is the commit. If two writers race,
one claims the log slot; the loser reads the winner and tries the next
empty slot. Reads fold snapshot + committed log entries into rows.

[s3-strong]: https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/

This repo ships TypeScript for Worker and Node apps, but the idea is a
protocol, not a JavaScript-only database. Only the TypeScript
implementation ships today; another language could speak the same
protocol by writing the same bucket layout and using the same
conditional-write rules. The hot write path is one exactly-one-winner
conditional log create per collection. The full storage contract also
needs strong read/list consistency and `If-Match` compare-and-swap for
compaction. AWS S3 and Cloudflare R2 are the supported production
backends; other S3-compatible endpoints need a green
`baerly doctor --bucket=<uri>` and owner validation. See
[`storage-compatibility.md`](./docs/spec/storage-compatibility.md).

Bundle gzip budgets stay small: the Node HTTP closure is 99 KiB, the
Cloudflare closure is 117 KiB, the base browser client is 6 KiB, and
the React hooks are 9 KiB. The whole public API fits in a single
~12k-token `dist/API.md` — small enough that a human or an LLM can hold
the surface in context.

Most teams already have approved object storage for exports, backups,
and archives. The security review happened years ago; the budget
exists.

## Quick start

```sh
pnpm create @gusto/baerly-storage@latest -- my-app --target=cloudflare --starter=react
cd my-app && pnpm install && pnpm dev
```

For the Cloudflare target, `pnpm dev` boots Vite + workerd on `:5173`,
so `/v1/*` and the React UI share one origin. No S3 creds are needed
in development.

For Node, scaffold with `--target=node --starter=react`; `pnpm dev`
also runs on `:5173` through Vite middleware over `LocalFsStorage`.
Production uses `pnpm start` to run the Node listener on any Node 24+
host with bucket credentials in its environment — Railway, Render, Fly,
Docker, bare VMs, on-prem boxes.

For a runnable multi-tab demo see
[`examples/react-node/`](./examples/react-node); for the full set of
production-shaped scaffolds see [`examples/`](./examples).

## What changes

You keep the request handler, auth boundary, bucket binding or
credentials, and any frontend you already had. The database service goes
away.

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
+   tenant: "main",
+   collections: { tickets: {} },
+   target: "cloudflare",
+   auth: "shared-secret",
+ });
```

Your data lives in your bucket. Ordinary schema shape changes are
TypeScript or config edits — no DDL, no SQL strings, no generated
migration ceremony.

## In code

The scaffolds wire `db` on the server and `useQuery` in React; the
calls look like this:

```ts
// server — writes land in your object-storage bucket
await db.collection("tickets").insert({ title: "Onboard Alex", status: "open" });

// client — reactive across every open tab
const open = useQuery((c) => c.collection("tickets").where({ status: "open" }).all(), []);
// open.status → "loading" | "refreshing" | "ok" | "skipped" | "error"
// open.data is present for "ok" / "refreshing"
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

- **An API an LLM can use first try.** No DDL. No raw SQL.
  Discriminated string errors. Provisioning is `pnpm install`, not a
  cloud-console detour. The vocabulary is intentionally small enough to
  hold in context.
- **Idle rounds to zero.** No $5/mo floors multiplied across small
  internal tools and low-traffic apps. There is no per-app database
  service bill; the request-handler work is a rounding error against
  the bucket.
- **Mechanical graduation.** Per-collection snapshot export is shipped:
  `baerly export --target=postgres` with `--bucket=<uri>`,
  `--app=<app>`, `--tenant=<tenant>`, and `--collection=<name>` dumps a
  collection to SQL — run it per collection to hand off a whole app. Log
  entries already carry a change-data-capture (CDC) envelope with
  Debezium-style field names, so an incremental CDC exit stays
  mechanical. That format may narrow before the first production
  consumer; after that, incompatible changes require a major version.
  The incremental exporter itself is future work.
- **Honest about its envelope.** Sized for ~10 GB / tenant,
  ~30 writes/min/collection sustained, ~100 collections / tenant.
  Here, a tenant is one isolated app/customer namespace; a collection is
  a table-like document set.
  Crossing any of those is the success signal to graduate.

## Go deeper

- 🧭 **How it works** — [`docs/about/how-it-works.md`](./docs/about/how-it-works.md)
  (bucket + conditional log create)
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
