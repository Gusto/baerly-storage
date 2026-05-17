---
title: AGENTS.md — agent guidance for helpdesk-cloudflare
audience: agent
summary: How to develop and deploy helpdesk-cloudflare, a baerly app.
tags: [agent-entry, baerly]
---

# AGENTS.md

Guidance for AI coding agents working in this repo. This is a
baerly app — a vendorless document database that runs over any
S3-compatible storage API.

## What this is

`helpdesk-cloudflare` is a baerly app scaffolded with `create-baerly`.
The Worker-side server lives in `apps/server/`; the optional client
lives in `apps/web/`. Configuration lives in `baerly.config.ts`.

This starter is the ticket-CRUD variant — a Cloudflare Worker wired to
R2 plus a working React+Vite frontend in `apps/web/` (served by the
Worker via Workers Assets) with the `Ticket` schema declared in
`types.ts`. The bare server-only version is `pnpm create baerly
<app> --target=cloudflare`; this one is
`--target=cloudflare --starter=helpdesk`.

Public API docs: https://docs.baerly.dev/ (the JSDoc on
`@baerly/server`'s `Db` and `Table` is the canonical reference;
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

| Command            | What it does                                                          | Runtime          |
| ------------------ | --------------------------------------------------------------------- | ---------------- |
| `pnpm typecheck` | TS typecheck across both apps                                         | seconds          |
| `pnpm dev`       | Run the server locally — `wrangler dev` against the local R2 emulator | seconds to start |
| `pnpm test`        | Run all tests across both apps                                        | seconds          |

## Where the code is

| Path                         | What it is                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `apps/server/src/worker.ts`  | Server entry — `/v1/*` routing + SPA fallback via `env.ASSETS`                       |
| `apps/server/wrangler.jsonc` | Cloudflare Worker manifest — name, R2 binding, Assets binding, vars, triggers, limits, observability |
| `apps/web/`                  | React+Vite frontend. Served by the Worker via Workers Assets in production.          |
| `baerly.config.ts`           | App config — `app`, `tenant`, `target`, `domain`                                     |
| `types.ts`                   | Shared `Ticket` interface and `STATUSES` / `PRIORITIES` constants.                   |
| `.baerly/schema.lock.json`   | Declared collection schemas — see "Schemas (live feature)" below.                    |

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
  import { defineConfig } from "@baerly/server";

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
  import { defineConfig } from "@baerly/server";

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

- **Auth setup (Cloudflare)** — `apps/server/src/worker.ts` selects a
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
  4. Edit `apps/server/wrangler.jsonc:vars` to add
     `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUDIENCE_TAG`. Commit.
  5. Deploy: `baerly deploy --target=cloudflare`. Verify with
     `baerly doctor --target=cloudflare`.

  Read the JSDoc on `sharedSecret` / `bearerJwt` / `cloudflareAccess`
  / `awsIamSigV4` / `allowlistIp` (re-exported from
  `@baerly/server/auth`) for the full constraint list.

- **Maintenance loop (Cloudflare)** — `apps/server/wrangler.jsonc`
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
  `@baerly/adapter-cloudflare`.

  Maintenance emits one canonical info line per run on stdout
  (Workers Logs ingestion). Filter your log stream on
  `"unit_of_work": "maintenance"` and read these fields:

  - `compact_written` — log entries folded into the new snapshot
    this tick (`0` when compact was skipped or the live tail was
    below `minEntriesToCompact`).
  - `gc_swept` — keys deleted this tick (`0` when GC was skipped
    or no candidates aged out).
  - `compact_skipped` / `gc_skipped` — `true` when the cron
    alternated this phase away (`CF_TIER=free` even/odd-minute
    pattern).
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

- Widening branded types from `@baerly/protocol` (`Ref`,
  `ManifestKey`). The types prevent confusion bugs.
- Reaching into `node_modules/@baerly/protocol/src/` directly —
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
- `apps/server/src/worker.ts` — server entry.
- `apps/server/wrangler.jsonc` — Cloudflare Worker manifest.
- `package.json` — root scripts + pnpm workspace.
