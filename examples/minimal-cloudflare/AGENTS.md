---
title: AGENTS.md — agent guidance for minimal-cloudflare
audience: agent
summary: How to develop and deploy minimal-cloudflare, a baerly-storage app.
tags: [agent-entry, baerly-storage]
---

# AGENTS.md

<!-- stop:start -->

## STOP — read this before writing any storage code

Your training data is dense with Postgres + Prisma/Drizzle, Mongo, and Firebase patterns. **None of them apply here.** This is a baerly-storage app — a small, LLM-legible document database with a narrow API on top of S3-compatible storage. Before writing or modifying storage code, read:

- **`node_modules/@gusto/baerly-storage/dist/API.md`** — hand-authored public-API quickref. Read first. Lists every method, every error code, every example. If a pattern you want to use isn't here, it doesn't exist in baerly-storage.
- **`node_modules/@gusto/baerly-storage/dist/RECIPES.md`** — common mistakes keyed by the exact error string, plus recipes (storage credentials on Node, wrapping the client `fetch`, a gated adapter, scheduled maintenance).
- **`node_modules/@gusto/baerly-storage/dist/*.d.ts`** — authoritative type signatures. `Db`, `Collection<T>`, `Query<T>`, and `Predicate<T>` are the whole API surface.

Common anti-patterns that compile but are wrong:

- `db.collection(name).insertOne(...)` / `.find({...})` (Mongo) — use `db.collection(name).insert(row)` and `.where({ ... }).all()`.
- `z.string().nullable()` in a schema — `DocumentValue` excludes `null`. Use `.optional()`; `null` in an update patch is the RFC 7386 deletion sentinel, not a storable value.
- Raw SQL strings, `WHERE` clauses, hand-built query AST — the only query surface is `db.collection(...).where({ field: value }).all()` or `.where(q => q.gte("count", 1))`. See the Predicates section of API.md.
- `.useIndex("name")` / `.hint(...)` — no such methods. Declared indexes do not change how a read runs. See the `defineConfig` section of API.md.

<!-- stop:end -->

## What this is

`minimal-cloudflare` is a baerly-storage app scaffolded with `create-baerly-storage`. The Worker-side server lives in `src/server/`; the optional client lives in `src/web/`. Configuration lives in `baerly.config.ts`.

Single package, single `vite` process: `@cloudflare/vite-plugin` runs the Worker inside `workerd` alongside the SPA dev server, and `wrangler.jsonc:assets` ships the built `dist/client/` bundle next to the Worker on deploy. Same origin in dev and prod, one deploy.

Public API docs: the JSDoc on `baerly-storage`'s `Db` and `Collection` is the canonical reference; read it via your editor's TS LS, the published types, or `node_modules/@gusto/baerly-storage/dist/API.md`.

## Toolchain

- **Package manager:** pnpm. The emitted repo pins `packageManager: pnpm@12.21.0`.
- **Test runner:** vitest.
- **Type checker:** TypeScript 7, as pinned in `package.json`.
- **`erasableSyntaxOnly`** is enabled in every `tsconfig*.json` so the code stays compatible with type-stripping runtimes (Node's built-in type stripping, esbuild's strip path). The flag bans TS constructs that can't be type-erased: write `class { x: T; constructor(x: T) { this.x = x } }` explicitly instead of parameter-property shorthand (`constructor(private x: T) {}` fails with TS1294). The same goes for `enum`, namespaces with non-type bindings, and `private` / `protected` / `public` accessibility modifiers on constructor parameters.

## Verification

| Command | What it does | Runtime |
| --- | --- | --- |
| `pnpm install` | One-time bootstrap — the scaffold ships without `node_modules/`, so `pnpm verify` / `pnpm dev` fail with `Cannot find package '…'` until this runs once | seconds to a minute |
| `pnpm verify` | `pnpm run typecheck && pnpm run test` — the green-light gate; what an agent should run as the smoke check before claiming the change works | seconds |
| `pnpm typecheck` | TS typecheck across the worker + web project references (`tsc -b --noEmit`) | seconds |
| `pnpm test` | `vitest run` — standalone `vitest.config.ts` (Node env, ignores `vite.config.ts` so the Cloudflare plugin doesn't load). The template ships `src/notes.test.ts` by default. | seconds |
| `pnpm dev` | Run `vite` — the Cloudflare plugin runs the Worker inside `workerd` next to the SPA dev server; same origin on :5173 | seconds to start |
| `pnpm build` | `tsc -b && vite build` — emits `dist/client/` for the Workers Assets binding | seconds |
| `pnpm deploy` | `wrangler deploy` — ships Worker + assets in one shipment (auto-creates R2 on first run via `--x-provision`) | seconds |

**`pnpm verify` exercises typecheck + tests only.** The dev-auth middleware, the SPA bundle, and any custom `/api/*` route are NOT under test — verify will exit green even when the dev plugin returns 401 on every browser request or the SPA throws on mount. For changes that touch `vite.config.ts`, `src/server/index.ts`, or SPA logic, run `pnpm dev` and exercise the change in a browser (or `curl http://localhost:5173/<path>`) before declaring the task complete.

## Where the code is

| Path | What it is |
| --- | --- |
| `src/server/index.ts` | Worker entry — `baerlyWorker((env) => ({ verifier }))` |
| `wrangler.jsonc` | Cloudflare Worker manifest — name, R2 binding, assets, vars |
| `index.html` | SPA shell — Vite's entry point at the project root; references `/src/web/main.ts`. |
| `src/web/main.ts` | SPA client entry — a ~17-line hello-world: reads `client.collection("notes").all()` to render a `${n} note(s)` count and an `[Add note]` button that inserts a timestamped row and re-fetches. Demonstrates both read and write paths on first load. Extend or replace; the `config`-bound `client.collection("notes")` is the typed surface (the generic on `.collection()` is the collection **name**, not the row type). Workers Assets serves the built bundle from `dist/client/`. |
| `vite.config.ts` | Vite + `@cloudflare/vite-plugin` — runs the Worker inside `workerd` in dev |
| `tsconfig.json` | Root project-references stub |
| `tsconfig.app.json` | Client TS project (`src/web/`, DOM lib) |
| `tsconfig.worker.json` | Worker TS project (`src/server/`, workerd lib) |
| `baerly.config.ts` | App config — `app`, `tenant`, `target`, `domain`, `collections` (schemas live here). |
| `types.ts` | Shared types between the Worker (`src/server/`) and the SPA (`src/web/`). Both project tsconfigs include this file; put any row type or interface that crosses the boundary here. |

> **`baerly.config.ts` and `types.ts` are dual-included** by both `tsconfig.app.json` and `tsconfig.worker.json`. Both can only import from `baerly-storage`, `zod`, and other dual-included root files. Paths under `src/server/` are worker-only; importing them here triggers a `TS6307` "not listed within the file list of project … tsconfig.app.json" error. Cross-boundary interfaces belong in `types.ts`; re-export from a server-only file if downstream code wants a local name.

## When editing X, read Y

<!-- library:start -->

- **Library reference** — the shared API guidance is installed with the package, in `node_modules/@gusto/baerly-storage/dist/`. Read the matching section before editing storage code:
  - **Typed rows** (binding `config`, `RowOf`, casting an undeclared collection): `API.md#documentdata--row-shape-constraint`. A hand-written row type failing `DocumentData`: `RECIPES.md#type-bookmark-does-not-satisfy-the-constraint-documentdata-ts2344`.
  - **Writing tests**: `API.md`, section `Db.create`. `new MemoryStorage()` is a fresh bucket per test; share one instance across `Db.create` calls for multi-writer tests. `src/notes.test.ts` is the working example.
  - **Predicates** (object literal vs callback DSL, operators, by-`_id` verbs): `API.md#predicates`. Set membership is `q.in`, never an array in the object form: `RECIPES.md#baerlyerror-codeinvalidconfig--predicate-value-at--is-an-array`.
  - **Indexes**: don't declare them; a read always folds the whole collection. `API.md`, section `defineConfig`.
  - **Schemas** (StandardSchema validators, `SchemaError`): `API.md`, section `defineConfig`.
  - **HTTP wire format** (calling `/v1/*` directly): `API.md#http-wire-format`.
  - **Verifier presets** (`sharedSecret`, `bearerJwt`, `cloudflareAccess`, `tenantPrefix`): `API.md#verifier-presets`. Refreshing a client token on 401, logging, tracing: `RECIPES.md#recipe--wrapping-the-client-fetch`. Serving `/v1/*` behind your own gate: `RECIPES.md#recipe--authoring-a-gated-adapter`.
  - **Errors by message** (`RECIPES.md`, one entry per error string) and the shared anti-patterns: `RECIPES.md#anti-patterns-compile-clean-but-wrong`.

<!-- library:end -->

- **This template** — `src/web/main.ts` passes `config` to `createBaerlyClient` and `src/notes.test.ts` passes it to `Db.create`, so rows are already typed: no generic. For a hot filtered read, maintain a side-projection (see Anti-patterns).

- **Auth** — your scaffold ships `auth: "none"` in `baerly.config.ts`: every request resolves to `tenant: "minimal-demo"` and `Authorization` is ignored. The adapter reads `config.auth` to pick its verifier; a `verifier:` on the factory overrides it. `baerly doctor --target=cloudflare` warns on `"none"` for deploy targets. See "Going to production" below for the two production-fit recipes.

### Going to production

The scaffold ships `auth: "none"` so the day-1 happy path works with zero env vars. Two patterns flip to a production-fit posture; pick the one matching your gate.

<!-- pattern-a:start -->

**Pattern A — env-aware verifier (recommended for CF Access).** Same artifact ships to dev and prod; the factory `verifier:` override engages only when prod env vars are present. `baerlyWorker` resolves the factory `verifier:` first, so the override silently supersedes `config.auth: "none"` in prod.

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

Set both `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUDIENCE_TAG` in `wrangler.jsonc:vars` for prod (they're public identifiers, not secrets). Dev `wrangler dev` sees them as `undefined`, the spread short-circuits, and `config.auth: "none"` runs. Prod sees them set and `cloudflareAccess` engages. Every verified token is pinned to `config.tenant`; pass `tenantClaim` instead only when your Access JWT actually carries a tenant claim.

<!-- pattern-a:end -->
<!-- pattern-b:start -->

**Pattern B — `auth: "shared-secret"`.** Single-tenant server-to-server callers (CI and internal services). No factory code changes; only `baerly.config.ts` flips:

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

The Vite dev plugin needs the bearer injected for browser calls — re-enable `baerlyDevAuth` in `vite.config.ts`:

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

`baerly doctor --target=cloudflare` FAILs (`auth.shared-secret-missing`) if `auth: "shared-secret"` is set without `SHARED_SECRET` reachable from the runtime env.

<!-- pattern-b:end -->

- **Extending the Worker with a custom route** — `baerlyWorker(...)` owns `/v1/*`, including `/v1/healthz`. For server-side endpoints the SPA client can't run on its own (the canonical case: an endpoint that fans a write across several documents server-side, since `createBaerlyClient` is reads + by-id mutations only), wrap the worker `fetch`:

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

  Under `auth: "none"` the dev plugin no longer injects an `Authorization` header — `/api/*` and `/v1/*` reach the Worker unauthenticated and the adapter pins both to `config.tenant`. When you flip to `auth: "shared-secret"` (or a custom verifier) per the "Going to production" recipe, your `/api/*` handler must read and verify `Authorization` explicitly; `baerlyWorker` only does the header check for routes it owns (`/v1/*`).

- **Secrets vs. vars** — `wrangler.jsonc:vars` carries non-secret config (`APP`, `TENANT`, and CF Access identifiers `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUDIENCE_TAG` — both are public identifiers, not secrets). Secrets like `SHARED_SECRET` (only required if you flip `auth` to `"shared-secret"`) live in `.dev.vars` for local `wrangler dev` and behind `wrangler secret put` in production. `baerly doctor --target=cloudflare` reads `CF_ACCESS_*` from `wrangler.jsonc:vars` only, so setting them via `wrangler secret put` would silently defeat the doctor check.

- **Deploy** — `baerly deploy --target=cloudflare` runs `wrangler deploy --x-provision --x-auto-create` (Wrangler 4.10+) to auto-create the declared R2 buckets and ship the Worker. When the experimental flag is unavailable it falls back to `wrangler r2 bucket create` + `wrangler deploy`. The fallback is also what `baerly doctor --target=cloudflare --fix` exercises.

## Anti-patterns

- The shared anti-patterns (branded types, the verifier's tenant, secrets in the SPA bundle) are in `RECIPES.md#anti-patterns-compile-clean-but-wrong`.
- Calling `db.collection(...).all()` (or any unbounded read) inside a per-request handler. The call scans the entire collection on every request — fine for a fixture-sized table, catastrophic at any real size, and `pnpm verify` doesn't surface the cost. A predicate (`db.collection("notes").where({ ... }).all()`) trims the response but still folds the whole collection, so instead maintain a side-projection (D1/KV/search index) populated incrementally from the `/v1/since?collection=<name>&cursor=<opaque>` log feed or from a write hook — never re-scan per request.

## Maintenance

<!-- pattern-d:start -->

Maintenance is automatic and write-triggered: nothing to install or schedule, identically on every host, and reads never run it. A scheduled `runScheduledMaintenance` pass is an optional extra for a collection served mostly read-only. The behavior, the call, its per-tier limits and the Workers Free / Paid differences are in `node_modules/@gusto/baerly-storage/dist/RECIPES.md#recipe--scheduled-maintenance`.

<!-- pattern-d:end -->

## When to graduate

baerly-storage is designed for the small-to-medium operating point. The soft ceiling has three lines, none enforced by the protocol: writes per collection (a throughput estimate), collections per tenant (a soft fan-out guideline), and the R2 free-tier storage line (a cost signal). The figures live in one place: docs/spec/scale-ceilings.md § "The published envelope" in the baerly-storage repo.

At the M-size operating point, the projected cost is ~$12/mo on Cloudflare, including Workers Paid, and ~$19/mo on Node, excluding Node hosting. Past those, per-class op pricing and fan-out scan cost start to dominate; you've outgrown the workload envelope — move to a database service (D1 / Postgres) suited to higher scale. Pick your graduation target:

- **Cloudflare Workers + lock-in OK:** [D1](https://developers.cloudflare.com/d1/) — cheaper per-write at M-size.
- **Off-Workers or portability matters:** managed Postgres.
- **Single-instance Node:** SQLite via Litestream.

Either way, the export below is mechanical because log entries are Debezium-style CDC change events — graduation is a baerly-storage win, not a churn event.

**Estimate your current rate:** for Node/self-hosted buckets, `baerly admin usage --target=node --bucket=<bucket-uri> --app=<app> --tenant=<tenant>` lists recent log entries per collection and computes writes/min. On Cloudflare, use canonical logs for trend history and `baerly cost --bucket=<bucket-uri> --collection=<collection>` for the current operation-cost projection until the usage scanner is wired to R2 bindings.

**Export when ready:** `baerly export --target=sqlite|postgres|d1 --bucket=<...> --app=<...> --tenant=<...> --collection=<...>` writes a canonical SQL dump (and a `<output>.plan.json` sidecar carrying the inferred `ExportPlan`) that you load into your graduation target. The export is point-in-time and honours the active schema. Flags: `--where=<json-predicate>`, `--where-comment`, `--output`, `--no-sidecar`, `--json`. Exit codes: 0 success, 1 InvalidConfig, 2 Storage/Network, 3 Protocol invariant.

## Pointers

- `baerly.config.ts` — app config.
- `src/server/index.ts` — Worker entry.
- `wrangler.jsonc` — Cloudflare Worker manifest (R2 binding, `assets:`, vars).
- `vite.config.ts` — Vite + `@cloudflare/vite-plugin`.
- `package.json` — root scripts + dependencies.
