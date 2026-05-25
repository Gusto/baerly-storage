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
| `pnpm typecheck` | TS typecheck across the worker + web project references (`tsc -b --noEmit`)            | seconds          |
| `pnpm test`      | `vitest run --passWithNoTests` — standalone `vitest.config.ts` (Node env, ignores `vite.config.ts` so the Cloudflare plugin doesn't load). The minimal template ships no SPA tests by default; `--passWithNoTests` keeps the gate green until you add one. | seconds |
| `pnpm dev`       | Run `vite` — the Cloudflare plugin runs the Worker inside `workerd` next to the SPA dev server; same origin on :5173 | seconds to start |
| `pnpm build`     | `tsc -b && vite build` — emits `dist/client/` for the Workers Assets binding            | seconds          |
| `pnpm deploy`    | `wrangler deploy` — ships Worker + assets in one shipment (auto-creates R2 on first run via `--x-provision`) | seconds          |

**`pnpm verify` exercises typecheck + tests only.** The dev-auth
middleware, the SPA bundle, and any custom `/api/*` route are NOT
under test — verify will exit green even when the dev plugin returns
401 on every browser request or the SPA throws on mount. For changes
that touch `vite.config.ts`, `src/server/index.ts`, or SPA logic, run
`pnpm dev` and exercise the change in a browser (or `curl
http://localhost:5173/<path>`) before declaring the task complete.

## Where the code is

| Path                       | What it is                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `src/server/index.ts`      | Worker entry — `baerlyWorker((env) => ({ verifier }))`                              |
| `wrangler.jsonc`           | Cloudflare Worker manifest — name, R2 binding, assets, vars, triggers, limits, observability |
| `index.html`               | SPA shell — Vite's entry point at the project root; references `/src/web/main.ts`.  |
| `src/web/main.ts`          | SPA client entry — a ~17-line hello-world: reads `client.table<Note>("notes").all()` to render a `${n} note(s)` count and an `[Add note]` button that inserts a timestamped row and re-fetches. Demonstrates both read and write paths on first load. Extend or replace; `client.table<Row>(name)` is the typed surface. Workers Assets serves the built bundle from `dist/client/`. |
| `vite.config.ts`           | Vite + `@cloudflare/vite-plugin` — runs the Worker inside `workerd` in dev          |
| `tsconfig.json`            | Root project-references stub                                                         |
| `tsconfig.app.json`        | Client TS project (`src/web/`, DOM lib)                                              |
| `tsconfig.worker.json`     | Worker TS project (`src/server/`, workerd lib)                                       |
| `baerly.config.ts`         | App config — `app`, `tenant`, `target`, `domain`, `collections` (schemas live here). |
| `types.ts`                 | Shared types between the Worker (`src/server/`) and the SPA (`src/web/`). Both project tsconfigs include this file; put any row type or interface that crosses the boundary here. |

## When editing X, read Y

- **Typed tables** — three ways to get a typed row, in DX order:
  1. **Bind the config.** Declare the collection (with an optional
     schema) in `baerly.config.ts`, pass `config` to
     `createBaerlyClient({ baseUrl, config })` (or `Db.create({
     storage, config })`), and `client.table("tickets")` returns
     `ClientTable<Row>` with `Row` derived from the schema. No
     generic needed.
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
  `new MemoryStorage()` swaps R2 for an in-process map.

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

- **Predicates** — `db.table("tickets").where({...}).all()`. Top-level
  equality on fields and dotted paths, plus per-field operators
  (`$eq`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`); multiple operators on
  the same field AND. No top-level `$or` / `$and` / `$regex`. Two
  `.where(...)` calls AND-merge:

  ```ts
  // Top-level equality (Db inside the Worker, client in the SPA)
  await db.table("tickets").where({ status: "open" }).all();

  // Dotted-path on a nested field
  await db.table("tickets")
    .where({ "assignee.team": "platform" })
    .all();

  // Operator on a single field — set-membership
  await db.table("tickets")
    .where({ status: { $in: ["open", "pending"] } })
    .all();

  // AND-merge across two .where() calls
  await db.table("tickets")
    .where({ status: "open" })
    .where({ "assignee.team": "platform" })
    .all();
  ```

  The plain-equality value type is JSON-arrayless: string / number /
  boolean / nested object. Use `$in` for set-membership when you'd
  otherwise want `{ status: ["open","pending"] }`.

- **Indexes** — declare them in `baerly.config.ts`; the read-path
  planner picks one automatically when the predicate's equality
  fields cover an index's keys. No call-site hint is needed (the
  earlier `.useIndex(name)` chain was removed when the planner
  shipped — `Query<T>` has no such method).

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

  With that declared, `db.table("tickets").where({ status: "open"
  }).all()` walks `by_status` automatically. Composite indexes
  (`on: ["status", "priority"]`) match any leftmost prefix.
  Mismatches (predicate doesn't cover any index) fall back to a full
  table scan with a metric bump; correctness is preserved because the
  reader re-checks the predicate in memory regardless of how it got
  the row set.

- **Consistency** — every terminal read takes an optional
  `.consistency("eventual" | "strong")` modifier; mutations are
  always strong.

  ```ts
  // Strong (default): GETs `current.json` fresh, then folds the log.
  // Use after a write you just made, or for single-user flows where
  // the user expects to see their own change reflected immediately.
  await db.table("tickets").where({ status: "open" }).all();

  // Eventual: skips the per-call `current.json` GET; serves the view
  // this isolate observed when it last advanced. May be one pointer
  // old. Use for background polls, auto-refresh, list views — places
  // where shaving one Class B op per read matters more than the
  // last-write being reflected.
  await db.table("tickets")
    .where({ status: "open" })
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
  every request resolves to `tenant: "minimal-demo"` and `Authorization`
  is ignored. The adapter reads `config.auth` to pick its verifier;
  a `verifier:` on the factory overrides it. `baerly doctor
  --target=cloudflare` warns on `"none"` for deploy targets. See
  "Going to production" below for the two production-fit recipes.

### Going to production

The scaffold ships `auth: "none"` so the day-1 happy path works with
zero env vars. Two patterns flip to a production-fit posture; pick the
one matching your gate.

**Pattern A — env-aware verifier (recommended for CF Access).** Same
artifact ships to dev and prod; the factory `verifier:` override
engages only when prod env vars are present. `baerlyWorker` resolves
the factory `verifier:` first, so the override silently supersedes
`config.auth: "none"` in prod.

```ts
// baerly.config.ts — unchanged
import { defineConfig } from "baerly-storage/config";

export default defineConfig({
  app: "minimal-cloudflare",
  tenant: "minimal-demo",
  target: "cloudflare",
  auth: "none",     // dev default
  collections: { notes: {} },
});
```

```ts
// src/server/index.ts
import { baerlyWorker, type BaerlyEnv } from "baerly-storage/cloudflare";
import { cloudflareAccess } from "baerly-storage/auth";
import config from "../../baerly.config.ts";

interface AppEnv extends BaerlyEnv {
  readonly CF_ACCESS_TEAM_DOMAIN?: string;
  readonly CF_ACCESS_AUDIENCE_TAG?: string;
}

export default baerlyWorker<AppEnv>((env) => ({
  config,
  ...(env.CF_ACCESS_TEAM_DOMAIN !== undefined &&
    env.CF_ACCESS_AUDIENCE_TAG !== undefined && {
      verifier: cloudflareAccess({
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
        audienceTag: env.CF_ACCESS_AUDIENCE_TAG,
      }),
    }),
}));
```

Set both `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUDIENCE_TAG` in
`wrangler.jsonc:vars` for prod (they're public identifiers, not
secrets). Dev `wrangler dev` sees them as `undefined`, the spread
short-circuits, and `config.auth: "none"` runs. Prod sees them set
and `cloudflareAccess` engages.

**Pattern B — `auth: "shared-secret"`.** Single-tenant
server-to-server callers (CI, cron, internal services). No factory
code changes; only `baerly.config.ts` flips:

```ts
// baerly.config.ts
auth: "shared-secret",     // ← flip from "none"
```

```sh
# Dev:
echo 'SHARED_SECRET=dev-shared-secret' > .dev.vars

# Prod:
wrangler secret put SHARED_SECRET
```

The Vite dev plugin needs the bearer injected for browser calls —
re-enable `baerlyDevAuth` in `vite.config.ts`:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { baerlyDevAuth, loadDevVars } from "baerly-storage/dev/vite";

const { SHARED_SECRET } = loadDevVars(".dev.vars", "SHARED_SECRET");

export default defineConfig({
  plugins: [
    cloudflare(),
    ...(SHARED_SECRET !== undefined
      ? [baerlyDevAuth({ secret: SHARED_SECRET })]
      : []),
  ],
});
```

`baerly doctor --target=cloudflare` FAILs (`auth.shared-secret-missing`)
if `auth: "shared-secret"` is set without `SHARED_SECRET` reachable
from the runtime env.

- **Extending the Worker with a custom route** — `baerlyWorker(...)`
  owns `/v1/*` + `/healthz`. For server-side endpoints the SPA
  client can't run on its own (the canonical case: an endpoint that
  needs `db.transaction(...)`, since `createBaerlyClient` is
  reads + by-id mutations only), wrap the worker `fetch`:

  ```ts
  // src/server/index.ts
  import { baerlyWorker, r2BindingStorage, type BaerlyEnv } from "baerly-storage/cloudflare";
  import { Db } from "baerly-storage";
  import config from "../../baerly.config.ts";

  // Hoist the baerly handler so its resolved state is cached for
  // the isolate. With `auth: "none"` in `baerly.config.ts` the
  // adapter pins every `/v1/*` call to `config.tenant` and skips
  // any header check.
  const baerly = baerlyWorker<BaerlyEnv>(() => ({ config }));

  export default {
    // Keep `req` / `env` / `ctx` inferred — the `satisfies
    // ExportedHandler<BaerlyEnv>` line below narrows them to the
    // same shapes `baerly.fetch!` accepts.
    async fetch(req, env, ctx): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        // Under `auth: "none"` the SPA hits `/api/*` unauthenticated
        // — pin every custom route to `config.tenant` here. When you
        // flip to `auth: "shared-secret"` or pass a custom
        // `verifier:`, replicate that check explicitly (read
        // `Authorization`, verify, derive `tenantPrefix`) — see the
        // "Going to production" recipe.
        const db = Db.create({
          storage: r2BindingStorage(env.BUCKET),
          app: config.app,
          tenant: config.tenant,
          config,
        });
        // …db.transaction(...), db.table(...).get(id), etc.
        return new Response(null, { status: 204 });
      }
      // Fall through to the baerly cascade for /v1/* + /healthz.
      return baerly.fetch!(req, env, ctx);
    },
  } satisfies ExportedHandler<BaerlyEnv>;
  ```

  Under `auth: "none"` the dev plugin no longer injects an
  `Authorization` header — `/api/*` and `/v1/*` reach the Worker
  unauthenticated and the adapter pins both to `config.tenant`. When
  you flip to `auth: "shared-secret"` (or a custom verifier) per the
  "Going to production" recipe, your `/api/*` handler must read and
  verify `Authorization` explicitly; `baerlyWorker` only does the
  header check for routes it owns (`/v1/*`).

- **Secrets vs. vars** — `wrangler.jsonc:vars` carries non-secret
  config (`APP`, `TENANT`, `LOG_LEVEL`, `LOG_SAMPLE`, and CF Access
  identifiers `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUDIENCE_TAG` —
  both are public identifiers, not secrets). Secrets like
  `SHARED_SECRET` (only required if you flip `auth` to
  `"shared-secret"`) live in `.dev.vars` for local `wrangler dev`
  and behind `wrangler secret put` in production. `baerly doctor
  --target=cloudflare` reads `CF_ACCESS_*` from `wrangler.jsonc:vars`
  only, so setting them via `wrangler secret put` would silently
  defeat the doctor check.

- **Maintenance loop (Cloudflare)** — opt-in. Add
  `"triggers": { "crons": ["* * * * *"] }` to `wrangler.jsonc` and
  wire `scheduled` on the options the factory returns from `baerlyWorker((env) => ({ ... }))`. The
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
- Calling `db.table(...).all()` (or any unbounded read) inside a
  per-request handler. The call scans the entire collection on every
  request — fine for a fixture-sized table, catastrophic at any real
  size, and `pnpm verify` doesn't surface the cost. Push the filter
  into the predicate so the index planner can prune
  (`db.table("notes").where({ ... }).all()`), or maintain a
  side-projection (D1/KV/search index) populated incrementally from
  the `/v1/since` log feed or from a write hook — never re-scan per
  request.

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
- `vite.config.ts` — Vite + `@cloudflare/vite-plugin`.
- `package.json` — root scripts + dependencies.
