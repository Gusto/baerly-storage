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
in production) with the `Note` shape declared in `types.ts`. The bare
server-only version is `pnpm create baerly <app> --target=node`; this
one is `--target=node --starter=react`.

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

## Verification

| Command          | What it does                                                                            | Runtime          |
| ---------------- | --------------------------------------------------------------------------------------- | ---------------- |
| `pnpm verify`    | `pnpm run typecheck && pnpm run test` — the green-light gate; what an agent should run as the smoke check before claiming the change works | seconds |
| `pnpm typecheck` | TS typecheck across the `app` + `server` project references (`tsc -b --noEmit`)        | seconds          |
| `pnpm test`      | `vitest run --passWithNoTests` — standalone `vitest.config.ts` (Node env)              | seconds          |
| `pnpm dev`       | Run `vite` — `baerlyDev()` mounts the Node HTTP listener as Connect middleware next to the SPA dev server; same origin on :5173 | seconds to start |
| `pnpm build`     | `tsc -b && vite build` — emits `dist/client/` for the `baerlyNode({ webRoot })` static-serve branch | seconds  |
| `pnpm start`     | `node --experimental-strip-types src/server/index.ts` — production entry; serves the SPA from `dist/client/` via `webRoot` | seconds to start |

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
| `baerly.config.ts`         | App config — `app`, `tenant`, `target`, `domain`, `collections` (schemas live here).                             |
| `types.ts`                 | `Note` row type inferred from `NoteSchema` in `baerly.config.ts`. Imported by both the server and the web client. |
| `.env.example`             | Source of truth for env vars the Node entry reads (`BUCKET`, `AWS_*`, `JWKS_URL` / `SHARED_SECRET`, `MAINTENANCE_COLLECTIONS`, etc.) |

## When editing X, read Y

- **Typed tables** — three ways to get a typed row, in DX order:
  1. **Bind the config.** This template's `src/web/client.ts`
     already passes `config` to `createBaerlyClient({ baseUrl,
     config })`, so `client.table("notes")` returns
     `ClientTable<Row>` with `Row` derived from the
     `NoteSchema` declared in `baerly.config.ts`. No generic
     needed. Use `client.table<Note>("notes")` (with
     `Note = z.infer<typeof NoteSchema>` from `types.ts`)
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
    created_at: z.string(),
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

- **Auth setup (Node)** — `SHARED_SECRET` is server-to-server-only;
  never put it in the SPA bundle.

  - **Dev:** `baerlyDevAuth` in `vite.config.ts` injects the bearer
    server-side from `.env` (or `process.env.SHARED_SECRET`). The
    SPA calls `/v1/*` with no `Authorization` header — the secret
    never enters the bundle.
  - **Prod:** swap `sharedSecret` for `bearerJwt({ jwks, issuer,
    audience })` against your OIDC provider. The Node entry reads
    `JWKS_URL`, `JWT_ISSUER`, and `JWT_AUDIENCE` from the
    environment and constructs the verifier. The SPA acquires its
    token via the OIDC flow and sends
    `Authorization: Bearer <jwt>`.
  - **`SHARED_SECRET` in prod** is for server-to-server callers
    (CI, cron, internal services), not the SPA.

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
  `AWS_SECRET_ACCESS_KEY`, and either `JWKS_URL` (production) or
  `SHARED_SECRET` (parity with `pnpm dev`).

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

## Pointers

- `baerly.config.ts` — app config.
- `src/server/index.ts` — `node:http` listener entry (`baerlyNode`).
- `vite.config.ts` — Vite + `@vitejs/plugin-react` + `baerlyDev()`.
- `types.ts` — `Note` row type inferred from `NoteSchema`.
- `.env.example` — env vars the Node entry reads at startup.
- `package.json` — root scripts + dependencies.
