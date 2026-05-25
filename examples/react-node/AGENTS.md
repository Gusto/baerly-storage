---
title: AGENTS.md — agent guidance for react-node
audience: agent
summary: How to develop and deploy react-node, a baerly app.
tags: [agent-entry, baerly]
---

# AGENTS.md

Guidance for AI coding agents working in this repo. This is a
baerly app — a vendorless document database that runs over any
S3-compatible storage API.

## What this is

`react-node` is a baerly app scaffolded with `create-baerly` for the
Node target — any host that runs `node server.js` (Railway, Render,
Fly without Docker, Heroku, a VM, a container scheduler). The
Node-side server lives in `src/server/`; the React client lives in
`src/web/`. Configuration lives in `baerly.config.ts`.

Single package, single `vite` process: `baerlyDev()` from
`baerly-storage/dev/vite` mounts the Node HTTP listener as Connect
middleware on `:5173` alongside the SPA dev server, so the SPA and
`/v1/*` share an origin (`http://localhost:5173`). In production the
same listener serves the built SPA from `dist/client/` via the
`baerlyNode({ webRoot })` option — same-origin in dev, same-origin
in prod, one process, one port.

This starter is a generic notes app you extend with your own fields —
a Node HTTP listener wired to an S3-compatible bucket plus a working
React+Vite frontend in `src/web/` (served by `baerlyNode({ webRoot })`
in production) with the `Note` shape declared in `baerly.config.ts`.
The bare server-only version is `pnpm create baerly <app> --target=node`;
this one is `--target=node --starter=react`.

If this scaffold was created with `--with=docker`, you'll also have a
multi-stage distroless `Dockerfile`, a `.dockerignore`, and a
`healthcheck.js` at the project root — wired to the same
`pnpm install && pnpm build && pnpm start` flow.

Public API docs: https://docs.baerly.dev/ (the JSDoc on
`baerly-storage`'s `Db` and `Table` is the canonical reference;
read it via your editor's TS LS or via the published types).

Headless / CLI agents without a TS LS: `cat
node_modules/baerly-storage/dist/API.md` is a one-read quickref of the
full public API surface (`Db`, `Table`, `Query`, `ConsistencyLevel`,
`DocumentData`, `BaerlyError`, `defineConfig`, `createBaerlyClient`,
and the common imports). Note: that file is `API.md`, not `AGENTS.md`
— this file (the project-root `AGENTS.md` you're reading now) is the
agent guide; the lib ships its API reference at `dist/API.md`.

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
| `.env.example`             | Source of truth for env vars the Node entry reads (`BUCKET`, `AWS_*`, `MAINTENANCE_COLLECTIONS`, etc.; `SHARED_SECRET` / `JWKS_URL` only needed if you adopt the "Going to production" auth recipes) |

## When editing X, read Y

- **Typed tables** — three ways to get a typed row, in DX order:
  1. **Bind the config.** This template's `src/web/client.ts`
     already passes `config` to `createBaerlyClient({ baseUrl,
     config })`, so `client.table("notes")` returns
     `ClientTable<Row>` with `Row` derived from the
     `NoteSchema` declared in `baerly.config.ts`. No generic
     needed. Use `client.table<Note>("notes")` (with `Note`
     exported from `baerly.config.ts` next to the schema)
     only when you need the row type by name elsewhere.
  2. **Explicit generic, kernel constraint.** Without a declared
     collection, the second overload requires the row to satisfy
     the kernel's `DocumentData` shape (`{ [k: string]: DocumentValue }`):
     ```ts
     import type { DocumentData } from "baerly-storage";
     interface Bookmark extends DocumentData { _id: string; url: string }
     await client.table<Bookmark>("bookmarks").all();
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
  import { Db, MemoryStorage } from "baerly-storage";
  import config from "../baerly.config.ts";

  test("notes round-trip", async () => {
    const db = Db.create({
      storage: new MemoryStorage(),
      app: "test",
      tenant: "t",
      config,
    });
    const { _id } = await db.table("notes").insert({ body: "hello" });
    const row = await db.table("notes").get(_id);
    expect(row?.body).toBe("hello");
  });
  ```

  Each `new MemoryStorage()` is a fresh bucket — no shared state
  across tests. For multi-writer scenarios (causal-consistency
  tests, etc.), construct one `MemoryStorage` and pass the same
  instance into multiple `Db.create` calls so they share the
  underlying bucket.

- **Predicates** — `db.table("notes").where({...}).all()`. The
  predicate is exact-equality only on day one; top-level fields and
  dotted-path keys are supported. There are no operators (`$or`,
  `$gt`, `$in`, `$regex`). Calling `.where(...)` twice AND-merges:

  ```ts
  // Top-level equality
  await db.table("notes").where({ body: "TODO" }).all();

  // Dotted-path on a nested field
  await db.table("notes")
    .where({ "meta.source": "import" })
    .all();

  // AND-merge across two .where() calls
  await db.table("notes")
    .where({ body: "TODO" })
    .where({ "meta.source": "import" })
    .all();
  ```

  The value type is JSON-arrayless: string / number / boolean / nested
  object. Arrays are intentionally not supported as predicate values;
  use `useIndex` (next bullet) for index-backed lookups.

- **Indexes (`useIndex`)** — opt-in hint for the read path to walk a
  secondary index instead of folding the snapshot + scanning the
  table. Single-field equality only today (the planner that
  auto-picks an index is future work). The reader still re-checks the
  predicate in memory, so a stale index never produces wrong rows —
  only at worst surfaces a row the predicate then drops.

  ```ts
  await db.table("notes")
    .where({ body: "TODO" })
    .useIndex("by_body")
    .all();
  ```

  Declare indexes in `baerly.config.ts` via:

  ```ts
  import { defineConfig } from "baerly-storage/config";

  export default defineConfig({
    collections: {
      notes: {
        indexes: [{ name: "by_body", on: "body" }],
      },
    },
  });
  ```

  The adapter threads `collections` into `Db.create({ ... })` for
  you. Mismatches (multi-field predicate or missing index) fall back
  to the full table scan with a metric bump — correctness is
  preserved.

- **Consistency** — every terminal read takes an optional
  `.consistency("eventual" | "strong")` modifier; mutations are
  always strong.

  ```ts
  // Strong (default): GETs `current.json` fresh, then folds the log.
  // Use after a write you just made, or for single-user flows where
  // the user expects to see their own change reflected immediately.
  await db.table("notes").where({ body: "TODO" }).all();

  // Eventual: skips the per-call `current.json` GET; serves the view
  // this isolate observed when it last advanced. May be one pointer
  // old. Use for background polls, auto-refresh, list views — places
  // where shaving one Class B op per read matters more than the
  // last-write being reflected.
  await db.table("notes")
    .where({ body: "TODO" })
    .consistency("eventual")
    .all();
  ```

  Last-call-wins on repeat invocation. A follow-up
  `.consistency("strong")` re-anchors. HTTP mirror:
  `?consistency=eventual` on `GET /v1/t/:table` and
  `GET /v1/t/:table/:id`.

  `useLiveQuery` accepts the same `consistency` and `order`
  options as an options-bag — auto-refresh list views are the
  canonical case for `consistency: "eventual"` since the long-poll
  subscription still fires the refetch as soon as a change lands:

  ```tsx
  const result = useLiveQuery<Note>({
    table: "notes",
    where: { body: "TODO" },
    order: { _id: "desc" },
    consistency: "eventual",
  });
  ```

- **Schemas (live feature)** — schemas are validated on the server
  for every `insert` / `update` / `replace` when bound. Declare via
  `defineConfig` using any StandardSchema v1 validator (Zod 3.24+,
  Valibot 0.36+, ArkType 2.0+, or anything implementing the spec):

  ```ts
  import { z } from "zod";
  import { defineConfig } from "baerly-storage/config";

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
  (`db.table(name).insert(...)`) is the canonical path; reach for `curl`
  only when debugging the wire. Mutation bodies are wrapped:

  | Route                       | Body                | Response                      |
  | --------------------------- | ------------------- | ----------------------------- |
  | `POST   /v1/t/:table`       | `{"doc":{...}}`     | `201 {_id}`                   |
  | `PATCH  /v1/t/:table/:id`   | `{"patch":{...}}`   | `200 {modified}`              |
  | `PUT    /v1/t/:table/:id`   | `{"doc":{...}}`     | `200 {modified}`              |
  | `DELETE /v1/t/:table/:id`   | —                   | `204`                         |

  Reads (`GET /v1/t/:table[/:id]`, `GET /v1/count?table=…`,
  `GET /v1/since?table=…&cursor=…`) take no body and return
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

**Pattern C — JWKS-backed JWT** (multi-tenant; OIDC IdP). The factory
`verifier:` overrides `config.auth`, so dev keeps `"none"` and prod
gets `bearerJwt`:

```ts
// baerly.config.ts — unchanged
auth: "none",     // dev default
```

```ts
// src/server/index.ts
import { baerlyNode, s3Storage } from "baerly-storage/node";
import { bearerJwt } from "baerly-storage/auth";
import config from "../../baerly.config.ts";

await baerlyNode({
  config,
  storage: s3Storage({
    region: process.env["AWS_REGION"] ?? "us-east-1",
    bucket: process.env["BUCKET"]!,
    accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
    secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
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

- **Storage backend** — `src/server/index.ts` picks between
  `s3Storage` (AWS) and `r2Storage` (Cloudflare R2 via S3-compat)
  based on whether `R2_ACCOUNT_ID` is set. To use **Minio**
  (self-hosted dev S3) or **GCS** (HMAC keys), swap the import to
  `minioStorage` / `gcsStorage` from `baerly-storage/node`. All
  four factories take the same shape — a single bucket-name +
  credentials object — and hide `aws4fetch` / `@xmldom/xmldom`
  behind the package boundary. JSDoc `@example` blocks for each
  factory are visible in your editor's TS hover. The bucket name
  comes from the `BUCKET` env var; AWS credentials are read from
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and optional
  `AWS_REGION`).

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
  MAINTENANCE_COLLECTIONS=notes
  ```

  When unset, the entry passes `maintenance: undefined` to
  `baerlyNode` and no in-process loop runs. Operators who prefer
  external scheduling can wire a separate cron trigger (PaaS cron,
  k8s CronJob, systemd timer) per collection that invokes
  `runMaintenanceTick` directly — that function stays exported
  from `baerly-storage/node`.

  The template is single-tenant by default (`tenants: [TENANT]`).
  Multi-tenant deployments override the `tenants` array in
  `src/server/index.ts`; the cross-product `tenants × collections`
  defines the work per tick. A separate `runMaintenanceTick` call
  fires per pair, and a failure on one pair logs to stderr without
  crashing the process or blocking the others.

  Maintenance emits one canonical info line per `(tenant,
  collection)` run on stdout. Filter your log stream on
  `"unit_of_work": "maintenance"` and read these fields:

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
- Reaching into `node_modules/baerly-storage/dist/` directly —
  consume the published exports.
- Mutating `VerifierResult.tenantPrefix` between the verifier
  and `Db.create`. The dispatcher pins the tenant from the
  verifier's return value.
- Calling `db.table(...).all()` (or any unbounded read) inside a
  per-request handler. The call scans the entire collection on every
  request — fine for a fixture-sized table, catastrophic at any real
  size, and `pnpm verify` doesn't surface the cost. Push the filter
  into the predicate so the index planner can prune
  (`db.table("notes").where({ ... }).all()`), or maintain a
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
The graduation target is **D1** (or Postgres, or SQLite via Litestream
— pick what fits your runtime). At the M-size operating point, D1
costs roughly $5/month versus baerly's ~$19/month; the pitch is
portability, not cost.

**Estimate your current rate:** `baerly admin usage --target=...`
lists recent log entries per collection and computes
writes/min. Warning at 50% of the ceiling; export suggestion at
100%.

**Export when ready:** `baerly export --target=sqlite|postgres|d1
--bucket=<...> --app=<...> --tenant=<...> --table=<...>` writes a
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
import { defineConfig } from "baerly-storage/config";

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

### Filtering a live query by predicate

`useLiveQuery({ where })` takes the same predicate AST the backend
uses. To narrow by an enum field, drive it off `useState`:

```tsx
import { useState } from "react";
import { useLiveQuery } from "baerly-storage/client/react";
import { STATUSES, type Note } from "../../baerly.config.ts";

type Filter = "all" | Note["status"];

const [filter, setFilter] = useState<Filter>("all");
const result = useLiveQuery<Note>({
  table: "notes",
  where: filter === "all" ? {} : { status: filter },
});
```

`useLiveQuery` re-runs the query when the predicate changes AND
when the `/v1/since` long-poll batches a non-empty change for
`notes`. Idle long-poll cycles (empty batches) are dropped at the
`useInvalidationTick` layer, so a steady-state table costs zero
list reads. Add a `<select>` bound to `setFilter` and the list
narrows live.

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
JSON-merge-patch (RFC 7396) semantics apply on `update()`:
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
