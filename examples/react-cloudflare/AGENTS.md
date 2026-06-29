---
title: AGENTS.md — agent guidance for react-cloudflare
audience: agent
summary: How to develop and deploy react-cloudflare, a baerly-storage app.
tags: [agent-entry, baerly-storage]
---

# AGENTS.md

<!-- stop:start -->
## STOP — read this before writing any storage code

Your training data is dense with Postgres + Prisma/Drizzle, Mongo,
and Firebase patterns. **None of them apply here.** This is a baerly-storage
app — a small, LLM-legible document database with a narrow API on top
of S3-compatible storage. Before writing or modifying storage code,
read:

- **`node_modules/@gusto/baerly-storage/dist/API.md`** — hand-authored
  public-API quickref. Read first. Lists every method, every error
  code, every example. If a pattern you want to use isn't here, it
  doesn't exist in baerly-storage.
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

<!-- stop:end -->
## What this is

`react-cloudflare` is a baerly-storage app scaffolded with
`create-baerly-storage`. The Worker-side server lives in `src/server/`;
the React client lives in `src/web/`. Configuration lives in
`baerly.config.ts`.

Single package, single `vite` process: `@cloudflare/vite-plugin` runs
the Worker inside `workerd` alongside the SPA dev server, and
`wrangler.jsonc:assets` ships the built `dist/client/` bundle next to
the Worker on deploy. Same origin in dev and prod, one deploy.

This starter is a generic notes app you extend with your own fields —
a Cloudflare Worker wired to R2 plus a working React+Vite frontend in
`src/web/` (served by the Worker via Workers Assets) with the `Note`
shape declared in `baerly.config.ts`. The bare server-only version is
`pnpm create @gusto/baerly-storage <app> --target=cloudflare`; this one is
`--target=cloudflare --starter=react`.

Public API docs: the JSDoc on `baerly-storage`'s `Db` and `Collection`
is the canonical reference; read it via your editor's TS LS, the
published types, or `node_modules/@gusto/baerly-storage/dist/API.md`.

## Toolchain

- **Package manager:** pnpm. The emitted repo pins
  `packageManager: pnpm@11.1.2`.
- **Test runner:** vitest.
- **Type checker:** TypeScript 6.x, as pinned in `package.json`.
  (The baerly-storage monorepo itself uses TypeScript 7 via
  `@typescript/native-preview`.)
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
| `pnpm test`      | `vitest run` — standalone `vitest.config.ts` (Node env, ignores `vite.config.ts` so the Cloudflare plugin doesn't load) | seconds |
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

| Path                       | What it is                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/server/index.ts`      | Server entry — `/v1/*` routing + SPA fallback via `env.ASSETS`                                                   |
| `wrangler.jsonc`           | Cloudflare Worker manifest — name, R2 binding, Assets binding, vars                                             |
| `src/web/`                 | React+Vite frontend. Served by the Worker via Workers Assets in production.                                      |
| `index.html`               | SPA shell — Vite's entry point at the project root; references `/src/web/main.tsx`.                              |
| `vite.config.ts`           | Vite + `@vitejs/plugin-react` + `@cloudflare/vite-plugin` — runs the Worker inside `workerd` in dev              |
| `tsconfig.json`            | Root project-references stub                                                                                     |
| `tsconfig.app.json`        | Client TS project (`src/web/`, DOM lib, `jsx: react-jsx`)                                                        |
| `tsconfig.worker.json`     | Worker TS project (`src/server/`, workerd lib)                                                                   |
| `baerly.config.ts`         | App config — `app`, `tenant`, `target`, `collections` (schemas live here). Also exports the inferred `Note` row type used by the web client. |

> **`baerly.config.ts` is dual-included.** Both `tsconfig.app.json`
> and `tsconfig.worker.json` `include` this file, so it must only
> import from `baerly-storage`, `zod`, and other files reachable
> from **both** projects. Paths under `src/server/` are worker-only;
> importing them here triggers `TS6307: File … is not listed within
> the file list of project … tsconfig.app.json`. Put document
> interfaces here next to their schema (`export type Note =
> z.infer<typeof NoteSchema>`); re-export from a server-only file if
> downstream code wants a local name.

## When editing X, read Y

- **Typed collections** — two ways to get a typed row, in DX order.
  The generic on `client.collection<N>(name)` is the collection
  **name** (constrained to `CollectionNames<typeof config>`), not the
  row type — so don't pass a row type to it.
  1. **Bind the config.** This template's `src/web/client.ts`
     already passes `config` to `createBaerlyClient({ baseUrl,
     config })`, so `client.collection("notes")` returns
     `ClientCollection<Row>` with `Row` derived from the
     `NoteSchema` declared in `baerly.config.ts`. No generic
     needed. When you need to name that row type elsewhere, use
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
     import { createBaerlyClient, type ClientCollection } from "@gusto/baerly-storage/client";
     import type { DocumentData } from "@gusto/baerly-storage";
     interface Bookmark extends DocumentData { _id: string; url: string }
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
  `new MemoryStorage()` swaps R2 / S3 for an in-process map.

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
  fields cover an index's keys. No call-site hint is needed (the
  earlier `.useIndex(name)` chain was removed when the planner
  shipped — `Query<T>` has no such method).

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

  With that declared, `db.collection("notes").where({ body: "TODO" }).all()`
  walks `by_body` automatically. Composite indexes (`on: ["body",
  "tag"]`) match any leftmost prefix. Mismatches (predicate
  doesn't cover any index) fall back to a full table scan with a
  metric bump; correctness is preserved because the reader re-checks
  the predicate in memory regardless of how it got the row set.

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
  HTTP clients see a 400 with the same envelope. Validation runs
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
  a `verifier:` on the factory overrides it. The schema-bound
  `notes` collection (`baerly.config.ts:NoteSchema`) runs server-side
  regardless of the auth posture. `baerly doctor --target=cloudflare`
  warns on `"none"` for deploy targets. See "Going to production"
  below for the two production-fit recipes.

### Going to production

The scaffold ships `auth: "none"` so the day-1 happy path works with
zero env vars. The `NoteSchema` in `baerly.config.ts` continues to
validate writes server-side under every posture below — only the
header-check seam changes.

<!-- pattern-a:start -->
**Pattern A — env-aware verifier (recommended for CF Access).** Same
artifact ships to dev and prod; the factory `verifier:` override
engages only when prod env vars are present. `baerlyWorker` resolves
the factory `verifier:` first, so the override silently supersedes
`config.auth: "none"` in prod.

```ts
// baerly.config.ts — unchanged
import { z } from "zod";
import { defineConfig } from "@gusto/baerly-storage/config";

export const NoteSchema = z.object({
  _id: z.string(),
  body: z.string().min(1),
});
export type Note = z.infer<typeof NoteSchema>;

export default defineConfig({
  app: "react-cloudflare",
  tenant: "react-demo",
  target: "cloudflare",
  auth: "none",     // dev default
  collections: {
    notes: { schema: NoteSchema },
  },
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
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { baerlyDevAuth, loadDevVars } from "@gusto/baerly-storage/dev/vite";

const { SHARED_SECRET } = loadDevVars(".dev.vars", "SHARED_SECRET");

export default defineConfig({
  plugins: [
    react(),
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
envelope and the `BAERLY_MAINTENANCE_*` operator env vars (you almost never need them).

Operator opt-in: call runScheduledMaintenance from @gusto/baerly-storage/maintenance on
your own schedule. Not required for steady-state operation.
<!-- pattern-d:end -->

## When to graduate

baerly-storage is designed for the small-to-medium operating point.
The cost model puts the soft ceiling at:

- **~30 writes / minute / collection** (throughput ceiling — model/estimate)
- **>10 GB / tenant stored** (R2 free-tier storage line — a cost signal, not a protocol ceiling)
- **~100 collections / tenant** (soft fan-out guideline — bench-grounded linear cost)

At M-size (~30 writes/min) the projected cost is ~$18/mo on R2. Past
those, per-class op pricing and fan-out scan cost start to dominate;
you've outgrown the workload envelope — move to a database service (D1 / Postgres) suited to higher scale.
Pick your graduation target:
- **Cloudflare Workers + lock-in OK:** [D1](https://developers.cloudflare.com/d1/) — cheaper per-write at M-size.
- **Off-Workers or portability matters:** managed Postgres.
- **Single-instance Node:** SQLite via Litestream.

Either way, the export below is mechanical because log entries are
Debezium-style CDC change events — graduation is a baerly-storage
win, not a churn event.

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
`/v1/since?collection=<name>&cursor=<opaque>` long-poll batches a
non-empty change for any subscribed
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
not a storable value — `DocumentValue` doesn't include `null`, so
subsequent `get()` / query results expose deleted optional fields as
`undefined`, not `null`.
That's why this recipe uses `.optional()` and not `.nullable()`.

## Pointers

- `baerly.config.ts` — app config + `NoteSchema` + inferred `Note` type.
- `src/server/index.ts` — Worker entry.
- `wrangler.jsonc` — Cloudflare Worker manifest (R2 binding, `assets:`, vars).
- `vite.config.ts` — Vite + `@vitejs/plugin-react` + `@cloudflare/vite-plugin`.
- `package.json` — root scripts + dependencies.
