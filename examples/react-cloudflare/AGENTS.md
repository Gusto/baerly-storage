---
title: AGENTS.md — agent guidance for react-cloudflare
audience: agent
summary: How to develop and deploy react-cloudflare, a baerly app.
tags: [agent-entry, baerly]
---

# AGENTS.md

Guidance for AI coding agents working in this repo. This is a
baerly app — a vendorless document database that runs over any
S3-compatible storage API.

## What this is

`react-cloudflare` is a baerly app scaffolded with `create-baerly`.
The Worker-side server lives in `src/server/`; the React client lives
in `src/web/`. Configuration lives in `baerly.config.ts`.

Single package, single `vite` process: `@cloudflare/vite-plugin` runs
the Worker inside `workerd` alongside the SPA dev server, and
`wrangler.jsonc:assets` ships the built `dist/client/` bundle next to
the Worker on deploy. Same origin in dev and prod, one deploy.

This starter is a generic notes app you extend with your own fields —
a Cloudflare Worker wired to R2 plus a working React+Vite frontend in
`src/web/` (served by the Worker via Workers Assets) with the `Note`
shape declared in `types.ts`. The bare server-only version is
`pnpm create baerly <app> --target=cloudflare`; this one is
`--target=cloudflare --starter=react`.

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
| `pnpm typecheck` | TS typecheck across the worker + web project references (`tsc -b --noEmit`)            | seconds          |
| `pnpm test`      | `vitest run --passWithNoTests` — standalone `vitest.config.ts` (Node env, ignores `vite.config.ts` so the Cloudflare plugin doesn't load) | seconds |
| `pnpm dev`       | Run `vite` — the Cloudflare plugin runs the Worker inside `workerd` next to the SPA dev server; same origin on :5173 | seconds to start |
| `pnpm build`     | `tsc -b && vite build` — emits `dist/client/` for the Workers Assets binding            | seconds          |
| `pnpm deploy`    | `wrangler deploy` — ships Worker + assets in one shipment (auto-creates R2 on first run via `--x-provision`) | seconds          |

## Where the code is

| Path                       | What it is                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/server/index.ts`      | Server entry — `/v1/*` routing + SPA fallback via `env.ASSETS`                                                   |
| `wrangler.jsonc`           | Cloudflare Worker manifest — name, R2 binding, Assets binding, vars, triggers, limits, observability             |
| `src/web/`                 | React+Vite frontend. Served by the Worker via Workers Assets in production.                                      |
| `index.html`               | SPA shell — Vite's entry point at the project root; references `/src/web/main.tsx`.                              |
| `vite.config.ts`           | Vite + `@vitejs/plugin-react` + `@cloudflare/vite-plugin` — runs the Worker inside `workerd` in dev              |
| `tsconfig.json`            | Root project-references stub                                                                                     |
| `tsconfig.app.json`        | Client TS project (`src/web/`, DOM lib, `jsx: react-jsx`)                                                        |
| `tsconfig.worker.json`     | Worker TS project (`src/server/`, workerd lib)                                                                   |
| `baerly.config.ts`         | App config — `app`, `tenant`, `target`, `domain`, `collections` (schemas live here).                             |
| `types.ts`                 | `Note` row type inferred from `NoteSchema` in `baerly.config.ts`. Imported by both the server and the web client. |

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

- **Auth setup (Cloudflare)** — `SHARED_SECRET` is
  server-to-server-only; never put it in the SPA bundle.

  - **Dev:** `baerlyDevAuth` in `vite.config.ts` injects the bearer
    server-side from `.dev.vars`. The SPA calls `/v1/*` with no
    `Authorization` header — the secret never enters the bundle.
  - **Prod:** wire CF Access in front of the Worker route and set
    `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUDIENCE_TAG` in
    `wrangler.jsonc:vars`. `baerly doctor --target=cloudflare`
    warns if `SHARED_SECRET` is set on a deploy without CF Access.
  - **`SHARED_SECRET` in prod** is for server-to-server callers
    (CI, cron, internal services), not the SPA. The doctor
    warning gates this.

- **Secrets vs. vars** — `wrangler.jsonc:vars` carries non-secret
  config (`APP`, `TENANT`, `LOG_LEVEL`, `LOG_SAMPLE`, and CF Access
  identifiers `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUDIENCE_TAG` —
  both are public identifiers, not secrets). The verifier's only
  secret is `SHARED_SECRET`; it lives in `.dev.vars` for local
  `wrangler dev` and behind `wrangler secret put` in production.
  `.dev.vars.example` is the source of truth for which secrets the
  Worker reads — keep it in sync with the verifier choices in
  `src/server/index.ts`. `baerly doctor --target=cloudflare` only
  reads `CF_ACCESS_*` from `wrangler.jsonc:vars`, so setting them
  via `wrangler secret put` would silently defeat the doctor check.

- **Maintenance loop (Cloudflare)** — opt-in. Add
  `"triggers": { "crons": ["* * * * *"] }` to `wrangler.jsonc` and
  wire `scheduled` on the `baerlyWorker({ ... })` options bag. The
  handler is your code, so you choose what to call
  (`runScheduledMaintenance`, `compact`, `runGc`) and which
  `current.json` keys to target. Multi-tenant deployments iterate
  their own keys; single-tenant deployments call once with a fixed
  key. See the JSDoc on `WorkerScheduledHandler` in
  `baerly-storage/cloudflare` and `runScheduledMaintenance` in
  `baerly-storage/maintenance` for the wiring + free-vs-paid-tier
  subrequest-budget guidance.

  Maintenance emits one canonical info line per run on stdout
  (Workers Logs ingestion). Filter your log stream on
  `"unit_of_work": "maintenance"` and read these fields:

  - `compact_written` — log entries folded into the new snapshot
    this tick (`0` when the live tail was below
    `minEntriesToCompact`). Only set when the tick called
    `runScheduledMaintenance` or `compact` directly; isolated
    `runGc` ticks emit their own `unit_of_work: "gc"` line.
  - `gc_swept` — keys deleted this tick (`0` when no candidates
    aged out). Only set when the tick called
    `runScheduledMaintenance` or `runGc` directly.
  - The kernel also emits the recorder-bag fields alongside:
    `db.compact.entries_folded_p50` / `_p99` / `_count` / `_sum`,
    `db.manifest.lag_window_depth`, `db.orphan.candidate_count`,
    `db.gc.entries_swept_per_second`, `db.gc.swept_total`.
    Useful for dashboards; the four explicit fields above are
    the at-a-glance summary.

- **Deploy** — `baerly deploy --target=cloudflare` runs
  `wrangler deploy --x-provision --x-auto-create` (Wrangler 4.10+)
  to auto-create the declared R2 buckets and ship the Worker. When
  the experimental flag is unavailable it falls back to
  `wrangler r2 bucket create` + `wrangler deploy`. The fallback is
  also what `baerly doctor --target=cloudflare --fix` exercises.

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
- `src/server/index.ts` — Worker entry.
- `wrangler.jsonc` — Cloudflare Worker manifest (R2 binding, `assets:`, vars, cron, observability).
- `vite.config.ts` — Vite + `@vitejs/plugin-react` + `@cloudflare/vite-plugin`.
- `types.ts` — `Note` row type inferred from `NoteSchema`.
- `package.json` — root scripts + dependencies.
