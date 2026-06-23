# baerly-storage

**No database server. No daemon. No database runtime. Just your app and a bucket.**

```text
before: browser → app handler → database  (a server)
after:  browser → app handler → bucket    (just storage)
```

A document database that _is_ an S3 or Cloudflare R2 bucket — no server
to run, no idle bill, no migration stack. baerly-storage runs wherever
the bucket credentials safely live: a Worker, a Node server, a
Lambda-style handler. When the request ends, baerly-storage is gone. The
bucket remains.

- **An API an LLM can use first try.** No DDL, no raw SQL — 8 verbs and
  a ~12k-token API surface that fits in context.
- **Idle rounds to zero.** No $5/mo floors across a fleet of small
  internal tools. ~$18/mo all-in on R2 at a sustained 30 writes/min.
- **No exit tax.** `baerly export --target=postgres` dumps any
  collection to SQL. Crossing the envelope is the success signal, not a
  hostage situation.
- **Built like git** — content-addressed documents, an immutable
  numbered log, one conditional log create as the commit, per collection.

<!-- Hero demo: render `docs/assets/demo.gif` from `docs/assets/demo.tape`
     (`vhs docs/assets/demo.tape`) against a real bucket, then uncomment:
![baerly-storage in 15 seconds — write a row, then list the bucket](./docs/assets/demo.gif)
-->

## Quick start

```sh
pnpm create @gusto/baerly-storage@latest -- my-app --target=cloudflare --starter=react
cd my-app && pnpm install && pnpm dev
```

For the Cloudflare target, `pnpm dev` boots Vite + workerd on `:5173`, so
`/v1/*` and the React UI share one origin — no S3 creds needed in
development. For Node, scaffold with `--target=node --starter=react`;
`pnpm dev` runs on `:5173` through Vite middleware over `LocalFsStorage`,
and `pnpm start` runs the Node listener on any Node 24+ host with bucket
credentials in its environment — Railway, Render, Fly, Docker, bare VMs.

For a runnable multi-tab demo see
[`examples/react-node/`](./examples/react-node); for the full set of
production-shaped scaffolds see [`examples/`](./examples).

## In code

The scaffolds wire `db` on the server and `useQuery` in React; the calls
look like this:

```ts
// server — writes land in your object-storage bucket
await db.collection("tickets").insert({ title: "Onboard Alex", status: "open" });

// client — reactive across every open tab
const open = useQuery((c) => c.collection("tickets").where({ status: "open" }).all(), []);
// open.status → "loading" | "refreshing" | "ok" | "skipped" | "error"
// open.data is present for "ok" / "refreshing"
```

You keep the request handler, auth boundary, bucket binding or
credentials, and any frontend you already had. The database service goes
away:

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

Ordinary schema shape changes are TypeScript or config edits — no DDL, no
SQL strings, no generated migration ceremony.

## How it works

**Built like git: content-addressed documents, immutable numbered log
entries, and one conditional log create as the commit, per collection.**

A bucket can store objects; it cannot run a transaction coordinator. The
hard part is the commit: one writer must win, and every reader must be
able to tell what won. [S3's strong consistency][s3-strong] makes object
storage usable as shared state; conditional writes supply the
one-writer-wins operation.

A bucket cannot run a database server, but it _can_ atomically create one
object. A write drops new immutable objects in the bucket and then
atomically creates the next numbered log entry for that collection —
using S3's create-if-absent (`If-None-Match`) so two writers can't claim
the same slot; the loser reads the winner and retries at the next slot.
That create _is_ the commit. A read follows `current.json` to the
snapshot and folds the committed log tail into rows.

Each collection has its own ordered log, so **writes are per-collection
linearizable** — the `If-None-Match` log create linearizes every commit.
Cross-collection writes are unordered and non-atomic; that boundary is
part of the contract (see [When (not) to use it](#when-not-to-use-it)).

This repo ships TypeScript for Worker and Node apps, but the idea is a
protocol, not a JavaScript-only database: another language could speak it
by writing the same bucket layout and using the same conditional-write
rules. AWS S3 and Cloudflare R2 are the supported production backends;
other S3-compatible endpoints need a green `baerly doctor --bucket=<uri>`
and owner validation. See
[`storage-compatibility.md`](./docs/spec/storage-compatibility.md).

[s3-strong]: https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/

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
| **Modifiers** | `where` `order` `limit`                                                                |
| **Operators** | `eq` `gt` `gte` `lt` `lte` `in`                                                        |
| **Errors**    | one `BaerlyError`, discriminate by `.code` (`Conflict`, `NotFound`, `SchemaError`, …) |

Full reference: [`docs/guide/cheatsheet.md`](./docs/guide/cheatsheet.md),
or `cat node_modules/@gusto/baerly-storage/dist/API.md` in an installed
app.

## When (not) to use it

Before you count rows or price reads, ask one question:

> Can the app's most important screen be answered from one collection?

If yes, baerly-storage fits. A todo list, a single board's kanban, an
event's RSVPs, one channel's chat — each maps to one collection. If the
core screen is a view _across_ many collections, users, or tenants ("my
pull requests," "all code search," a cross-org dashboard), baerly-storage
should not be the only query engine for it.

It is **deliberately not** a few things:

- **No SQL, no joins.** Equality + dotted-path predicates, operators
  added one at a time. The small surface is part of the contract.
- **Not a D1 / Postgres replacement.** Those are graduation targets, not
  competitors — baerly-storage keeps the experiment cheap until you know
  whether it's worth graduating.
- **Browser-direct multi-writer is out.** Trusted server-side app code is
  the design center.
- **Realtime is long-poll first.** Polling is always correct; a WebSocket
  tier would be a future opt-in.

### Scale at a glance

| Dimension           | Number                                                                                                                  | Notes                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Shape               | 1 important screen = 1 collection                                                                                       | The fit test above; fails before size matters                                                                                     |
| Throughput          | ~30 writes/min/collection sustained                                                                                     | M-size operating point — model/estimate, pending real-infra measurement on Cloudflare R2                                          |
| Per-collection size | ~100–500 docs (~512 KB snapshot) before compaction defers on CF free                                                    | A fold fits the free-tier CPU budget at ~512 KB; erosion, not a cliff — model/estimate, pending real CF-isolate measurement       |
| Fan-out             | ~100 collections/tenant (soft guideline)                                                                                | Bench-grounded linear cost (`pnpm bench:collection-fanout`); nothing in the protocol enforces a cap — cost grows linearly with N   |
| Storage             | >10 GB/tenant stored = R2 free-tier boundary                                                                            | A cost line, not a protocol ceiling; billing begins above 10 GB-mo on R2                                                          |
| Cost                | ~$18/mo all-in on R2 (~$13 object-storage ops + $5 Workers Paid floor), ~$26/mo on S3 at M-size                         | At ~30 writes/min/collection; `baerly cost` projects the object-storage-ops portion only (no platform floor)                       |

**Graduation is the success path, not a failure mode.** Crossing any of
these is the signal to graduate the workload — `baerly export
--target=postgres` makes the exit mechanical. See
[workload-fit.md](./docs/about/workload-fit.md) for the shape test and
[graduation.md](./docs/about/graduation.md) for the full envelope.

## Go deeper

- 🧭 **How it works** —
  [`docs/about/how-it-works.md`](./docs/about/how-it-works.md) (bucket +
  conditional log create)
- 🧱 **Product thesis** — [`docs/about/thesis.md`](./docs/about/thesis.md)
- 🏗️ **Architecture** —
  [`docs/contributing/architecture.md`](./docs/contributing/architecture.md)
- 🔧 **Embed by hand** —
  [`packages/server/API.md`](./packages/server/API.md) (embed-by-hand +
  custom-routes recipes; ships as `dist/API.md` in the package)

## Where things live

- [`CLAUDE.md`](./CLAUDE.md) — agent + contributor entry point (the
  fastest map for humans too). `AGENTS.md` is a symlink.
- [`docs/README.md`](./docs/README.md) — topic map: architecture,
  conventions, ADRs, protocol specs, operating procedures.
- [`examples/`](./examples) — runnable scaffolds + the `react-node/`
  multi-tab demo.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
