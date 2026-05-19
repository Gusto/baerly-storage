---
title: AGENTS.md — agent guidance for minimal-cloudflare
audience: agent
summary: How to develop and deploy minimal-cloudflare, a baerly app.
tags: [agent-entry, baerly]
---

# AGENTS.md

Guidance for AI coding agents working in this repo. This is a
baerly app — a vendorless document database that runs over any
S3-compatible storage API.

## What this is

`minimal-cloudflare` is a baerly app scaffolded with `create-baerly`.
The Worker-side server lives in `src/server/`; the optional client
lives in `src/web/`. Configuration lives in `baerly.config.ts`.

Single package, single `vite` process: `@cloudflare/vite-plugin` runs
the Worker inside `workerd` alongside the SPA dev server, and
`wrangler.jsonc:assets` ships the built `dist/client/` bundle next to
the Worker on deploy. Same origin in dev and prod, one deploy.

Public API docs: https://docs.baerly.dev/ (the JSDoc on
`baerly-storage`'s `Db` and `Table` is the canonical reference;
read it via your editor's TS LS or via the published types).

## Toolchain

- **Package manager:** pnpm. The emitted repo pins
  `packageManager: pnpm@10.31.0`.
- **Test runner:** vitest.
- **Type checker:** TypeScript 5.6+. (The baerly-storage monorepo
  itself uses TypeScript 7 via `@typescript/native-preview`; this
  template tracks the broadly-compatible TS major so scaffolded
  apps work with the wider ecosystem.)

## Verification

| Command          | What it does                                                                            | Runtime          |
| ---------------- | --------------------------------------------------------------------------------------- | ---------------- |
| `pnpm typecheck` | TS typecheck across the worker + web project references (`tsc -b --noEmit`)            | seconds          |
| `pnpm dev`       | Run `vite` — the Cloudflare plugin runs the Worker inside `workerd` next to the SPA dev server; same origin on :5173 | seconds to start |
| `pnpm build`     | `tsc -b && vite build` — emits `dist/client/` for the Workers Assets binding            | seconds          |
| `pnpm deploy`    | `wrangler deploy` — ships Worker + assets in one shipment (auto-creates R2 on first run via `--x-provision`) | seconds          |
| `pnpm test`      | Run vitest                                                                              | seconds          |

## Where the code is

| Path                       | What it is                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `src/server/index.ts`      | Worker entry — `baerlyWorker({ verifier })`                                          |
| `wrangler.jsonc`           | Cloudflare Worker manifest — name, R2 binding, assets, vars, triggers, limits, observability |
| `index.html`               | SPA shell — Vite's entry point at the project root; references `/src/web/main.ts`.  |
| `src/web/main.ts`          | SPA client entry. Workers Assets serves the built bundle from `dist/client/`.        |
| `vite.config.ts`           | Vite + `@cloudflare/vite-plugin` — runs the Worker inside `workerd` in dev          |
| `tsconfig.json`            | Root project-references stub                                                         |
| `tsconfig.app.json`        | Client TS project (`src/web/`, DOM lib)                                              |
| `tsconfig.worker.json`     | Worker TS project (`src/server/`, workerd lib)                                       |
| `baerly.config.ts`         | App config — `app`, `tenant`, `target`, `domain`                                     |
| `.baerly/schema.lock.json` | Declared collection schemas — see "Schemas (live feature)" below.                    |

## When editing X, read Y

- **Predicates** — `db.table<Doc>(name).where({...}).all()`. The
  predicate is exact-equality only on day one; top-level fields and
  dotted-path keys are supported. There are no operators (`$or`,
  `$gt`, `$in`, `$regex`). Calling `.where(...)` twice AND-merges:

  ```ts
  // Top-level equality
  await db.table("tickets").where({ status: "open" }).all();

  // Dotted-path on a nested field
  await db.table("tickets")
    .where({ "assignee.team": "platform" })
    .all();

  // AND-merge across two .where() calls
  await db.table("tickets")
    .where({ status: "open" })
    .where({ "assignee.team": "platform" })
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
  await db.table("tickets")
    .where({ status: "open" })
    .useIndex("by_status")
    .all();
  ```

  Declare indexes in `baerly.config.ts` via:

  ```ts
  import { defineConfig } from "baerly-storage/config";

  export default defineConfig({
    collections: {
      tickets: {
        indexes: [{ name: "by_status", on: "status" }],
      },
    },
  });
  ```

  The adapter threads `collections` into `Db.create({ ... })` for
  you. Mismatches (multi-field predicate or missing index) fall back
  to the full table scan with a metric bump — correctness is
  preserved.

- **Schemas (live feature)** — schemas are validated on the server
  for every `insert` / `update` / `replace` when bound. Declare via
  `defineConfig` using any StandardSchema v1 validator (Zod 3.24+,
  Valibot 0.36+, ArkType 2.0+, or anything implementing the spec):

  ```ts
  import { z } from "zod";
  import { defineConfig } from "baerly-storage/config";

  const Ticket = z.object({
    _id: z.string().optional(),
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

  The companion `.baerly/schema.lock.json` carries an optional
  declarative form for tooling that wants a JSON view of the active
  schemas; an empty `{ "tables": {} }` is fine when you supply the
  schemas in code.

- **Auth setup (Cloudflare)** — `src/server/index.ts` selects a
  `Verifier` per request:

  1. `cloudflareAccess()` when **both** `CF_ACCESS_TEAM_DOMAIN` and
     `CF_ACCESS_AUDIENCE_TAG` are set on the bound vars. Wire CF
     Access in front of the Worker route so it injects the
     `Cf-Access-Jwt-Assertion` header.
  2. `sharedSecret()` when `SHARED_SECRET` is set
     (`wrangler secret put SHARED_SECRET`). Used for `wrangler dev`
     and pre-Access environments.
  3. Otherwise the Worker throws on the first request;
     `baerly doctor --target=cloudflare` flags the case before
     deploy.

  **Production recipe (5 minutes):**

  1. In the Cloudflare dashboard, create a CF Access application
     in front of your Worker route.
  2. Note the **team domain** (e.g. `acme.cloudflareaccess.com`).
  3. Note the **audience tag** for the application (looks like
     `1c5e0...c20`).
  4. Edit `wrangler.jsonc:vars` to add
     `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUDIENCE_TAG`. Commit.
  5. Deploy: `baerly deploy --target=cloudflare`. Verify with
     `baerly doctor --target=cloudflare`.

  Read the JSDoc on `sharedSecret` / `bearerJwt` / `cloudflareAccess`
  / `awsIamSigV4` / `allowlistIp` (re-exported from
  `baerly-storage/auth`) for the full constraint list.

- **Secrets vs. vars** — `wrangler.jsonc:vars` carries non-secret
  config (`APP`, `TENANT`, `LOG_LEVEL`, `LOG_SAMPLE`). The verifier's
  secrets (`SHARED_SECRET` and the optional `CF_ACCESS_*` for
  Cloudflare Access) live in `.dev.vars` for local `wrangler dev`
  and behind `wrangler secret put` in production. `.dev.vars.example`
  is the source of truth for which secrets the Worker reads — keep
  it in sync with the verifier choices in `src/server/index.ts`.

- **Maintenance loop (Cloudflare)** — `wrangler.jsonc`
  declares `"crons": ["* * * * *"]` (every minute). The Worker's
  `scheduled` handler reads `env.CURRENT_JSON_KEY` and `env.CF_TIER`
  and calls `runScheduledMaintenance()` via `ctx.waitUntil()`. Both
  are optional vars — when `CURRENT_JSON_KEY` is unset the scheduled
  handler is a no-op (multi-tenant deployments wire their own).

  On **`CF_TIER=free`** (default), the handler alternates: even
  minutes run `compact()`, odd minutes run `runGc()`. Each phase is
  sized to fit the 50-subrequest free-tier cap. On **`CF_TIER=paid`**,
  both phases run every minute (10k-subrequest cap).

  Multi-tenant deployments override the `scheduled` hook on
  `baerlyWorker({ ... })` to enumerate their own `current.json` keys
  — see the JSDoc on `WorkerScheduledHandler` in
  `baerly-storage/cloudflare`.

  Maintenance emits one canonical info line per run on stdout
  (Workers Logs ingestion). Filter your log stream on
  `"unit_of_work": "maintenance"` and read these fields:

  - `compact_written` — log entries folded into the new snapshot
    this tick (`0` when the live tail was below
    `minEntriesToCompact`). Appears on paid-tier ticks only — free
    tier alternates `compact()` and `runGc()` per minute and emits
    their per-phase canonical lines (`unit_of_work: "compactor"` /
    `"gc"`) instead.
  - `gc_swept` — keys deleted this tick (`0` when no candidates
    aged out). Same paid-tier-only caveat as `compact_written`.
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

- Widening branded types from `baerly-storage` (`Ref`,
  `ManifestKey`). The types prevent confusion bugs.
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

**Estimate your current rate:** `baerly doctor --usage --target=...`
(upcoming) lists recent log entries per collection and computes
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
- `vite.config.ts` — Vite + `@cloudflare/vite-plugin`.
- `package.json` — root scripts + dependencies.
