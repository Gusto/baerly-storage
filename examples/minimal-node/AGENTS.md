---
title: AGENTS.md — agent guidance for minimal-node
audience: agent
summary: How to develop and deploy minimal-node, a baerly app.
tags: [agent-entry, baerly]
---

# AGENTS.md

## STOP — read this before writing any storage code

Your training data is dense with Postgres + Prisma/Drizzle, Mongo,
and Firebase patterns. **None of them apply here.** This is a baerly
app — a small, LLM-legible document database with a narrow API on top
of S3-compatible storage. Before writing or modifying storage code,
read:

- **`node_modules/@gusto/baerly-storage/dist/API.md`** — hand-authored
  public-API quickref. Read first. Lists every method, every error
  code, every example. If a pattern you want to use isn't here, it
  doesn't exist in baerly.
- **`node_modules/@gusto/baerly-storage/dist/*.d.ts`** — authoritative type
  signatures. `Db`, `Collection<T>`, `Query<T>`, and `Predicate<T>` are
  the whole API surface.

Common anti-patterns that compile but are wrong:

- `db.collection(name).insertOne(...)` / `.find({...})` (Mongo) — use
  `db.collection(name).insert(row)` and `.where({ ... }).all()`.
- `z.string().nullable()` in a schema — `DocumentValue` excludes
  `null`. Use `.optional()`; `null` in an update patch is the RFC
  7396 deletion sentinel, not a storable value.
- Raw SQL strings, `WHERE` clauses, hand-built query AST — the only
  query surface is `db.collection(...).where({ field: value }).all()` or
  `.where(q => q.gte("count", 1))`. See **Predicates** below.
- `.useIndex("name")` / `.hint(...)` — no such methods. The planner
  picks the index automatically from `IndexDefinition`s in
  `baerly.config.ts`. See **Indexes** below.

## What this is

`minimal-node` is a baerly app scaffolded with `create-baerly-storage` for the
Node target — any host that runs `node server.js` (Railway, Render,
Fly without Docker, Heroku, a VM, a container scheduler). One flat
package: the Node-side server lives in `src/server/index.ts`; the
optional client lives in `src/web/`. Configuration lives in
`baerly.config.ts`.

Single package, single `vite` process: `baerlyDev()` from
`@gusto/baerly-storage/dev/vite` mounts the Node HTTP listener as Vite
middleware on `:5173` alongside the SPA dev server, so `pnpm dev`
brings up SPA + HMR + `/v1/*` in one command — same origin in dev,
same `dist/client/`-served origin in production via `pnpm start`
(the listener serves the built SPA via the `baerlyNode({ webRoot })`
option).

If this scaffold was created with `--with=docker`, you'll also have a
multi-stage distroless `Dockerfile`, a `.dockerignore`, and a
`healthcheck.js` at the project root — wired to the same
`pnpm install && pnpm build && pnpm start` flow.

Public API docs: https://docs.baerly.dev/ (the JSDoc on
`baerly-storage`'s `Db` and `Collection` is the canonical reference;
read it via your editor's TS LS or via the published types).

## Toolchain

- **Package manager:** pnpm. The emitted repo pins
  `packageManager: pnpm@11.1.2`.
- **Test runner:** vitest.
- **Type checker:** TypeScript 5.6+. (The baerly-storage monorepo
  itself uses TypeScript 7 via `@typescript/native-preview`; this
  template tracks the broadly-compatible TS major so scaffolded
  apps work with the wider ecosystem.)
- **`erasableSyntaxOnly`** is enabled in every `tsconfig*.json` so the
  code stays compatible with type-stripping runtimes (Node's
  `--experimental-strip-types`, esbuild's strip path). The flag bans
  TS constructs that can't be type-erased: write
  `class { x: T; constructor(x: T) { this.x = x } }` explicitly
  instead of parameter-property shorthand
  (`constructor(private x: T) {}` fails with TS1294). The same goes
  for `enum`, namespaces with non-type bindings, and `private` /
  `protected` / `public` accessibility modifiers on constructor
  parameters.

## Verification

| Command            | What it does                                       | Runtime          |
| ------------------ | -------------------------------------------------- | ---------------- |
| `pnpm install`     | One-time bootstrap — the scaffold ships without `node_modules/`, so `pnpm verify` / `pnpm dev` fail with `Cannot find package '…'` until this runs once | seconds to a minute |
| `pnpm verify`      | `pnpm run typecheck && pnpm run test` — the green-light gate; what an agent should run as the smoke check before claiming the change works | seconds |
| `pnpm typecheck`   | TS typecheck across the `app` + `server` project references | seconds   |
| `pnpm test`        | `vitest run --passWithNoTests` — standalone `vitest.config.ts` (Node env). The minimal template ships no SPA tests by default; `--passWithNoTests` keeps the gate green until you add one. | seconds |
| `pnpm dev`         | Run `vite` — `baerlyDev()` mounts the Node HTTP listener as Connect middleware next to the SPA dev server; same origin on :5173 | seconds to start |
| `pnpm build`       | `tsc -b && vite build` — emits the SPA into `dist/client/` | seconds  |
| `pnpm start`       | `node --experimental-strip-types src/server/index.ts` — production entry; serves the SPA from `dist/client/` via `webRoot` | seconds to start |

**`pnpm verify` exercises typecheck + tests only.** The dev-auth
middleware, the SPA bundle, and any custom `/api/*` route are NOT
under test — verify will exit green even when the dev plugin returns
401 on every browser request or the SPA throws on mount. For changes
that touch `vite.config.ts`, `src/server/index.ts`, or SPA logic, run
`pnpm dev` and exercise the change in a browser (or `curl
http://localhost:5173/<path>`) before declaring the task complete.

## Where the code is

| Path                        | What it is                                          |
| --------------------------- | --------------------------------------------------- |
| `src/server/index.ts`       | Server entry — composes `s3Storage` / `r2Storage` + a verifier and calls `baerlyNode({ ... }).listen(PORT)` |
| `src/web/`, `index.html`    | Optional SPA shell built by Vite into `dist/client/`. `src/web/main.ts` is a ~17-line hello-world: reads `client.collection<Note>("notes").all()` to render a `${n} note(s)` count and an `[Add note]` button that inserts a timestamped row and re-fetches. Demonstrates both read and write paths on first load — extend, replace, or remove the whole tree if not needed. |
| `vite.config.ts`            | Vite client build — `outDir: dist/client`; `baerlyDev()` mounts the Node listener as middleware so SPA + `/v1/*` share `:5173` in dev |
| `tsconfig.{app,server}.json` | TS project references for the client and server projects |
| `baerly.config.ts`          | App config — `app`, `tenant`, `target`, `domain`, `collections` (schemas live here). |
| `types.ts`                  | Shared types between the Node server (`src/server/`) and the SPA (`src/web/`). Both `tsconfig.app.json` and `tsconfig.server.json` include this file; put any row type or interface that crosses the boundary here. |

> **`baerly.config.ts` and `types.ts` are dual-included** by both
> `tsconfig.app.json` and `tsconfig.server.json`. Both can only
> import from `baerly-storage`, `zod`, and other dual-included root
> files. Paths under `src/server/` are server-only; importing them
> here triggers `TS6307: File … is not listed within the file list
> of project … tsconfig.app.json`. Cross-boundary interfaces belong
> in `types.ts`; re-export from a server-only file if downstream code
> wants a local name.

## When editing X, read Y

- **Writing tests** — the kernel exports `MemoryStorage`, an
  in-memory `Storage` impl that's the canonical backend for unit
  tests. Don't roll your own — `Db.create({ storage, app, tenant,
  config })` is the same boilerplate prod uses; passing
  `new MemoryStorage()` swaps S3 for an in-process map.

  ```ts
  // src/notes.test.ts
  import { test, expect } from "vitest";
  import { Db, MemoryStorage } from "@gusto/baerly-storage";
  import config from "../baerly.config.ts";

  test("notes round-trip", async () => {
    const db = Db.create({
      storage: new MemoryStorage(),
      app: "test",
      tenant: "t",
      config,
    });
    const { _id } = await db.collection("notes").insert({ body: "hello" });
    const row = await db.collection("notes").get(_id);
    expect(row?.body).toBe("hello");
  });
  ```

  Each `new MemoryStorage()` is a fresh bucket — no shared state
  across tests. For multi-writer scenarios (causal-consistency
  tests, etc.), construct one `MemoryStorage` and pass the same
  instance into multiple `Db.create` calls so they share the
  underlying bucket.

- **Predicates** — `db.collection<Doc>(name).where({...}).all()`. Two
  shapes:

  - **Object literal** — equality only (top-level, dotted-path, or
    nested literal sub-predicate). Multi-field is implicit AND.
  - **Callback DSL** — `q => q.eq(...).gt(...).gte(...).lt(...).lte(...).in(...)`
    for the operator vocabulary. The methods on `PredicateBuilder<T>`
    ARE the supported surface — `q.or` / `q.regex` / `q.ne` /
    `q.exists` are TS compile errors. Chained `.where(...).where(...)`
    AND-merges across shapes.

  ```ts
  // Top-level equality
  await db.collection("tickets").where({ status: "open" }).all();

  // Dotted-path on a nested field
  await db.collection("tickets")
    .where({ "assignee.team": "platform" })
    .all();

  // Operator on a single field — set membership (callback form)
  await db.collection("tickets")
    .where(q => q.in("status", ["open", "pending"]))
    .all();

  // Range — also callback form
  await db.collection("tickets")
    .where(q => q.gte("priority", 5).lt("priority", 10))
    .all();

  // AND-merge across two .where() calls (mix shapes freely)
  await db.collection("tickets")
    .where({ status: "open" })
    .where(q => q.gte("priority", 5))
    .all();
  ```

  The plain-equality value type is JSON-arrayless: string / number /
  boolean / nested object. Use `q.in("status", [...])` for
  set membership when you'd otherwise want
  `{ status: ["open","pending"] }`.

- **Indexes** — declare them in `baerly.config.ts`; the read-path
  planner picks one automatically when the predicate's equality
  fields cover an index's keys. No call-site hint is needed (the
  earlier `.useIndex(name)` chain was removed when the planner
  shipped — `Query<T>` has no such method).

  ```ts
  import { defineConfig } from "@gusto/baerly-storage/config";

  export default defineConfig({
    collections: {
      tickets: {
        indexes: [{ name: "by_status", on: "status" }],
      },
    },
  });
  ```

  With that declared, `db.collection("tickets").where({ status: "open"
  }).all()` walks `by_status` automatically. Composite indexes
  (`on: ["status", "priority"]`) match any leftmost prefix.
  Mismatches (predicate doesn't cover any index) fall back to a full
  table scan with a metric bump; correctness is preserved because the
  reader re-checks the predicate in memory regardless of how it got
  the row set.

- **Schemas (live feature)** — schemas are validated on the server
  for every `insert` / `update` / `replace` when bound. Declare via
  `defineConfig` using any StandardSchema v1 validator (Zod 3.24+,
  Valibot 0.36+, ArkType 2.0+, or anything implementing the spec):

  ```ts
  import { z } from "zod";
  import { defineConfig } from "@gusto/baerly-storage/config";

  const Ticket = z.object({
    _id: z.string(),
    status: z.enum(["open", "closed"]),
    title: z.string().min(1),
  });

  export default defineConfig({
    collections: {
      tickets: { schema: Ticket },
    },
  });
  ```

  On a validation failure the server throws
  `BaerlyError{ code: "SchemaError", issues: [{ path, message }] }`;
  HTTP clients see a 422 with the same envelope. Validation runs
  on the post-image so `update` and `replace` see the full doc, not
  just the patch.

- **HTTP wire format (calling `/v1/*` directly)** — the JS SDK
  (`db.collection(name).insert(...)`) is the canonical path; reach for `curl`
  only when debugging the wire. Mutation bodies are wrapped:

  | Route                       | Body                | Response                      |
  | --------------------------- | ------------------- | ----------------------------- |
  | `POST   /v1/c/:collection`       | `{"doc":{...}}`     | `201 {_id}`                   |
  | `PATCH  /v1/c/:collection/:id`   | `{"patch":{...}}`   | `200 {modified}`              |
  | `PUT    /v1/c/:collection/:id`   | `{"doc":{...}}`     | `200 {modified}`              |
  | `DELETE /v1/c/:collection/:id`   | —                   | `204`                         |

  Reads (`GET /v1/c/:collection[/:id]`, `GET /v1/count?collection=…`,
  `GET /v1/since?collection=…&cursor=…`) take no body and return
  `{ data, _meta }` or a route-specific envelope. A flat `POST` body
  (without the `doc` wrapper) returns
  `400 SchemaError "Request body must be { doc: object }"` — the
  wording is locked by `assertJsonBodyField` in the kernel. Canonical
  reference: the `Routes` type and the JSDoc on `createRouter` in
  `baerly-storage`.

- **Auth** — your scaffold ships `auth: "none"` in `baerly.config.ts`:
  every request resolves to `tenant: "minimal-demo"` and `Authorization`
  is ignored. The adapter reads `config.auth` to pick its verifier;
  a `verifier:` on `baerlyNode({ ... })` overrides it. `baerly
  doctor --target=node` warns on `"none"` for deploy targets. See
  "Going to production" below for the two production-fit recipes.

### Going to production

The scaffold ships `auth: "none"` so the day-1 happy path works with
zero env vars. Two patterns flip to a production-fit posture; pick
the one matching your gate.

<!-- pattern-b:start -->
**Pattern B — `auth: "shared-secret"`** (single-tenant
server-to-server). No factory code changes; `baerly.config.ts` flips:

```ts
// baerly.config.ts
auth: "shared-secret",     // ← flip from "none"
```

Dev: put `SHARED_SECRET=dev-shared-secret` in `.env`. Prod: set
`SHARED_SECRET` in the process environment (your PaaS / secret
manager). `baerly doctor --target=node` FAILs if
`auth: "shared-secret"` is set without `SHARED_SECRET` reachable from
`process.env`.

<!-- pattern-b:end -->
<!-- pattern-c:start -->
**Pattern C — JWKS-backed JWT** (multi-tenant; OIDC IdP). The factory
`verifier:` overrides `config.auth`, so dev keeps `"none"` and prod
gets `bearerJwt`:

```ts
// baerly.config.ts — unchanged
auth: "none",     // dev default
```

```ts
// src/server/index.ts
import { baerlyNode, s3Storage } from "@gusto/baerly-storage/node";
import { bearerJwt } from "@gusto/baerly-storage/auth";
import config from "../../baerly.config.ts";

await baerlyNode({
  config,
  storage: s3Storage({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    bucket: process.env["BUCKET"]!,
    credentials: {
      accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
      secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
    },
  }),
  ...(process.env["JWKS_URL"] !== undefined && {
    verifier: bearerJwt({
      jwks: process.env["JWKS_URL"],
      issuer: process.env["JWT_ISSUER"]!,
      audience: process.env["JWT_AUDIENCE"]!,
    }),
  }),
}).listen(Number(process.env["PORT"] ?? 8080));
```

Dev sees `JWKS_URL` as `undefined`, spread short-circuits, and
`config.auth: "none"` runs. Prod sets `JWKS_URL` + `JWT_ISSUER` +
`JWT_AUDIENCE` and `bearerJwt` engages.

<!-- pattern-c:end -->
- **Storage backend** — `src/server/index.ts` picks between
  `s3Storage` (AWS) and `r2Storage` (Cloudflare R2) based on whether
  `R2_ACCOUNT_ID` is set. To use **Minio** (self-hosted dev S3) or
  **GCS** (HMAC keys), swap the import to `minioStorage` /
  `gcsStorage` from `@gusto/baerly-storage/node`. All four factories take
  the same shape — a single bucket-name + credentials object — and
  hide `aws4fetch` / `@xmldom/xmldom` behind the package boundary.
  JSDoc `@example` blocks for each factory are visible in your
  editor's TS hover.

- **Switching from static creds to EKS Pod Identity** — in
  `src/server/index.ts`, swap `credentials: { accessKeyId,
  secretAccessKey }` for `credentials: fromEksPodIdentity()` and add
  `fromEksPodIdentity` to your import:
  `import { s3Storage, fromEksPodIdentity } from "@gusto/baerly-storage/node"`.
  The agent reads `AWS_CONTAINER_CREDENTIALS_FULL_URI` +
  `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` (EKS injects both). For
  IRSA / ECS / EC2 / other AWS contexts, see
  `packages/adapter-node/AGENTS.md` — pass any
  `() => Promise<Credentials>` or an `@aws-sdk/credential-providers`
  factory through the seam.

- **Maintenance loop (Node)** — `src/server/index.ts` passes a
  `maintenance: { collections, tenants }` option to `baerlyNode`.
  Each tick (hourly by default; override via
  `maintenance.intervalMs`) runs one compact+GC pass per
  `(tenant, collection)` pair against the engine's default
  unbounded maintenance profile (folds the entire live tail; sweeps
  every aged-out candidate the GC marks).

  Opt-in via the `MAINTENANCE_COLLECTIONS` env var — a comma-
  separated list of collection slugs:

  ```sh
  MAINTENANCE_COLLECTIONS=tickets,comments
  ```

  When unset, the entry passes `maintenance: undefined` to
  `baerlyNode` and no in-process loop runs. Operators who prefer
  external scheduling can wire a separate cron trigger (PaaS cron,
  k8s CronJob, systemd timer) per collection that invokes
  `runMaintenanceTick` directly — that function stays exported
  from `@gusto/baerly-storage/node`.

  The template is single-tenant by default (`tenants: [TENANT]`).
  Multi-tenant deployments override the `tenants` array in
  `src/server/index.ts`; the cross-product `tenants × collections`
  defines the work per tick. A separate `runMaintenanceTick` call
  fires per pair, and a failure on one pair logs to stderr without
  crashing the process or blocking the others.

  Maintenance emits one canonical info line per `(tenant,
  collection)` run on stdout.
  Filter your log stream on `"unit_of_work": "maintenance"` and
  read these fields:

  - `compact_written` — log entries folded into the new snapshot
    this tick (`0` when the live tail was below
    `minEntriesToCompact`).
  - `gc_swept` — keys deleted this tick (`0` when no candidates
    aged out).
  - The kernel also emits the recorder-bag fields alongside:
    `db.compact.entries_folded_p50` / `_p99` / `_count` / `_sum`,
    `db.manifest.lag_window_depth`, `db.orphan.candidate_count`,
    `db.gc.entries_swept_per_second`, `db.gc.swept_total`.
    Useful for dashboards; the four explicit fields above are
    the at-a-glance summary.

- **Deploy** — runs anywhere `node server.js` runs. The
  `package.json`'s `start` script is
  `node --experimental-strip-types src/server/index.ts`. Arrange the
  host to run `pnpm install && pnpm build` (populates
  `dist/client/` for the `webRoot` static-serve branch) before
  `pnpm start`. Set env vars from `.env.example` in the host's
  config.

  Shapes: **managed PaaS** (Railway, Render, DO App Platform, Fly
  without Docker, Heroku) auto-detects Node and runs the root
  scripts directly. **VM / bare-metal** uses your process manager
  of choice (systemd, pm2). **Container** (Docker, k8s, ECS, Fly
  Machines with a Dockerfile) — scaffold with `--with=docker` to
  add a production Dockerfile alongside this shape, or write your
  own.

## Anti-patterns

- Widening branded types from `baerly-storage` (`UUID`,
  `ContentVersionId`). The types prevent confusion bugs.
- Reaching into `node_modules/@gusto/baerly-storage/dist/` directly —
  consume the published exports.
- Mutating `VerifierResult.tenantPrefix` between the verifier
  and `Db.create`. The dispatcher pins the tenant from the
  verifier's return value.
- Calling `db.collection(...).all()` (or any unbounded read) inside a
  per-request handler. The call scans the entire collection on every
  request — fine for a fixture-sized table, catastrophic at any real
  size, and `pnpm verify` doesn't surface the cost. Push the filter
  into the predicate so the index planner can prune
  (`db.collection("notes").where({ ... }).all()`), or maintain a
  side-projection (Postgres/SQLite/search index) populated
  incrementally from the `/v1/since` log feed or from a write hook —
  never re-scan per request.

## When to graduate

baerly is designed for the small-to-medium operating point. The cost
model puts the soft ceiling at:

- **~30 writes / minute / collection**
- **~10 GB / tenant**
- **~100 collections / tenant**

Past those, S3 list-prefix latency, manifest fold cost, and per-class
op pricing start to dominate; you're better off on a real database.
Pick your graduation target:
- **Cloudflare Workers + lock-in OK:** [D1](https://developers.cloudflare.com/d1/) — cheaper per-write at M-size.
- **Off-Workers or portability matters:** managed Postgres.
- **Single-instance Node:** SQLite via Litestream.

Either way, the export below is mechanical because log entries are
Postgres-logical-replication-shaped — graduation is a Baerly win,
not a churn event.

**Estimate your current rate:** `baerly admin usage --target=...`
lists recent log entries per collection and computes
writes/min. Warning at 50% of the ceiling; export suggestion at
100%.

**Export when ready:** `baerly export --target=sqlite|postgres|d1
--bucket=<...> --app=<...> --tenant=<...> --collection=<...>` writes a
canonical SQL dump (and a `<output>.plan.json` sidecar carrying the
inferred `ExportPlan`) that you load into your graduation target.
The export is point-in-time and honours the active schema. Flags:
`--where=<json-predicate>`, `--where-comment`, `--output`,
`--no-sidecar`, `--json`. Exit codes: 0 success, 1 InvalidConfig,
2 Storage/Network, 3 Protocol invariant.

## Pointers

- `baerly.config.ts` — app config.
- `src/server/index.ts` — node:http listener entry.
- `src/web/main.ts`, `index.html` — SPA client entry.
- `vite.config.ts` — Vite client build (output `dist/client/`).
- `package.json` — single-package root scripts.
