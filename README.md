# baerly-storage

**A database with no server. No daemon. No database runtime. Just your app and a bucket.**

```text
before: client → app handler → database server  (a server)
after:  client → app handler → S3/R2 bucket     (just storage)
```

baerly-storage is a **document database whose execution layer fits inside
an HTTP request**.

It stores durable state in S3-compatible object storage, including AWS S3
and Cloudflare R2, and ships as a TypeScript implementation for Workers
and Node.

There is no database server, daemon, or coordinator. Each read or write
runs as library code inside your Worker or Node handler; the bucket holds
the data, and the protocol supplies the commit rules.

The load-bearing operation is narrow: one conditional create of the next
log object commits a write. When the request ends, baerly-storage is
gone.

- **A tiny API humans and agents can hold in context.** No DDL, no raw
  SQL — 8 verbs and a ~12k-token API surface.
- **Idle rounds to zero.** No database process to keep warm, and no
  per-app database floor across a fleet of small internal tools.
- **No data hostage.** `baerly export --target=postgres` gives you a
  per-collection SQL snapshot. Crossing the envelope is the graduation
  signal; the data exit is mechanical.
- **Built like git.** Content-addressed documents, immutable numbered log
  entries, and one conditional log create as the commit, per collection.

<!-- Hero demo: render `docs/assets/demo.gif` from `docs/assets/demo.tape`
     (`vhs docs/assets/demo.tape`) against a real bucket, then uncomment:
![baerly-storage in 15 seconds — write a row, then list the bucket](./docs/assets/demo.gif)
-->

## Quick start

```sh
pnpm create @gusto/baerly-storage@latest
```

The wizard asks for a project name, target, and starter, then prints the
dev command. First run needs no bucket credentials: local dev uses local
storage and serves the UI plus `/v1/*` from one origin.

For a runnable multi-tab demo see
[`examples/react-node/`](./examples/react-node); for the full set of
production-shaped scaffolds see [`examples/`](./examples).

## In code

The public surface is a small document API. The scaffolds wire `db` on
the server and `useQuery` in React; the calls look like this:

```ts
// server — writes land in your object-storage bucket
await db.collection("tickets").insert({ title: "Onboard Alex", status: "open" });

// client — reactive over your trusted handler, across every open tab
const open = useQuery((c) => c.collection("tickets").where({ status: "open" }).all(), []);
// open.status → "loading" | "refreshing" | "ok" | "skipped" | "error"
// open.data is present for "ok" / "refreshing"
```

Application auth and tenant choice stay explicit in the handler. What
disappears is the database service and its surrounding machinery:

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
+   auth: "none", // dev; production supplies a verifier
+ });
```

Ordinary schema shape changes are TypeScript or config edits — no DDL, no
SQL strings, no generated migration ceremony.

### Security model

Bucket credentials never leave the server. Browsers talk only to your
trusted handler, which authenticates the caller, chooses the tenant
prefix, and applies the protocol against the bucket. Production recipes
support Cloudflare Access and JWKS bearer verification; shared-secret
auth is for service-to-service calls and dev. See
[`client-auth.md`](./docs/guide/client-auth.md).

## How it works

**Built like git: content-addressed documents, immutable numbered log
entries, and one conditional log create as the commit, per collection.**

A bucket can store objects; it cannot run a transaction coordinator. The
hard part is the commit: one writer must win, and every reader must be
able to tell what won. [S3's strong consistency][s3-strong] makes object
storage usable as shared state; conditional writes supply the
one-writer-wins operation.

Concretely, a write drops new immutable objects in the bucket and then
creates the next numbered log entry for that collection with
create-if-absent (`If-None-Match: "*"`). Two writers racing the same slot
cannot both win; the loser reads the winner and retries at the next slot.
That create _is_ the commit. There is no resident coordinator: each
request reads bucket state, tries that create, and leaves no required
process behind. A read follows `current.json` to the snapshot and folds
the committed log tail into rows.

This is the write-immutable-data-then-publish-an-atomic-pointer pattern
that table formats like Apache Iceberg use, narrowed to a document
database: the commit is a single conditional create of the next numbered
log object (`If-None-Match`), made safe by S3's strong read-after-write
consistency and conditional writes — no separate coordinator. See
[prior art and lineage](docs/spec/prior-art.md) for how it relates to
Iceberg, Delta Lake, Litestream, and Turbopuffer.

Each collection has its own ordered log, so **writes are per-collection
linearizable** — the `If-None-Match` log create linearizes every commit.
Cross-collection writes are unordered and non-atomic; that boundary is
part of the contract (see [When (not) to use it](#when-not-to-use-it)).

The durable contract is the bucket layout plus the conditional-write
rules. Another language could speak it by writing the same layout and
honoring the same rules. See
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

If yes, baerly-storage may fit; then check query shape, atomicity, size,
and cost. A todo list, a single board's kanban, an event's RSVPs, one
channel's chat — each maps to one collection. The shape is narrow on
purpose: production-shaped for small workloads with a specific access
pattern, not a general-purpose database. If the core screen is a view
_across_ many collections, users, or tenants ("my pull requests," "all
code search," a cross-org dashboard), baerly-storage
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
| Cost                | ~$18/mo all-in on R2 (~$13 object-storage ops + $5 Workers Paid floor), ~$26/mo on S3 at M-size                         | At ~30 writes/min account-wide aggregate; `baerly cost` projects the object-storage-ops portion only (no platform floor)           |

**Graduation is the success path, not a failure mode.** Crossing any of
these is the signal to graduate the workload — `baerly export
--target=postgres` makes the data exit mechanical. See
[workload-fit.md](./docs/about/workload-fit.md) for the shape test and
[graduation.md](./docs/about/graduation.md) for the full envelope.

## Go deeper

- 🧭 **How it works** —
  [`docs/about/how-it-works.md`](./docs/about/how-it-works.md) (bucket +
  conditional log create)
- 🧱 **Product thesis** — [`docs/about/thesis.md`](./docs/about/thesis.md)
- 🏗️ **Architecture** —
  [`docs/architecture.md`](./docs/architecture.md)
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
