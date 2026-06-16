---
title: AGENTS.md — agent guidance for minimal-cloudflare
audience: agent
summary: How to develop and deploy minimal-cloudflare, a baerly app.
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

`minimal-cloudflare` is a baerly app scaffolded with `create-baerly-storage`.
The Worker-side server lives in `src/server/`; the optional client
lives in `src/web/`. Configuration lives in `baerly.config.ts`.

Single package, single `vite` process: `@cloudflare/vite-plugin` runs
the Worker inside `workerd` alongside the SPA dev server, and
`wrangler.jsonc:assets` ships the built `dist/client/` bundle next to
the Worker on deploy. Same origin in dev and prod, one deploy.

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

| Command          | What it does                                                                                                                                                                                                                                               | Runtime             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `pnpm install`   | One-time bootstrap — the scaffold ships without `node_modules/`, so `pnpm verify` / `pnpm dev` fail with `Cannot find package '…'` until this runs once                                                                                                    | seconds to a minute |
| `pnpm verify`    | `pnpm run typecheck && pnpm run test` — the green-light gate; what an agent should run as the smoke check before claiming the change works                                                                                                                 | seconds             |
| `pnpm typecheck` | TS typecheck across the worker + web project references (`tsc -b --noEmit`)                                                                                                                                                                                | seconds             |
| `pnpm test`      | `vitest run --passWithNoTests` — standalone `vitest.config.ts` (Node env, ignores `vite.config.ts` so the Cloudflare plugin doesn't load). The minimal template ships no SPA tests by default; `--passWithNoTests` keeps the gate green until you add one. | seconds             |
| `pnpm dev`       | Run `vite` — the Cloudflare plugin runs the Worker inside `workerd` next to the SPA dev server; same origin on :5173                                                                                                                                       | seconds to start    |
| `pnpm build`     | `tsc -b && vite build` — emits `dist/client/` for the Workers Assets binding                                                                                                                                                                               | seconds             |
| `pnpm deploy`    | `wrangler deploy` — ships Worker + assets in one shipment (auto-creates R2 on first run via `--x-provision`)                                                                                                                                               | seconds             |

**`pnpm verify` exercises typecheck + tests only.** The dev-auth
middleware, the SPA bundle, and any custom `/api/*` route are NOT
under test — verify will exit green even when the dev plugin returns
401 on every browser request or the SPA throws on mount. For changes
that touch `vite.config.ts`, `src/server/index.ts`, or SPA logic, run
`pnpm dev` and exercise the change in a browser (or `curl
http://localhost:5173/<path>`) before declaring the task complete.

## Where the code is

| Path                   | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/index.ts`  | Worker entry — `baerlyWorker((env) => ({ verifier }))`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `wrangler.jsonc`       | Cloudflare Worker manifest — name, R2 binding, assets, vars                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `index.html`           | SPA shell — Vite's entry point at the project root; references `/src/web/main.ts`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/web/main.ts`      | SPA client entry — a ~17-line hello-world: reads `client.collection("notes").all()` to render a `${n} note(s)` count and an `[Add note]` button that inserts a timestamped row and re-fetches. Demonstrates both read and write paths on first load. Extend or replace; the `config`-bound `client.collection("notes")` is the typed surface (the generic on `.collection()` is the collection **name**, not the row type). Workers Assets serves the built bundle from `dist/client/`. |
| `vite.config.ts`       | Vite + `@cloudflare/vite-plugin` — runs the Worker inside `workerd` in dev                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tsconfig.json`        | Root project-references stub                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tsconfig.app.json`    | Client TS project (`src/web/`, DOM lib)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tsconfig.worker.json` | Worker TS project (`src/server/`, workerd lib)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `baerly.config.ts`     | App config — `app`, `tenant`, `target`, `domain`, `collections` (schemas live here).                                                                                                                                                                                                                                                                                                                                                                                                    |
| `types.ts`             | Shared types between the Worker (`src/server/`) and the SPA (`src/web/`). Both project tsconfigs include this file; put any row type or interface that crosses the boundary here.                                                                                                                                                                                                                                                                                                       |

> **`baerly.config.ts` and `types.ts` are dual-included** by both
> `tsconfig.app.json` and `tsconfig.worker.json`. Both can only
> import from `baerly-storage`, `zod`, and other dual-included root
> files. Paths under `src/server/` are worker-only; importing them
> here triggers `TS6307: File … is not listed within the file list
of project … tsconfig.app.json`. Cross-boundary interfaces belong
> in `types.ts`; re-export from a server-only file if downstream code
> wants a local name.

## When editing X, read Y

- **Typed collections** — two ways to get a typed row, in DX order.
  The generic on `client.collection<N>(name)` is the collection
  **name** (constrained to `CollectionNames<typeof config>`), not the
  row type — so don't pass a row type to it.
  1. **Bind the config.** This template's `src/web/main.ts` already
     passes `config` to `createBaerlyClient({ baseUrl, config })` (and
     `src/notes.test.ts` passes `config` to `Db.create`), so
     `client.collection("notes")` returns `ClientCollection<Row>` with
     `Row` derived from the schema declared in `baerly.config.ts`. No
     generic needed. When you need to name that row type elsewhere, use
     `RowOf<typeof config, "notes">` (re-exported from
     `@gusto/baerly-storage`) — not a generic on `.collection()`.
  2. **Cast the handle (undeclared collection).** This template's
     `client` is bound to `config`, so its names narrow to the
     declared collections. To reach a collection that isn't in
     `config`, build an unbound client
     (`createBaerlyClient({ baseUrl })` with no `config`) — its names
     widen to `string` and its row defaults to `DocumentData`. Cast at
     the construction site for a narrower shape that still satisfies
     the kernel's `DocumentData` constraint
     (`{ [k: string]: DocumentValue }`):
     ```ts
     import {
       createBaerlyClient,
       type ClientCollection,
       type DocumentData,
     } from "@gusto/baerly-storage/client";
     interface Bookmark extends DocumentData {
       _id: string;
       url: string;
     }
     const raw = createBaerlyClient({ baseUrl: "" });
     const bookmarks = raw.collection("bookmarks") as ClientCollection<Bookmark>;
     await bookmarks.all();
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

- **Predicates** — `db.collection("tickets").where({...}).all()`. Two
  shapes:
  - **Object literal** — equality only (top-level, dotted-path, or
    nested literal sub-predicate). Multi-field is implicit AND.
  - **Callback DSL** — `q => q.eq(...).gt(...).gte(...).lt(...).lte(...).in(...)`
    for the operator vocabulary. The methods on `PredicateBuilder<T>`
    ARE the supported surface — invoking `q.or` / `q.regex` /
    `q.ne` / `q.exists` is a TS compile error, not a runtime
    `InvalidConfig`. Chained `.where(...).where(...)` AND-merges
    across calls and across shapes.

  ```ts
  // Top-level equality (Db inside the Worker, client in the SPA)
  await db.collection("tickets").where({ status: "open" }).all();

  // Dotted-path on a nested field
  await db.collection("tickets").where({ "assignee.team": "platform" }).all();

  // Operator on a single field — set membership (callback form)
  await db
    .collection("tickets")
    .where((q) => q.in("status", ["open", "pending"]))
    .all();

  // Range — also callback form
  await db
    .collection("tickets")
    .where((q) => q.gte("priority", 5).lt("priority", 10))
    .all();

  // AND-merge across two .where() calls (mix shapes freely)
  await db
    .collection("tickets")
    .where({ status: "open" })
    .where((q) => q.gte("priority", 5))
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
  HTTP clients see a 400 with the same envelope. Validation runs
  on the post-image so `update` and `replace` see the full doc, not
  just the patch.

- **HTTP wire format (calling `/v1/*` directly)** — the JS SDK
  (`db.collection(name).insert(...)`) is the canonical path; reach for `curl`
  only when debugging the wire. Mutation bodies are wrapped:

  | Route                          | Body              | Response         |
  | ------------------------------ | ----------------- | ---------------- |
  | `POST   /v1/c/:collection`     | `{"doc":{...}}`   | `201 {_id}`      |
  | `PATCH  /v1/c/:collection/:id` | `{"patch":{...}}` | `200 {modified}` |
  | `PUT    /v1/c/:collection/:id` | `{"doc":{...}}`   | `200 {modified}` |
  | `DELETE /v1/c/:collection/:id` | —                 | `204`            |

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
  a `verifier:` on the factory overrides it. `baerly doctor
--target=cloudflare` warns on `"none"` for deploy targets. See
  "Going to production" below for the two production-fit recipes.

### Going to production

The scaffold ships `auth: "none"` so the day-1 happy path works with
zero env vars. Two patterns flip to a production-fit posture; pick the
one matching your gate.

<!-- pattern-a:start -->

**Pattern A — env-aware verifier (recommended for CF Access).** Same
artifact ships to dev and prod; the factory `verifier:` override
engages only when prod env vars are present. `baerlyWorker` resolves
the factory `verifier:` first, so the override silently supersedes
`config.auth: "none"` in prod.

```ts
// baerly.config.ts — unchanged
import { defineConfig } from "@gusto/baerly-storage/config";

export default defineConfig({
  app: "minimal-cloudflare",
  tenant: "minimal-demo",
  target: "cloudflare",
  auth: "none", // dev default
  collections: { notes: {} },
});
```

```ts
// src/server/index.ts
import { baerlyWorker, type BaerlyEnv } from "@gusto/baerly-storage/cloudflare";
import { cloudflareAccess } from "@gusto/baerly-storage/auth";
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
        tenantPrefix: config.tenant,
      }),
    }),
}));
```

Set both `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUDIENCE_TAG` in
`wrangler.jsonc:vars` for prod (they're public identifiers, not
secrets). Dev `wrangler dev` sees them as `undefined`, the spread
short-circuits, and `config.auth: "none"` runs. Prod sees them set
and `cloudflareAccess` engages. Every verified token is pinned to
`config.tenant`; pass `tenantClaim` instead only when your Access JWT
actually carries a tenant claim.

<!-- pattern-a:end -->
<!-- pattern-b:start -->

**Pattern B — `auth: "shared-secret"`.** Single-tenant
server-to-server callers (CI and internal services). No factory
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
import { baerlyDevAuth, loadDevVars } from "@gusto/baerly-storage/dev/vite";

const { SHARED_SECRET } = loadDevVars(".dev.vars", "SHARED_SECRET");

export default defineConfig({
  plugins: [
    cloudflare(),
    ...(SHARED_SECRET !== undefined ? [baerlyDevAuth({ secret: SHARED_SECRET })] : []),
  ],
});
```

`baerly doctor --target=cloudflare` FAILs (`auth.shared-secret-missing`)
if `auth: "shared-secret"` is set without `SHARED_SECRET` reachable
from the runtime env.

<!-- pattern-b:end -->

- **Extending the Worker with a custom route** — `baerlyWorker(...)`
  owns `/v1/*`, including `/v1/healthz`. For server-side endpoints the SPA
  client can't run on its own (the canonical case: an endpoint that
  fans a write across several documents server-side, since
  `createBaerlyClient` is reads + by-id mutations only), wrap the
  worker `fetch`:

  ```ts
  // src/server/index.ts
  import { baerlyWorker, r2BindingStorage, type BaerlyEnv } from "@gusto/baerly-storage/cloudflare";
  import { Db } from "@gusto/baerly-storage";
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
        // …db.collection(...).insert(doc), db.collection(...).get(id), etc.
        return new Response(null, { status: 204 });
      }
      // Fall through to the baerly cascade for /v1/*, including /v1/healthz.
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
  config (`APP`, `TENANT`, and CF Access identifiers
  `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUDIENCE_TAG` — both are
  public identifiers, not secrets). Secrets like
  `SHARED_SECRET` (only required if you flip `auth` to
  `"shared-secret"`) live in `.dev.vars` for local `wrangler dev`
  and behind `wrangler secret put` in production. `baerly doctor
--target=cloudflare` reads `CF_ACCESS_*` from `wrangler.jsonc:vars`
  only, so setting them via `wrangler secret put` would silently
  defeat the doctor check.

- **Deploy** — `baerly deploy --target=cloudflare` runs
  `wrangler deploy --x-provision --x-auto-create` (Wrangler 4.10+)
  to auto-create the declared R2 buckets and ship the Worker. When
  the experimental flag is unavailable it falls back to
  `wrangler r2 bucket create` + `wrangler deploy`. The fallback is
  also what `baerly doctor --target=cloudflare --fix` exercises.

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
  side-projection (D1/KV/search index) populated incrementally from
  the `/v1/since?collection=<name>&cursor=<opaque>` log feed or from
  a write hook — never re-scan per
  request.

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
envelope and the BAERLY*MAINTENANCE*\* operator env vars (you almost never need them).

Operator opt-in: call runScheduledMaintenance from @gusto/baerly-storage/maintenance on
your own schedule. Not required for steady-state operation.

<!-- pattern-d:end -->

## When to graduate

baerly is designed for the small-to-medium operating point. The cost
model puts the soft ceiling at:

- **~30 writes / minute / collection**
- **~10 GB / tenant**
- **~100 collections / tenant**

Past those, S3 list-prefix latency, snapshot fold cost, and per-class
op pricing start to dominate; you're better off on a real database.
Pick your graduation target:

- **Cloudflare Workers + lock-in OK:** [D1](https://developers.cloudflare.com/d1/) — cheaper per-write at M-size.
- **Off-Workers or portability matters:** managed Postgres.
- **Single-instance Node:** SQLite via Litestream.

Either way, the export below is mechanical because log entries are
Debezium-style CDC change events — graduation is a Baerly win,
not a churn event.

**Estimate your current rate:** for Node/self-hosted buckets,
`baerly admin usage --target=node --bucket=<bucket-uri> --app=<app>
--tenant=<tenant>` lists recent log entries per collection and computes
writes/min. On Cloudflare, use canonical logs for trend history and
`baerly cost --bucket=<bucket-uri> --collection=<collection>` for the
current operation-cost projection until the usage scanner is wired to
R2 bindings.

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
- `src/server/index.ts` — Worker entry.
- `wrangler.jsonc` — Cloudflare Worker manifest (R2 binding, `assets:`, vars).
- `vite.config.ts` — Vite + `@cloudflare/vite-plugin`.
- `package.json` — root scripts + dependencies.
