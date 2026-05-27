---
title: baerly-storage — public API quickref
audience: agent
summary: One-read flat reference of the public API surface for headless / CLI agents without a TypeScript language server.
tags: [agent-quickref, baerly]
---

# baerly-storage — public API quickref

This file ships in `dist/API.md` so a freshly-installed
`node_modules/baerly-storage/dist/API.md` is one `cat` away from the
full public surface. (It is named `API.md` rather than `AGENTS.md` to
avoid colliding with the scaffolded user app's own `AGENTS.md` at the
project root.) It is hand-curated; the `.d.ts` files in this same
directory remain the source of truth (the bundler chunks them across
`index-*.d.ts` / `client-*.d.ts` / `db-*.d.ts` / etc., so they're
noisy to read flat — read this first, drop into the `.d.ts` chunks
only for exact signatures).

## Imports cheat sheet

```ts
// Server kernel
import {
  Db,
  MemoryStorage,                 // in-memory `Storage`; canonical for tests
  type Table, type Query,
  type DocumentData, type ConsistencyLevel,
  BaerlyError, type BaerlyErrorCode,
  defineConfig,                  // narrower; root barrel
} from "baerly-storage";

// Scaffold-aware config (`app`, `tenant`, `target`, `domain`, …)
import { defineConfig } from "baerly-storage/config";
// → use this one inside `baerly.config.ts`.

// Browser / Node client (HTTP)
import {
  createBaerlyClient,
  type BaerlyClient, type ClientTable, type ClientQuery,
  type TerminalOptions, type Fetcher,
} from "baerly-storage/client";

// Auth verifiers
import {
  sharedSecret, cloudflareAccess, bearerJwt,
} from "baerly-storage/auth";

// Adapters
import { baerlyWorker, r2BindingStorage } from "baerly-storage/cloudflare";
import { baerlyNode, s3Storage, r2Storage, minioStorage, gcsStorage } from "baerly-storage/node";

// Dev helpers (Vite, local-fs storage)
import { baerlyDevAuth, loadDevVars } from "baerly-storage/dev/vite";
import { LocalFsStorage } from "baerly-storage/dev";
```

## `Db.create({ storage, app, tenant, config? })`

One `Db` per `(app, tenant)` request. The constructor is private —
always go through `Db.create`. Tables are auto-provisioned on first
write (no `ensureTable` step).

```ts
import { Db, MemoryStorage } from "baerly-storage";
import config from "./baerly.config";

const db = Db.create({
  storage: new MemoryStorage(),   // or `s3Storage(...)`, `r2BindingStorage(env.BUCKET)`, …
  app: "tickets",
  tenant: "acme-co",
  config,                          // ← optional. Wires schemas + indexes
                                   //   AND narrows `db.table(name)` types.
});

await db.table("tickets").insert({ title: "first ticket", status: "open" });
const open = await db.table("tickets").where({ status: "open" }).all();
```

Full `Db.create` config:

```ts
Db.create<TConfig>({
  storage: Storage;              // required
  app: string;                   // required
  tenant: string;                // required
  config?: TConfig;              // optional; from `defineConfig(...)`
});
```

## `db.table(name)` → `Table<T>`

`Table<T>` carries the common-case verbs directly (table-level reads
plus by-primary-key mutations). Modifiers (`where`, `order`, `limit`)
return a `Query<T>` for bulk-by-predicate work. Terminals fire I/O on
the spot.

```ts
interface Table<T extends DocumentData = DocumentData> {
  readonly name: string;
  // Reads — whole collection / by id.
  first(): Promise<T | undefined>;
  all(): Promise<T[]>;
  count(): Promise<number>;
  get(id: string): Promise<T | undefined>;
  // Modifiers — return Query<T>.
  where(predicate: PredicateArg<T>): Query<T>;     // PredicateArg = Predicate<T> | (q => PredicateBuilder<T>)
  order(spec: OrderSpec<T>): Query<T>;
  limit(n: number): Query<T>;
  // Writes — by primary key.
  insert(doc: Partial<T> & DocumentData): Promise<{ _id: string }>;
  update(id: string, patch: Partial<T>): Promise<{ modified: number }>;
  replace(id: string, doc: T): Promise<void>;
  delete(id: string): Promise<{ deleted: number }>;
}
```

`Query<T>` keeps the chainable read terminals and the predicate-aware
bulk mutation verbs:

```ts
interface Query<T> extends /* Table<T>'s modifiers */ {
  first(): Promise<T | undefined>;
  all(): Promise<T[]>;
  count(): Promise<number>;
  update(patch: Partial<T>): Promise<{ modified: number }>;   // bulk
  delete(): Promise<{ deleted: number }>;                      // bulk
}
```

`replace` is by-id only — `Table<T>.replace(id, doc)` throws
`NotFound` on missing id. There is no predicate-form `.replace(doc)`
on `Query<T>`: a strict-cardinality-1 verb is redundant ceremony to
the by-id form (see ADR-002).

### Predicates

Two shapes, both legal on `.where(...)`:

1. **Object literal** — equality only. Top-level, dotted-path, or
   nested literal sub-predicate. Multi-field is implicit AND.
2. **Callback DSL** — `q => q.eq(...).gt(...).gte(...).lt(...).lte(...).in(...)`.
   The methods on `PredicateBuilder<T>` ARE the supported operator
   vocabulary; methods absent from the type (`or`, `not`, `regex`,
   `ne`, `exists`) do not exist and won't typecheck.

Chained `.where(...).where(...)` AND-merges across calls and across
shapes. Both forms normalise to one wire format (a flat clause list,
`{ clauses: PredicateClause[] }`); the HTTP `?where=` param carries
that wire JSON.

By-`_id` lookups go through `.get(id)` / `.update(id, patch)` /
`.replace(id, doc)` / `.delete(id)`, **not** `.where({ _id: id })`.
`_id` is excluded from `Path<T>` (and so from `PredicateBuilder<T>`),
so `.where({ _id: ... })` is a compile-time TS error. Nested `_id`
paths (`author._id`) on referenced documents are still allowed.

```ts
db.table("tickets").where({ status: "open" }).all();
db.table("tickets").where({ "assignee.team": "platform" }).all();
db.table("tickets").where(q => q.gte("count", 1).lt("count", 10)).all();
db.table("tickets").where(q => q.in("status", ["open", "pending"])).all();
db.table("tickets")
  .where({ status: "open" })
  .where(q => q.gte("priority", 5))
  .all();
```

#### Wire format (`?where=`)

`PredicateWire` is the on-the-wire shape:

```ts
interface PredicateClause {
  readonly op: "eq" | "gt" | "gte" | "lt" | "lte" | "in";
  readonly field: string;          // top-level or dotted path
  readonly value: DocumentValue | ReadonlyArray<DocumentValue>;   // array iff op === "in"
}
interface PredicateWire { readonly clauses: ReadonlyArray<PredicateClause>; }
```

Example: `.where({ status: "open" })` → `{"clauses":[{"op":"eq","field":"status","value":"open"}]}`.
The empty wire `{"clauses":[]}` matches every document.

## Mutations

By-id (the common case) lives on `Table<T>`; predicate-aware bulk
verbs live on `Query<T>` after `.where(...)`.

```ts
await db.table("tickets").insert({ status: "open", title: "ship it" });
// → { _id: "01HQ..." }  (UUIDv7; caller may supply `_id`)

// By-id (Table<T>):
await db.table("tickets").update("01HQ...", { status: "closed" });
// → { modified: 1 }  (JSON-merge-patch RFC 7386; `null` deletes a field)

await db.table("tickets").replace("01HQ...", {
  _id: "01HQ...", status: "open", title: "rewrite",
});
// → void  (whole-document overwrite)

await db.table("tickets").delete("01HQ...");
// → { deleted: 1 }  (or `{ deleted: 0 }` if the id is unknown)

// Bulk-by-predicate (Query<T>):
await db.table("tickets")
  .where({ status: "open" })
  .update({ status: "closed", closed_at: new Date().toISOString() });
// → { modified: N }

await db.table("tickets").where({ status: "closed" }).delete();
// → { deleted: N }
```

## `DocumentData` — row shape constraint

Every row type must satisfy
`{ [k: string]: DocumentValue }` where
`DocumentValue = string | number | boolean | null | DocumentData | Array<DocumentValue>`.

Three ways to get a typed row:

1. **Bind the config** (preferred). Declare collection in
   `baerly.config.ts` with a schema; pass `config` to `Db.create` /
   `createBaerlyClient`. `db.table("tickets")` returns
   `Table<RowOf<TConfig, "tickets">>`. No generic, no cast.

2. **Per-call generic.** Without a bound config:
   ```ts
   import type { DocumentData } from "baerly-storage";
   interface Bookmark extends DocumentData { _id: string; url: string }
   await db.table<Bookmark>("bookmarks").all();
   ```
   A plain `interface Bookmark { _id: string; url: string }` (no
   index signature) fails with TS2344 by design — the constraint
   keeps the row JSON-compatible.

3. **Falls back to `DocumentData`** if you omit the generic.

## Errors

`BaerlyError` is the single error class. Discriminate by `code`, not
`instanceof` (the code string survives realm boundaries):

```ts
try {
  await db.table("tickets").insert({ title: "hi" });
} catch (err) {
  if (err instanceof BaerlyError && err.code === "Conflict") {
    // CAS lost; caller decides whether to retry
  }
}
```

| `code`                   | HTTP | When                                                                 |
| ------------------------ | ---- | -------------------------------------------------------------------- |
| `InvalidConfig`          | 400  | Caller config/input is invalid (bad bucket, malformed predicate, …)  |
| `NetworkError`           | 502  | Transport (S3 5xx, retries exhausted)                                |
| `AccessDenied`           | 403  | S3 403 or bucket policy denied                                       |
| `InvalidResponse`        | 502  | Server returned unparseable body                                     |
| `Internal`               | 500  | Invariant violation — file a bug                                     |
| `SchemaError`            | 422  | JSON shape invalid or bound schema rejected the doc                  |
| `Conflict`               | 409  | CAS retry budget exhausted, or `insert` `_id` collision              |
| `Unauthorized`           | 401  | Verifier returned no identity                                        |
| `NotFound`               | 404  | Row by id not found                                                  |
| `PayloadTooLarge`        | 413  | Body > 1 MiB cap                                                     |
| `UnsatisfiablePredicate` | 400  | Predicate is well-formed but contradicts itself (empty `in` set, etc.) |

## `defineConfig({ app, tenant, target, collections })`

Scaffold-aware: lives at `baerly-storage/config`. Holds both deploy
metadata (`app`, `tenant`, `target`, `domain`, `cloudflareAccess`,
`requiredSecrets`, `observability`) AND the runtime schema map.

```ts
import { defineConfig } from "baerly-storage/config";
import { z } from "zod";

const TicketSchema = z.object({
  _id: z.string().optional(),
  status: z.enum(["open", "closed"]),
  title: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

export default defineConfig({
  app: "helpdesk",
  tenant: "acme",
  target: "cloudflare",
  collections: {
    tickets: {
      schema: TicketSchema,                                  // StandardSchema v1
      indexes: [{ name: "by_status", on: "status" }],        // single-field equality
    },
  },
});
```

Schemas: any [StandardSchema v1](https://standardschema.dev) validator
(Zod 3.24+, Valibot 0.36+, ArkType 2.0+). Validation runs on the
post-image: `update` and `replace` see the full doc, not just the
patch. Failures → `BaerlyError{code:"SchemaError", issues:[…]}`,
mapped to HTTP 422.

Indexes: declared here, threaded into `Db.create` automatically. The
read-path auto-planner picks an index when the predicate matches;
mismatches fall back to the full scan with a metric bump (correctness
preserved).

## `createBaerlyClient` (browser / Node HTTP client)

```ts
import type config from "./baerly.config";  // type-only — server adapter stays out of the SPA bundle
const client = createBaerlyClient<typeof config>({
  baseUrl: "",                                  // same-origin
  headers: { Authorization: "Bearer …" },       // wrap `fetch` for per-call refresh
  fetch: customFetcher,                          // optional Fetcher middleware
});

await client.table("tickets").where({ status: "open" }).all();
```

`ClientTable<T>` mirrors `Table<T>` but every terminal accepts a
trailing `TerminalOptions`:

```ts
interface TerminalOptions {
  signal?: AbortSignal;          // cancels this specific request
}

await client.table("tickets").all({ signal: ac.signal });
```

That extra options bag is the **only** API difference between
`Table<T>` and `ClientTable<T>`. Same modifiers, same terminals,
same predicates.

## Long-poll: `/v1/since`

`GET /v1/since?table=…&cursor=…` is the long-poll endpoint that
streams mutations without WebSockets. The server holds the request
open for ~25 s; if new log entries land in that window it flushes
them immediately, otherwise it returns an empty batch with the
cursor unchanged.

```ts
// Wire shape (returned raw — not wrapped in HttpOkEnvelope):
interface SinceResponse {
  readonly events: ReadonlyArray<LogEntry>;
  readonly next_cursor: string;
}

interface LogEntry {
  readonly lsn: string;             // opaque cursor; lex-asc, monotonic
  readonly commit_ts: string;       // ISO-8601 ms
  readonly op: "I" | "U" | "D" | "T" | "M";
  readonly collection: string;
  readonly doc_id?: string;         // I/U/D only
  readonly new?: DocumentData;      // I/U — post-image
  readonly patch?: DocumentData;    // U — JSON-merge-patch (RFC 7386)
  readonly schema_version: number;
  readonly session: string;
  readonly seq: number;
  // `old` / `key_old` / `origin` are optional; see `LogEntry` JSDoc.
}
```

**Cursor priming.** First call: pass `cursor=` (empty string). The
server replies with the current head and `next_cursor`. Pass that
cursor back on every subsequent call. The cursor is opaque — treat
it as a string. `events` is empty iff the budget elapsed with no new
writes (and `next_cursor` is unchanged).

React applications use `baerly-storage/client/react` (see next
section) instead of poking `/v1/since` by hand; hand-rolled
subscribers in other UI frameworks can `fetch` this endpoint
directly, or import the internal `pollSinceOnce` helper from
`@baerly/client` if cursor-aware tailing is needed.

## React: `BaerlyProvider`, `useQuery`, `useMutation`

`baerly-storage/client/react` exposes three symbols. The provider
owns a shared `/v1/since` long-poll per `(client, table)`; idle
cycles cost zero list reads, and any non-empty batch invalidates
every `useQuery` whose chain touches the firing table.

```tsx
import {
  BaerlyProvider, useQuery, useMutation,
} from "baerly-storage/client/react";

// 1. Wrap your app once.
<BaerlyProvider client={createBaerlyClient({ baseUrl: "", config })}>
  <App />
</BaerlyProvider>

// 2. useQuery(cb, deps) — cb receives the bare client and returns
//    a ClientTable / ClientQuery chain. Re-runs on deps change OR
//    on long-poll invalidation. Result is a discriminated union:
const result = useQuery((c) => c.table<Note>("notes").all(), []);
// result.status: "loading" | "ok" | "error" | "skipped"
// result.data:   T[] | undefined        (present iff status === "ok")
// result.error:  BaerlyError | undefined (present iff status === "error")

// 3. useQuery.skip — short-circuit to status: "skipped", no
//    subscription. Use for conditional or dependent reads.
const filtered = useQuery(
  (c) => filter === "all"
    ? useQuery.skip
    : c.table<Note>("notes").where({ status: filter }).all(),
  [filter],
);

// 4. useMutation() — returns [mutate, { isPending, error }].
//    Run any client call inside mutate; subscribed useQuery reads
//    re-run automatically once the long-poll sees the write.
const [mutate, { isPending, error }] = useMutation();
await mutate((c) => c.table("notes").insert({ body }));
```

## HTTP wire format

The JS SDK is the canonical path. Reach for `curl` only when
debugging. Mutation bodies are wrapped:

| Route                       | Body                | Response                       |
| --------------------------- | ------------------- | ------------------------------ |
| `POST   /v1/t/:table`       | `{"doc":{...}}`     | `201 {_id}`                    |
| `PATCH  /v1/t/:table/:id`   | `{"patch":{...}}`   | `200 {modified}`               |
| `PUT    /v1/t/:table/:id`   | `{"doc":{...}}`     | `200 {modified}`               |
| `DELETE /v1/t/:table/:id`   | —                   | `204`                          |

Reads (`GET /v1/t/:table[/:id]`, `GET /v1/count?table=…`,
`GET /v1/since?table=…&cursor=…`) take no body and return
`{ data, _meta }` or a route-specific envelope. A flat `POST` body
(no `doc` wrapper) returns
`400 SchemaError "Request body must be { doc: object }"` — wording is
locked by `assertJsonBodyField` in the kernel.

## Adapter factories

```ts
// Cloudflare Worker entry
import { baerlyWorker } from "baerly-storage/cloudflare";
export default baerlyWorker((env) => ({
  verifier: cloudflareAccess({ teamDomain, audienceTag }),
  // scheduled?: (controller, env, ctx) => …    // opt-in cron handler
}));

// Node listener entry (any host that runs `node server.js`)
import { baerlyNode, s3Storage } from "baerly-storage/node";
baerlyNode({
  storage: s3Storage({ bucket: "…", credentials: { … } }),
  verifier: bearerJwt({ jwks, issuer, audience }),
  webRoot: "dist/client",                         // optional SPA static-serve
  maintenance: { collections: ["tickets"], tenants: ["acme"] },  // optional
}).listen(PORT);
```

**Single-tenant CF Access.** Vanilla CF Access JWTs carry `sub`/`email`
but no `tenant` claim. Pin the tenant from env instead of a claim:
`cloudflareAccess({ teamDomain, audienceTag, tenantPrefix: "main" })`.
Same option is available on `bearerJwt`.

**Local dev (`wrangler dev`, no Vite).** Declare `auth: "none"` in
`baerly.config.ts` for the dev posture — the adapter synthesizes a
verifier that pins every request to `config.tenant` without consulting
the `Authorization` header. Swap to `auth: "shared-secret"` (or pass a
custom `Verifier` on the factory) when you're ready to gate by wire
credentials. Production CF Worker recipes layer CF Access in front of
the Worker route; the verifier reads the resulting JWT:

```ts
// baerly.config.ts
import { defineConfig } from "baerly-storage/config";
export default defineConfig({
  app: "tickets",
  tenant: "main",
  target: "cloudflare",
  auth: "none", // dev only — production swaps to "shared-secret" or a custom Verifier
  collections: { /* … */ },
});

// src/server/index.ts
import { baerlyWorker } from "baerly-storage/cloudflare";
import config from "../../baerly.config.ts";
export default baerlyWorker(() => ({ config }));
```


`s3Storage` / `r2Storage` / `minioStorage` / `gcsStorage` from
`baerly-storage/node` are re-exports of one factory family — same
shape (bucket + credentials), all hide `aws4fetch` / `@xmldom/xmldom`
behind the package boundary. **Don't confuse them with
`r2BindingStorage` from `baerly-storage/cloudflare`**: that one takes
the platform-bound `R2Bucket` directly (`r2BindingStorage(env.BUCKET)`)
and is the only storage factory a Worker should reach for — the
credential-based factories assume `fetch` + Node TLS, not the Workers
runtime.

## Anti-patterns

- Don't reach into `node_modules/baerly-storage/dist/` at runtime —
  consume the published exports.
- Don't widen branded types (`UUID`, `ContentVersionId`) with
  `as string`. The brand exists to prevent confusion bugs.
- Don't put `SHARED_SECRET` in the SPA bundle. It's
  server-to-server-only; the dev path uses `baerlyDevAuth` to inject
  it server-side, the prod path uses CF Access (CF target) or
  `bearerJwt` (Node target).
- Don't mutate `VerifierResult.tenantPrefix` between the verifier
  and `Db.create`. The dispatcher pins the tenant from the
  verifier's return value.

## Where to look next

- Per-symbol JSDoc: read the `.d.ts` chunks in this directory
  (`db-*.d.ts`, `index-*.d.ts`, `client-*.d.ts`, …) — the bundler
  splits them; `cat dist/*.d.ts` gives the union.
- Theoretical foundations + cost model: the repository's `docs/`
  tree (`docs/about/`, `docs/spec/`).
- Recipes: `docs/guide/` (auth, observability, backups, troubleshooting).
