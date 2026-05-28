---
title: baerly-storage — public API quickref
audience: agent
summary: One-read flat reference of the public API surface for headless / CLI agents without a TypeScript language server.
tags: [agent-quickref, baerly]
---

# baerly-storage — public API quickref

This file ships in `dist/API.md` so a freshly-installed
`node_modules/@gusto/baerly-storage/dist/API.md` is one `cat` away from the
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
  type Collection, type Query,
  type DocumentData,
  BaerlyError, type BaerlyErrorCode,
  defineConfig,                  // narrower; root barrel
} from "@gusto/baerly-storage";

// Scaffold-aware config (`app`, `tenant`, `target`, `domain`, …)
import { defineConfig } from "@gusto/baerly-storage/config";
// → use this one inside `baerly.config.ts`.

// Browser / Node client (HTTP)
import {
  createBaerlyClient,
  type BaerlyClient, type ClientCollection, type ClientQuery,
  type TerminalOptions, type Fetcher,
} from "@gusto/baerly-storage/client";

// Auth verifiers
import {
  sharedSecret, cloudflareAccess, bearerJwt,
} from "@gusto/baerly-storage/auth";

// Adapters
import { baerlyWorker, r2BindingStorage } from "@gusto/baerly-storage/cloudflare";
import { baerlyNode, s3Storage, r2Storage, minioStorage, gcsStorage } from "@gusto/baerly-storage/node";

// Dev helpers (Vite, local-fs storage)
import { baerlyDevAuth, loadDevVars } from "@gusto/baerly-storage/dev/vite";
import { LocalFsStorage } from "@gusto/baerly-storage/dev";
```

## `Db.create({ storage, app, tenant, config? })`

One `Db` per `(app, tenant)` request. The constructor is private —
always go through `Db.create`. Collections are auto-provisioned on first
write (no `ensureCollection` step).

```ts
import { Db, MemoryStorage } from "@gusto/baerly-storage";
import config from "./baerly.config";

const db = Db.create({
  storage: new MemoryStorage(),   // or `s3Storage(...)`, `r2BindingStorage(env.BUCKET)`, …
  app: "tickets",
  tenant: "acme-co",
  config,                          // ← optional. Wires schemas + indexes
                                   //   AND narrows `db.collection(name)` types.
});

await db.collection("tickets").insert({ title: "first ticket", status: "open" });
const open = await db.collection("tickets").where({ status: "open" }).all();
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

## `db.collection(name)` → `Collection<T>`

`Collection<T>` carries the common-case verbs directly (collection-level
reads plus by-primary-key mutations). Modifiers (`where`, `order`,
`limit`) return a `Query<T>` for bulk-by-predicate work. Terminals fire
I/O on the spot.

```ts
interface Collection<T extends DocumentData = DocumentData> {
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
interface Query<T> extends /* Collection<T>'s modifiers */ {
  first(): Promise<T | undefined>;
  all(): Promise<T[]>;
  count(): Promise<number>;
  update(patch: Partial<T>): Promise<{ modified: number }>;   // bulk
  delete(): Promise<{ deleted: number }>;                      // bulk
}
```

`replace` is by-id only — `Collection<T>.replace(id, doc)` throws
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
db.collection("tickets").where({ status: "open" }).all();
db.collection("tickets").where({ "assignee.team": "platform" }).all();
db.collection("tickets").where(q => q.gte("count", 1).lt("count", 10)).all();
db.collection("tickets").where(q => q.in("status", ["open", "pending"])).all();
db.collection("tickets")
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

By-id (the common case) lives on `Collection<T>`; predicate-aware bulk
verbs live on `Query<T>` after `.where(...)`.

```ts
await db.collection("tickets").insert({ status: "open", title: "ship it" });
// → { _id: "01HQ..." }  (UUIDv7; caller may supply `_id`)

// By-id (Collection<T>):
await db.collection("tickets").update("01HQ...", { status: "closed" });
// → { modified: 1 }  (JSON-merge-patch RFC 7386; `null` deletes a field)

await db.collection("tickets").replace("01HQ...", {
  _id: "01HQ...", status: "open", title: "rewrite",
});
// → void  (whole-document overwrite)

await db.collection("tickets").delete("01HQ...");
// → { deleted: 1 }  (or `{ deleted: 0 }` if the id is unknown)

// Bulk-by-predicate (Query<T>):
await db.collection("tickets")
  .where({ status: "open" })
  .update({ status: "closed", closed_at: new Date().toISOString() });
// → { modified: N }

await db.collection("tickets").where({ status: "closed" }).delete();
// → { deleted: N }
```

## `DocumentData` — row shape constraint

Every row type must satisfy
`{ [k: string]: DocumentValue }` where
`DocumentValue = string | number | boolean | DocumentData | Array<DocumentValue>`.

Note: `null` is intentionally NOT a valid stored value. In a
JSON-merge-patch (RFC 7386) `update`, `null` is the field-deletion
sentinel; allowing it as a stored value would collapse "this field is
null" with "delete this field". Use `.optional()` in your schema for
absent values.

Two ways to get a typed row:

1. **Bind the config** (preferred). Declare collection in
   `baerly.config.ts` with a schema; pass `config` to `Db.create` /
   `createBaerlyClient`. `db.collection("tickets")` returns
   `Collection<RowOf<TConfig, "tickets">>`. No generic, no cast.

2. **Falls back to `DocumentData`** when no config is bound. Cast at
   the construction site for a narrower row shape:
   ```ts
   import type { Collection, DocumentData } from "@gusto/baerly-storage";
   interface Bookmark extends DocumentData { _id: string; url: string }
   const bookmarks = db.collection("bookmarks") as Collection<Bookmark>;
   await bookmarks.all();
   ```
   A plain `interface Bookmark { _id: string; url: string }` (no
   index signature) fails the `T extends DocumentData` constraint by
   design — the constraint keeps the row JSON-compatible.

## Errors

`BaerlyError` is the single error class. Discriminate by `code`, not
`instanceof` (the code string survives realm boundaries):

```ts
try {
  await db.collection("tickets").insert({ title: "hi" });
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

Scaffold-aware: lives at `@gusto/baerly-storage/config`. Holds both deploy
metadata (`app`, `tenant`, `target`, `domain`, `cloudflareAccess`,
`requiredSecrets`, `observability`) AND the runtime schema map.

```ts
import { defineConfig } from "@gusto/baerly-storage/config";
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

await client.collection("tickets").where({ status: "open" }).all();
```

`ClientCollection<T>` mirrors `Collection<T>` but every terminal accepts a
trailing `TerminalOptions`:

```ts
interface TerminalOptions {
  signal?: AbortSignal;          // cancels this specific request
}

await client.collection("tickets").all({ signal: ac.signal });
```

That extra options bag is the **only** API difference between
`Collection<T>` and `ClientCollection<T>`. Same modifiers, same terminals,
same predicates.

## Long-poll: `/v1/since`

`GET /v1/since?collection=…&cursor=…` is the long-poll endpoint that
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
server's fast path returns immediately *iff* the log already has
entries for this collection — you get `events: [...]` and the
last entry's `lsn` as `next_cursor`. **If the collection is empty,
the first call blocks for the full long-poll budget (~25 s) before
returning `events: []` with `next_cursor: ''`.** Either prime by
inserting one row first if you need an immediate response, or budget
your client / test for the full timeout. Subsequent calls pass the
returned cursor back — the cursor is opaque, treat it as a string,
and `events` is empty iff the budget elapsed with no new writes
(`next_cursor` unchanged).

**Test-mode tuning.** Vitest's default per-test timeout is 5 s; the
long-poll's 25 s budget will dominate that. Shrink it on the worker
factory under a test-only env switch:

```ts
export default baerlyWorker((env) => ({
  config,
  // Production: omit both (inherit 25 s / 1 s defaults).
  // Test: wire from miniflare bindings.
  sinceTimeoutMs: env.SINCE_TIMEOUT_MS,
  sincePollIntervalMs: env.SINCE_POLL_INTERVAL_MS,
}));
```

In `vitest.config.mts`'s miniflare bindings, set them as numbers
(`SINCE_TIMEOUT_MS: 2000`, `SINCE_POLL_INTERVAL_MS: 50`) so the
factory sees `number | undefined` without runtime coercion. Don't
shrink `sinceTimeoutMs` in production code paths — it multiplies the
R2 class-A op count per idle long-poll connection.

React applications use `@gusto/baerly-storage/client/react` (see next
section) instead of poking `/v1/since` by hand; hand-rolled
subscribers in other UI frameworks can `fetch` this endpoint
directly, or import the internal `pollSinceOnce` helper from
`@baerly/client` if cursor-aware tailing is needed.

## React: `BaerlyProvider`, `useQuery`, `useMutation`

`@gusto/baerly-storage/client/react` exposes three symbols. The provider
owns a shared `/v1/since` long-poll per `(client, collection)`; idle
cycles cost zero list reads, and any non-empty batch invalidates
every `useQuery` whose chain touches the firing collection.

```tsx
import {
  BaerlyProvider, useQuery, useMutation,
} from "@gusto/baerly-storage/client/react";

// 1. Wrap your app once.
<BaerlyProvider client={createBaerlyClient({ baseUrl: "", config })}>
  <App />
</BaerlyProvider>

// 2. useQuery(cb, deps) — cb receives the bare client and returns
//    a ClientCollection / ClientQuery chain. Re-runs on deps change OR
//    on long-poll invalidation. Result is a discriminated union:
const result = useQuery((c) => c.collection("notes").all() as Promise<Note[]>, []);
// result.status: "loading" | "ok" | "error" | "skipped"
// result.data:   T[] | undefined        (present iff status === "ok")
// result.error:  BaerlyError | undefined (present iff status === "error")

// 3. useQuery.skip — short-circuit to status: "skipped", no
//    subscription. Use for conditional or dependent reads.
const filtered = useQuery(
  (c) => filter === "all"
    ? useQuery.skip
    : c.collection("notes").where({ status: filter }).all() as Promise<Note[]>,
  [filter],
);

// 4. useMutation() — returns [mutate, { isPending, error }].
//    Run any client call inside mutate; subscribed useQuery reads
//    re-run automatically once the long-poll sees the write.
const [mutate, { isPending, error }] = useMutation();
await mutate((c) => c.collection("notes").insert({ body }));
```

## HTTP wire format

The JS SDK is the canonical path. Reach for `curl` only when
debugging. Mutation bodies are wrapped:

| Route                            | Body                | Response                       |
| -------------------------------- | ------------------- | ------------------------------ |
| `POST   /v1/c/:collection`       | `{"doc":{...}}`     | `201 {_id}`                    |
| `PATCH  /v1/c/:collection/:id`   | `{"patch":{...}}`   | `200 {modified}`               |
| `PUT    /v1/c/:collection/:id`   | `{"doc":{...}}`     | `200 {modified}`               |
| `DELETE /v1/c/:collection/:id`   | —                   | `204`                          |

Reads (`GET /v1/c/:collection[/:id]`, `GET /v1/count?collection=…`,
`GET /v1/since?collection=…&cursor=…`) take no body and return
`{ data, _meta }` or a route-specific envelope. A flat `POST` body
(no `doc` wrapper) returns
`400 SchemaError "Request body must be { doc: object }"` — wording is
locked by `assertJsonBodyField` in the kernel.

### Read modifiers (query params)

`GET /v1/c/:collection` accepts three JSON-encoded query params; all are
optional and compose:

| Param      | Encodes                                | Wire example                                 |
| ---------- | -------------------------------------- | -------------------------------------------- |
| `?where=`  | `PredicateWire` (see "Wire format" above) | `?where=%7B%22clauses%22%3A%5B%5D%7D`      |
| `?order=`  | `{ [field]: "asc" \| "desc" }`         | `?order=%7B%22sent_at%22%3A%22desc%22%7D`    |
| `?limit=`  | bare integer (no JSON wrapper)         | `?limit=50`                                  |

`?order=` and `?where=` are JSON, **not** Rails-style `field:asc` —
the kernel `JSON.parse`s them and returns `400 SchemaError` on a flat
string. Always `encodeURIComponent(JSON.stringify(spec))`. The JS SDK
(`createBaerlyClient`) and the React hooks build these for you; reach
for raw URLs only when scripting or when porting another framework's
client.

## Adapter factories

```ts
// Cloudflare Worker entry
import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";
export default baerlyWorker((env) => ({
  verifier: cloudflareAccess({ teamDomain, audienceTag }),
  // scheduled?: (controller, env, ctx) => …    // opt-in cron handler
}));

// Node listener entry (any host that runs `node server.js`)
import { baerlyNode, s3Storage } from "@gusto/baerly-storage/node";
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
import { defineConfig } from "@gusto/baerly-storage/config";
export default defineConfig({
  app: "tickets",
  tenant: "main",
  target: "cloudflare",
  auth: "none", // dev only — production swaps to "shared-secret" or a custom Verifier
  collections: { /* … */ },
});

// src/server/index.ts
import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";
import config from "../../baerly.config.ts";
export default baerlyWorker(() => ({ config }));
```


`s3Storage` / `r2Storage` / `minioStorage` / `gcsStorage` from
`@gusto/baerly-storage/node` are re-exports of one factory family — same
shape (bucket + credentials), all hide `aws4fetch` / `@xmldom/xmldom`
behind the package boundary. **Don't confuse them with
`r2BindingStorage` from `@gusto/baerly-storage/cloudflare`**: that one takes
the platform-bound `R2Bucket` directly (`r2BindingStorage(env.BUCKET)`)
and is the only storage factory a Worker should reach for — the
credential-based factories assume `fetch` + Node TLS, not the Workers
runtime.

### Verifier presets

`@gusto/baerly-storage/auth` ships three `Verifier` functions you can pass
to `baerlyWorker({ verifier })` or `baerlyNode({ verifier })`. Each
returns `VerifierResult | null` (null = 401 unauth; thrown
`BaerlyError` = 500 operator fault — the dispatcher splits the
codes deliberately so on-call paging targets operator faults only).

| Preset             | Identity source                                                                 | Tenant derivation                                  |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| `sharedSecret`     | `Authorization: Bearer <secret>` with constant-time compare                     | `tenantPrefix:` option (single-tenant only)        |
| `bearerJwt`        | JWT over JWKS, `iss` + `aud` + `alg` allowlist                                  | Configurable `tenantClaim` (default `"tenant"`) or fixed `tenantPrefix:` override |
| `cloudflareAccess` | `Cf-Access-Jwt-Assertion` header (thin shim over `bearerJwt`)                   | Same as `bearerJwt`                                |

```ts
import { sharedSecret, bearerJwt, cloudflareAccess } from "@gusto/baerly-storage/auth";
```

**`tenantPrefix:` (on `bearerJwt` and `cloudflareAccess`).** Pins
every verified request to a fixed tenant, bypassing claim lookup.
Use this in single-tenant deployments where the IdP doesn't ship a
tenant claim — the default `tenantClaim: "tenant"` would 401 every
request because vanilla CF Access JWTs carry only `sub`/`email`.
Signature, audience, and expiry checks are still enforced; only
tenant derivation is replaced.

**Why a function and not a class?** The source repo's
`docs/adr/005-verifier-function-shape.md` records the three
properties the shape upholds and the four rejected alternatives.

## Recipe — server-stamped trusted fields

Use this shape when a column must come from the verified identity
rather than the client request body (`sender_sub` on chat messages,
`owner_id` on user-owned rows, `created_by` on audit logs). The
HTTP routes `baerlyWorker` mounts under `/v1/c/:collection` accept the
doc verbatim from the request body — they don't read the verifier
identity into the row. Stamp it yourself in a custom route, then
block direct client writes to the same collection so a malicious
client can't supply the field by hand.

```ts
// src/server/index.ts
import { Db, type Verifier } from "@gusto/baerly-storage";
import { baerlyWorker, r2BindingStorage } from "@gusto/baerly-storage/cloudflare";
import type { BaerlyEnv } from "@gusto/baerly-storage/cloudflare";
import config from "../../baerly.config.ts";

// BaerlyEnv already declares `BUCKET: R2Bucket` and `APP: string`.
// Extend it with anything else the Worker reads from env.

const verifier: Verifier = async (req) => {
  const sub = /* extract from CF Access JWT / cookie / header */;
  if (!sub) return null;
  return { tenantPrefix: config.tenant, identity: { sub } };
};

const inner = baerlyWorker(() => ({ config, verifier }));

export default {
  async fetch(req: Request, env: BaerlyEnv, ctx: ExecutionContext) {
    const url = new URL(req.url);

    // (1) Block client writes to the trusted-stamp collection.
    if (
      url.pathname.startsWith("/v1/c/messages") &&
      req.method !== "GET"
    ) {
      return new Response("client writes disabled — POST /api/messages", {
        status: 405,
      });
    }

    // (2) Custom route — re-run verifier, stamp field, insert.
    if (url.pathname === "/api/messages" && req.method === "POST") {
      const verified = await verifier(req);
      if (verified === null) {
        return new Response("unauthorized", { status: 401 });
      }
      const { body } = await req.json<{ body: string }>();
      const db = Db.create({
        storage: r2BindingStorage(env.BUCKET),
        app: env.APP,
        tenant: verified.tenantPrefix,
        config,
      });
      const { _id } = await db.collection("messages").insert({
        body,
        sender_sub: (verified.identity as { sub: string }).sub,
        sent_at: Date.now(),
      });
      return Response.json({ _id }, { status: 201 });
    }

    // (3) Everything else goes through baerlyWorker (reads, /v1/since, etc.).
    return inner.fetch!(req, env, ctx);
  },
} satisfies ExportedHandler<BaerlyEnv>;
```

The client reads via the normal `GET /v1/c/messages` route and tails
via `GET /v1/since?collection=messages&cursor=…` — both still served by
`inner`. Only writes go through `/api/messages`.

**Known limitations of this recipe.** The custom-route `Db.create` is
a second instance — it doesn't share `baerlyWorker`'s
`observableStorage(...)` wrapping (so custom-route writes don't land
in the canonical-line storage counters) or the read-cache invalidation
helper. For pre-launch chat-shape apps this is acceptable; the
observability gap is being tracked as a follow-up. If you also need
PATCH/PUT/DELETE on the same collection, repeat steps (1) and (2) for
each verb.

## Anti-patterns

- Don't reach into `node_modules/@gusto/baerly-storage/dist/` at runtime —
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
