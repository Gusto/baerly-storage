---
title: AGENTS.md — agent guidance for react-node
audience: agent
summary: How to develop and deploy react-node, a baerly app.
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
  7386 deletion sentinel, not a storable value.
- Raw SQL strings, `WHERE` clauses, hand-built query AST — the only
  query surface is `db.collection(...).where({ field: value }).all()` or
  `.where(q => q.gte("count", 1))`. See **Predicates** below.
- `.useIndex("name")` / `.hint(...)` — no such methods. The planner
  picks the index automatically from `IndexDefinition`s in
  `baerly.config.ts`. See **Indexes** below.

## What this is

`react-node` is a baerly app scaffolded with `create-baerly-storage` for the
Node target — any host that runs `node server.js` (Railway, Render,
Fly without Docker, Heroku, a VM, a container scheduler). The
Node-side server lives in `src/server/`; the React client lives in
`src/web/`. Configuration lives in `baerly.config.ts`.

Single package, single `vite` process: `baerlyDev()` from
`@gusto/baerly-storage/dev/vite` mounts the Node HTTP listener as Connect
middleware on `:5173` alongside the SPA dev server, so the SPA and
`/v1/*` share an origin (`http://localhost:5173`). In production the
same listener serves the built SPA from `dist/client/` via the
`baerlyNode({ webRoot })` option — same-origin in dev, same-origin
in prod, one process, one port.

This starter is a generic notes app you extend with your own fields —
a Node HTTP listener wired to an S3-compatible bucket plus a working
React+Vite frontend in `src/web/` (served by `baerlyNode({ webRoot })`
in production) with the `Note` shape declared in `baerly.config.ts`.
The bare server-only version is `pnpm create @gusto/baerly-storage <app> --target=node`;
this one is `--target=node --starter=react`.

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

| Command          | What it does                                                                            | Runtime          |
| ---------------- | --------------------------------------------------------------------------------------- | ---------------- |
| `pnpm install`   | One-time bootstrap — the scaffold ships without `node_modules/`, so `pnpm verify` / `pnpm dev` fail with `Cannot find package '…'` until this runs once | seconds to a minute |
| `pnpm verify`    | `pnpm run typecheck && pnpm run test` — the green-light gate; what an agent should run as the smoke check before claiming the change works | seconds |
| `pnpm typecheck` | TS typecheck across the `app` + `server` project references (`tsc -b --noEmit`)        | seconds          |
| `pnpm test`      | `vitest run --passWithNoTests` — standalone `vitest.config.ts` (Node env)              | seconds          |
| `pnpm dev`       | Run `vite` — `baerlyDev()` mounts the Node HTTP listener as Connect middleware next to the SPA dev server; same origin on :5173 | seconds to start |
| `pnpm build`     | `tsc -b && vite build` — emits `dist/client/` for the `baerlyNode({ webRoot })` static-serve branch | seconds  |
| `pnpm start`     | `node --experimental-strip-types src/server/index.ts` — production entry; serves the SPA from `dist/client/` via `webRoot` | seconds to start |

**`pnpm verify` exercises typecheck + tests only.** The dev-auth
middleware, the SPA bundle, and any custom `/api/*` route are NOT
under test — verify will exit green even when the dev plugin returns
401 on every browser request or the SPA throws on mount. For changes
that touch `vite.config.ts`, `src/server/index.ts`, or SPA logic, run
`pnpm dev` and exercise the change in a browser (or `curl
http://localhost:5173/<path>`) before declaring the task complete.

## Where the code is

| Path                       | What it is                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/server/index.ts`      | Server entry — composes `s3Storage` / `r2Storage` + a verifier and calls `baerlyNode({ ... }).listen(PORT)`      |
| `src/web/`                 | React+Vite frontend. Served by the Node listener via `baerlyNode({ webRoot })` in production.                    |
| `index.html`               | SPA shell — Vite's entry point at the project root; references `/src/web/main.tsx`.                              |
| `vite.config.ts`           | Vite + `@vitejs/plugin-react` + `baerlyDev()` — mounts the Node HTTP listener as middleware so SPA + `/v1/*` share `:5173` in dev |
| `tsconfig.json`            | Root project-references stub                                                                                     |
| `tsconfig.app.json`        | Client TS project (`src/web/`, DOM lib, `jsx: react-jsx`)                                                        |
| `tsconfig.server.json`     | Node server TS project (`src/server/`, Node lib)                                                                 |
| `baerly.config.ts`         | App config — `app`, `tenant`, `target`, `collections` (schemas live here). Also exports the inferred `Note` row type used by the web client. |
| `.env.example`             | Source of truth for env vars the Node entry reads (`BUCKET`, `AWS_*`, the optional `BAERLY_MAINTENANCE_*` ops-plane tuners, etc.; `SHARED_SECRET` / `JWKS_URL` only needed if you adopt the "Going to production" auth recipes) |

> **`baerly.config.ts` is dual-included.** Both `tsconfig.app.json`
> and `tsconfig.server.json` `include` this file, so it must only
> import from `baerly-storage`, `zod`, and other files reachable
> from **both** projects. Paths under `src/server/` are server-only;
> importing them here triggers `TS6307: File … is not listed within
> the file list of project … tsconfig.app.json`. Put document
> interfaces here next to their schema (`export type Note =
> z.infer<typeof NoteSchema>`); re-export from a server-only file if
> downstream code wants a local name.

## When editing X, read Y

- **Typed collections** — three ways to get a typed row, in DX order:
  1. **Bind the config.** This template's `src/web/client.ts`
     already passes `config` to `createBaerlyClient({ baseUrl,
     config })`, so `client.collection("notes")` returns
     `ClientCollection<Row>` with `Row` derived from the
     `NoteSchema` declared in `baerly.config.ts`. No generic
     needed. Use `client.collection<Note>("notes")` (with `Note`
     exported from `baerly.config.ts` next to the schema)
     only when you need the row type by name elsewhere.
  2. **Explicit generic, kernel constraint.** Without a declared
     collection, the second overload requires the row to satisfy
     the kernel's `DocumentData` shape (`{ [k: string]: DocumentValue }`):
     ```ts
     import type { DocumentData } from "@gusto/baerly-storage";
     interface Bookmark extends DocumentData { _id: string; url: string }
     await client.collection<Bookmark>("bookmarks").all();
     ```
     A plain `interface Bookmark { _id: string; url: string }`
     (no index signature) will fail with TS2344 — the constraint
     is intentional so the row stays JSON-compatible.

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

- **Predicates** — `db.collection("notes").where({...}).all()`. Two
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
  await db.collection("notes").where({ body: "TODO" }).all();

  // Dotted-path on a nested field
  await db.collection("notes")
    .where({ "meta.source": "import" })
    .all();

  // Operator on a single field — set membership (callback form)
  await db.collection("notes")
    .where(q => q.in("tag", ["todo", "wip"]))
    .all();

  // Range — also callback form
  await db.collection("notes")
    .where(q => q.gte("created_at", "2026-01-01"))
    .all();

  // AND-merge across two .where() calls (mix shapes freely)
  await db.collection("notes")
    .where({ body: "TODO" })
    .where(q => q.gte("priority", 5))
    .all();
  ```

  The plain-equality value type is JSON-arrayless: string / number /
  boolean / nested object. Use `q.in("tag", [...])` for set
  membership when you'd otherwise want `{ tag: ["todo","wip"] }`.

- **Indexes** — declare them in `baerly.config.ts`; the read-path
  planner picks one automatically when the predicate's equality
  fields (and at most one range / `in` clause on the next indexed
  field) cover the index's `on` tuple. No call-site hint is needed
  — `Query<T>` has no `.useIndex()` method.

  ```ts
  import { defineConfig } from "@gusto/baerly-storage/config";

  export default defineConfig({
    collections: {
      notes: {
        indexes: [{ name: "by_body", on: "body" }],
      },
    },
  });
  ```

  The adapter threads `collections` into `Db.create({ ... })` for
  you. Predicates the planner can't route fall back to the full
  scan with a metric bump — correctness is preserved.

- **Schemas (live feature)** — schemas are validated on the server
  for every `insert` / `update` / `replace` when bound. Declare via
  `defineConfig` using any StandardSchema v1 validator (Zod 3.24+,
  Valibot 0.36+, ArkType 2.0+, or anything implementing the spec):

  ```ts
  import { z } from "zod";
  import { defineConfig } from "@gusto/baerly-storage/config";

  const Note = z.object({
    _id: z.string(),
    body: z.string().min(1),
  });

  export default defineConfig({
    collections: {
      notes: { schema: Note },
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
  every request resolves to `tenant: "react-demo"` and `Authorization`
  is ignored. The adapter reads `config.auth` to pick its verifier;
  a `verifier:` on `baerlyNode({ ... })` overrides it. The schema-
  bound `notes` collection (`baerly.config.ts:NoteSchema`) runs
  server-side regardless of the auth posture. `baerly doctor
  --target=node` warns on `"none"` for deploy targets. See "Going to
  production" below for the two production-fit recipes.

### Going to production

The scaffold ships `auth: "none"` so the day-1 happy path works with
zero env vars. The `NoteSchema` in `baerly.config.ts` continues to
validate writes server-side under every posture below — only the
header-check seam changes.

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
  `s3Storage` (AWS) and `r2Storage` (Cloudflare R2 via S3-compat)
  based on whether `R2_ACCOUNT_ID` is set. To use **Minio**
  (self-hosted dev S3) or **GCS** (HMAC keys), swap the import to
  `minioStorage` / `gcsStorage` from `@gusto/baerly-storage/node`. All
  four factories take the same shape — a single bucket-name +
  credentials object — and hide `aws4fetch` / `@xmldom/xmldom`
  behind the package boundary. JSDoc `@example` blocks for each
  factory are visible in your editor's TS hover. The bucket name
  comes from the `BUCKET` env var; AWS credentials are read from
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and optional
  `AWS_REGION`).

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

- **Deploy** — runs anywhere `node server.js` runs. The
  `package.json`'s `start` script is
  `node --experimental-strip-types src/server/index.ts`. Arrange the
  host to run `pnpm install && pnpm build` (populates
  `dist/client/` for the `webRoot` static-serve branch) before
  `pnpm start`. Set env vars from `.env.example` in the host's
  config — at minimum `BUCKET`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`. The default scaffold's `auth: "none"`
  needs no auth env vars; if you adopt Pattern B / C from "Going to
  production" above, also set `SHARED_SECRET` (Pattern B) or
  `JWKS_URL` + `JWT_ISSUER` + `JWT_AUDIENCE` (Pattern C).

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

## Maintenance

<!-- pattern-d:start -->
Maintenance is automatic and write-triggered. No cron, no sidecar, no scheduler, no
timer, no lock, no app-config knob — identical on every host. Every write runs a
bounded GC slice inline plus a go/no-go compaction fold bounded by a fold-size ceiling
whose default is safe on every tier. A size-ratio threshold means idle buckets pay
nothing. Concurrent folds are safe without coordination: the commit is a
compare-and-swap, so a fold that loses to a concurrent write is simply discarded and
its leftover swept by GC. On Cloudflare the fold is deferred past the response via
ctx.waitUntil; everywhere else it runs inline. **Reads are pure** — they never run
maintenance, so the published idle-reader cost bound holds.

A bucket maintains itself as long as it takes writes. A bucket served read-only does
not auto-compact and pays a small, bounded replay — fine at small scale, a signal to
graduate once a collection is large. See docs/about/graduation.md for the per-tier
envelope and the BAERLY_MAINTENANCE_* operator env vars (you almost never need them).

Operator opt-in: call runScheduledMaintenance from @gusto/baerly-storage/maintenance on
your own schedule. Not required for steady-state operation.
<!-- pattern-d:end -->

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

## Worked extensions

Three recipes that come up routinely when you extend the
scaffolded `notes` shape. Each one is target-agnostic — the same
code works in `react-cloudflare` and `react-node`.

### Adding an enum field (e.g. `status`)

A row often needs a constrained set of string values. Declare the
enum inside the Zod schema and export the option tuple next to it
in `baerly.config.ts`; the predicate API picks the field up
automatically.

```typescript
// baerly.config.ts
import { z } from "zod";
import { defineConfig } from "@gusto/baerly-storage/config";

export const NoteSchema = z.object({
  _id: z.string(),
  body: z.string().min(1),
  status: z.enum(["open", "in_progress", "closed"]),
});

export type Note = z.infer<typeof NoteSchema>;
export const STATUSES = NoteSchema.shape.status.options;

export default defineConfig({ /* ... */ });
```

```tsx
// In a form component:
import { STATUSES } from "../../baerly.config.ts";

<select name="status" defaultValue="open">
  {STATUSES.map((s) => (
    <option key={s} value={s}>{s}</option>
  ))}
</select>
```

The schema enum is the single source of truth — adding a value
there expands the `<select>` immediately. Adding more enum fields
(`priority`, `severity`) follows the same shape.

### Filtering a reactive query by predicate

`useQuery((c) => c.collection(...).where(...).all(), [deps])` accepts the
same predicate shapes as the bare client. To narrow by an enum field,
drive it off `useState` and lift the filter into the `deps` array so
the cache key changes when the filter does:

```tsx
import { useState } from "react";
import { STATUSES, type Note } from "../../baerly.config.ts";
import { useQuery } from "./client.ts";

type Filter = "all" | Note["status"];

const [filter, setFilter] = useState<Filter>("all");
// `useQuery` comes from the bound factory in `client.ts`, so
// `c.collection("notes")` infers the `Note` row — no `<Note>`, no cast.
const result = useQuery(
  (c) =>
    filter === "all"
      ? c.collection("notes").all()
      : c.collection("notes").where({ status: filter }).all(),
  [filter],
);
```

`useQuery` re-runs the callback when `deps` changes OR when the
`/v1/since` long-poll batches a non-empty change for any subscribed
collection. Idle long-poll cycles (empty batches) drop at the
`subscription-pool` layer, so a steady-state collection costs zero list
reads. Add a `<select>` bound to `setFilter` and the list narrows live.

For conditional / deferred reads, return the `useQuery.skip` sentinel
from the callback — the hook short-circuits to
`status: "skipped"` with no subscription:

```tsx
const filtered = useQuery(
  (c) =>
    filter === "all"
      ? useQuery.skip
      : c.collection("notes").where({ status: filter }).all(),
  [filter],
);
if (filtered.status === "skipped") return <FullList />;
```

For dependent reads, compose two `useQuery` calls — the second one
returns `useQuery.skip` until the first resolves to `"ok"`:

```tsx
// `comments` must be declared in baerly.config.ts — the bound hooks
// only know your declared collections (an undeclared name is a type error).
const parent = useQuery((c) => c.collection("notes").get(id), [id]);
const replies = useQuery(
  (c) =>
    parent.status === "ok"
      ? c.collection("comments").where({ noteId: parent.data?._id }).all()
      : useQuery.skip,
  [parent.status === "ok" ? parent.data?._id : undefined],
);
```

Mutations are inline: `useMutation()` returns a `[mutate, { isPending,
error }]` tuple. `mutate(cb)` runs `cb` against the real client:

```tsx
const [mutate, { isPending, error }] = useMutation();
<button
  disabled={isPending}
  onClick={() => mutate((c) => c.collection("notes").update(id, { body }))}
>
  {isPending ? "Saving…" : "Save"}
</button>
```

### Optional fields

Some fields aren't always present (`tags` may be missing entirely
on some rows). Zod's `.optional()` models this:

```typescript
export const NoteSchema = z.object({
  _id: z.string(),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),     // tags?: string[]
});
```

The Zod-inferred `Note` type reflects the shape (`tags?: string[]`)
and call sites pick it up through `import type { Note }`.
JSON-merge-patch (RFC 7386) semantics apply on `update()`:
omitting `tags` from an update preserves the existing value;
passing `tags: null` deletes the field; passing `tags: []` sets
it to an empty array. Note that `null` is the deletion sentinel,
not a storable value — `DocumentValue` doesn't include `null`,
so `find()` returns deleted fields as `undefined`, not `null`.
That's why this recipe uses `.optional()` and not `.nullable()`.

## Pointers

- `baerly.config.ts` — app config + `NoteSchema` + inferred `Note` type.
- `src/server/index.ts` — `node:http` listener entry (`baerlyNode`).
- `vite.config.ts` — Vite + `@vitejs/plugin-react` + `baerlyDev()`.
- `.env.example` — env vars the Node entry reads at startup.
- `package.json` — root scripts + dependencies.
