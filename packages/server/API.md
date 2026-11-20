---
title: baerly-storage — public API quickref
audience: agent
summary: One-read flat reference of the public API surface for headless / CLI agents without a TypeScript language server.
tags: [agent-quickref, baerly]
---

# baerly-storage — public API quickref

This file ships in `dist/API.md` so a freshly-installed `node_modules/@gusto/baerly-storage/dist/API.md` is one `cat` away from the full public surface. (It is named `API.md` rather than `AGENTS.md` to avoid colliding with the scaffolded user app's own `AGENTS.md` at the project root.) It is hand-curated; the `.d.ts` files in this same directory remain the source of truth (the bundler chunks them across `index-*.d.ts` / `client-*.d.ts` / `db-*.d.ts` / etc., so they're noisy to read flat — read this first, drop into the `.d.ts` chunks only for exact signatures).

The public surface is intentionally small and **closed**: the absence of a method is a design choice, not an undocumented gap. Every unsupported operation is a compile error — the type system enforces the vocabulary rather than surfacing a runtime "not implemented", so an agent reaches the correct call zero-shot without inventing ceremony the kernel doesn't support. The predicate operator set is the concrete example (see [Predicates](#predicates)).

## Imports cheat sheet

```ts
// Server kernel
import {
  Db,
  MemoryStorage, // in-memory `Storage`; canonical for tests
  type Collection,
  type Query,
  type Predicate, // equality-object `.where(...)` form
  type PredicateArg, // `.where(...)` arg: object or builder callback
  type DocumentData,
  type RowOf,
  type CollectionNames, // row-shape inference from a bound config
  BaerlyError,
  type BaerlyErrorCode,
  defineConfig, // narrower; root barrel
} from "@gusto/baerly-storage";

// Scaffold-aware config (`app`, `tenant`, `target`, `domain`, …)
import { defineConfig, type RowOf } from "@gusto/baerly-storage/config";
// → use this one inside `baerly.config.ts`. `RowOf` is exported here too
//   so `baerly.config.ts` siblings (e.g. `types.ts`) can import the inferred
//   row type without reaching into the server barrel.

// HTTP router + error mapping — custom adapters and embed-by-hand routes
import { createRouter, mapError } from "@gusto/baerly-storage/http";

// Browser / Node client (HTTP)
import {
  createBaerlyClient,
  type BaerlyClient,
  type ClientCollection,
  type ClientQuery,
  type TerminalOptions,
  type Fetcher,
  type Predicate,
  type PredicateArg,
} from "@gusto/baerly-storage/client";

// Auth verifiers
import { sharedSecret, cloudflareAccess, bearerJwt } from "@gusto/baerly-storage/auth";

// Adapters
import { baerlyWorker, r2BindingStorage } from "@gusto/baerly-storage/cloudflare";
import {
  baerlyNode,
  s3Storage,
  r2Storage,
  minioStorage,
  gcsStorage,
} from "@gusto/baerly-storage/node";

// Dev helpers (Vite, local-fs storage)
import { baerlyDevAuth, loadDevVars } from "@gusto/baerly-storage/dev/vite";
import { LocalFsStorage } from "@gusto/baerly-storage/dev";
```

## `Db.create({ storage, app, tenant, config? })`

_When NOT to use: in a browser/SPA — use `createBaerlyClient` (HTTP) instead; `Db` is the in-process server surface._

One `Db` per `(app, tenant)` request. The constructor is private — always go through `Db.create`. Collections are auto-provisioned on first write (no `ensureCollection` step).

```ts
import { Db, MemoryStorage } from "@gusto/baerly-storage";
import config from "./baerly.config";

const db = Db.create({
  storage: new MemoryStorage(), // or `s3Storage(...)`, `r2BindingStorage(env.BUCKET)`, …
  app: "tickets",
  tenant: "acme-co",
  config, // ← optional. Wires schemas
  //   AND narrows `db.collection(name)` types.
});

await db.collection("tickets").insert({ title: "first ticket", status: "open" });
const open = await db.collection("tickets").where({ status: "open" }).all();
```

**`MemoryStorage` is per-instance.** Each `new MemoryStorage()` backs an independent in-process bucket — two `Db` instances built against two `new MemoryStorage()`s see two empty, isolated stores. This is what makes it the canonical test fixture: one fresh instance per test gives a hermetic bucket without `beforeEach` cleanup. Pass the _same_ `MemoryStorage` instance to multiple `Db` constructors when you want two writers contending on one bucket.

Full `Db.create` config:

```ts
Db.create<TConfig>({
  storage: Storage;              // required
  app: string;                   // required
  tenant: string;                // required
  config?: TConfig;              // optional; from `defineConfig(...)`
});
```

**`Db<typeof config>` is a usable type.** `Db.create({ ..., config })` returns `Db<typeof config>`, and that type is exported from the root barrel — so a test or DI helper can pin it without inferring through the factory call site:

```ts
import type { Db } from "@gusto/baerly-storage";
import type config from "./baerly.config";

let cached: Db<typeof config> | undefined;
export function setDbForTesting(db: Db<typeof config>) {
  cached = db;
}
```

The narrowed `Db<typeof config>` carries the same `collection(name)` overloads as the inferred return; `Db` (no parameter) widens to `Db<UnboundConfig>` and accepts any string collection name.

## `db.collection(name)` → `Collection<T>`

_When NOT to use: from the browser — call collection verbs over HTTP via `createBaerlyClient`._

`Collection<T>` carries the common-case verbs directly (collection-level reads plus by-primary-key mutations). Modifiers (`where`, `order`, `limit`) return a `Query<T>` for bulk-by-predicate work. Terminals fire I/O on the spot.

```ts
interface Collection<T extends DocumentData = DocumentData> {
  readonly name: string;
  // Reads — whole collection / by id. Every row carries a string `_id`.
  first(): Promise<(T & { _id: string }) | undefined>;
  all(): Promise<(T & { _id: string })[]>;
  count(): Promise<number>;
  get(id: string): Promise<(T & { _id: string }) | undefined>;
  // Modifiers — return Query<T>.
  where(predicate: PredicateArg<T>): Query<T>; // PredicateArg = Predicate<T> | (q => PredicateBuilder<T>)
  order(spec: OrderSpec<T>): Query<T>;
  limit(n: number): Query<T>;
  // Writes — by primary key.
  insert(doc: Partial<T> & DocumentData & { _id?: string }): Promise<{ _id: string }>;
  update(id: string, patch: MergePatch<T>): Promise<{ modified: number }>;
  replace(id: string, doc: T): Promise<void>;
  delete(id: string): Promise<{ deleted: number }>;
}
```

`Query<T>` keeps the chainable read terminals and the predicate-aware bulk mutation verbs:

```ts
interface Query<T> extends /* Collection<T>'s modifiers */ {
  first(): Promise<(T & { _id: string }) | undefined>;
  all(): Promise<(T & { _id: string })[]>;
  count(): Promise<number>;
  update(patch: MergePatch<T>): Promise<{ modified: number }>; // bulk
  delete(): Promise<{ deleted: number }>;                      // bulk
}
```

`replace` is by-id only — `Collection<T>.replace(id, doc)` throws `NotFound` on missing id. There is no predicate-form `.replace(doc)` on `Query<T>`: a strict-cardinality-1 verb is redundant ceremony to the by-id form (the public surface is additive-only locked, so a second type-valid path to one capability is redundancy).

### Predicates

Two shapes, both legal on `.where(...)`:

1. **Object literal** — equality only. Top-level, dotted-path, or nested literal sub-predicate. Multi-field is implicit AND.
2. **Callback DSL** — `q => q.eq(...).gt(...).gte(...).lt(...).lte(...).in(...)`. The methods on `PredicateBuilder<T>` ARE the supported operator vocabulary; methods absent from the type (`or`, `not`, `regex`, `ne`, `exists`) do not exist and won't typecheck.

Chained `.where(...).where(...)` AND-merges across calls and across shapes. Both forms normalise to one wire format (a flat clause list, `{ clauses: PredicateClause[] }`); the HTTP `?where=` param carries that wire JSON.

By-`_id` lookups go through `.get(id)` / `.update(id, patch)` / `.replace(id, doc)` / `.delete(id)`, **not** `.where({ _id: id })`. `_id` is excluded from `Path<T>` (and so from `PredicateBuilder<T>`), so `.where({ _id: ... })` is a compile-time TS error. Nested `_id` paths (`author._id`) on referenced documents are still allowed.

```ts
db.collection("tickets").where({ status: "open" }).all();
db.collection("tickets").where({ "assignee.team": "platform" }).all();
db.collection("tickets")
  .where((q) => q.gte("count", 1).lt("count", 10))
  .all();
db.collection("tickets")
  .where((q) => q.in("status", ["open", "pending"]))
  .all();
db.collection("tickets")
  .where({ status: "open" })
  .where((q) => q.gte("priority", 5))
  .all();
```

#### Wire format (`?where=`)

`PredicateWire` is the on-the-wire shape:

```ts
interface PredicateClause {
  readonly op: "eq" | "gt" | "gte" | "lt" | "lte" | "in";
  readonly field: string; // top-level or dotted path
  readonly value: DocumentValue | ReadonlyArray<DocumentValue>; // array iff op === "in"
}
interface PredicateWire {
  readonly clauses: ReadonlyArray<PredicateClause>;
}
```

Example: `.where({ status: "open" })` → `{"clauses":[{"op":"eq","field":"status","value":"open"}]}`. The empty wire `{"clauses":[]}` matches every document.

## Mutations

By-id (the common case) lives on `Collection<T>`; predicate-aware bulk verbs live on `Query<T>` after `.where(...)`.

```ts
await db.collection("tickets").insert({ status: "open", title: "ship it" });
// → { _id: "01HQ..." }  (UUIDv7; caller may supply `_id`)

// By-id (Collection<T>):
await db.collection("tickets").update("01HQ...", { status: "closed" });
// → { modified: 1 }  (JSON-merge-patch RFC 7386)
await db.collection("tickets").update("01HQ...", { note: null });
// `null` deletes an optional field; a required one is a TS error, use `replace`

await db.collection("tickets").replace("01HQ...", {
  _id: "01HQ...",
  status: "open",
  title: "rewrite",
});
// → void  (whole-document overwrite)

await db.collection("tickets").delete("01HQ...");
// → { deleted: 1 }  (or `{ deleted: 0 }` if the id is unknown)

// Bulk-by-predicate (Query<T>):
await db
  .collection("tickets")
  .where({ status: "open" })
  .update({ status: "closed", closed_at: new Date().toISOString() });
// → { modified: N }

await db.collection("tickets").where({ status: "closed" }).delete();
// → { deleted: N }
```

## `DocumentData` — row shape constraint

Every row type must satisfy `{ [k: string]: DocumentValue }` where `DocumentValue = string | number | boolean | DocumentData | Array<DocumentValue>`.

Note: `null` is not a stored value in the typed contract. In a JSON-merge-patch (RFC 7386) `update`, `null` is the field-deletion sentinel, so a stored `null` would collapse "this field is null" with "delete this field". `MergePatch<T>` admits `null` only on optional keys (a required nested object with a single object type takes a nested patch; an optional one takes its whole value or `null`; union-valued members take whole values; arrays replace whole); remove a required field with `replace`. Use `.optional()` in your schema for absent values. The runtime still stores a `null` that reaches `insert` / `replace` (RECIPES.md, TS2322).

Two ways to get a typed row:

1. **Bind the config** (preferred). Declare collection in `baerly.config.ts` with a schema; pass `config` to `Db.create` / `createBaerlyClient`. `db.collection("tickets")` returns `Collection<RowOf<TConfig, "tickets">>`. No generic, no cast.

   `RowOf<TConfig, "tickets">` is also a usable type when you need to name the row shape outside the chain — route-handler return types, response-schema bridges, helpers that take a row by hand:

   ```ts
   import type { RowOf } from "@gusto/baerly-storage";
   import type config from "./baerly.config";

   type Ticket = RowOf<typeof config, "tickets">;
   //   ^ `db.collection("tickets").all()` rows are `Ticket & { _id: string }`.
   //   `CollectionNames<typeof config>` is the union of valid names.
   ```

2. **Falls back to `DocumentData`** when no config is bound. Rows still carry a string `_id`, so `get` / `update` / `replace` / `delete` take `row._id` as-is (`for (const row of await notes.all()) await notes.delete(row._id)`). Cast at the construction site for a narrower row shape:
   ```ts
   import type { Collection, DocumentData } from "@gusto/baerly-storage";
   interface Bookmark extends DocumentData {
     _id: string;
     url: string;
   }
   const bookmarks = db.collection("bookmarks") as Collection<Bookmark>;
   await bookmarks.all();
   ```
   A plain `interface Bookmark { _id: string; url: string }` (no index signature) fails the `T extends DocumentData` constraint by design — the constraint keeps the row JSON-compatible.

## Errors

`BaerlyError` is the single error class. Discriminate by `code`, not `instanceof` (the code string survives realm boundaries):

```ts
try {
  await db.collection("tickets").insert({ _id: "t-1", title: "hi" });
} catch (err) {
  if (!(err instanceof BaerlyError)) throw err;
  if (err.code === "AmbiguousCommit") {
    // May have landed: re-read err._id before deciding.
  } else if (!err.retriable) throw err; // AlreadyExists: t-1 is taken
  // else WriteConflict / NetworkError: retry with bounded backoff
}
```

| `code`                   | HTTP | When                                             |
| ------------------------ | ---- | ------------------------------------------------ |
| `InvalidConfig`          | 400  | Bad input (bucket, predicate, doc > 1 MiB)       |
| `NetworkError`           | 502  | Transport (S3 5xx, retries exhausted)            |
| `AccessDenied`           | 403  | S3 403 or bucket policy denied                   |
| `InvalidResponse`        | 502  | Server returned unparseable body                 |
| `Internal`               | 500  | Invariant violation — file a bug                 |
| `SchemaError`            | 400  | Bad JSON shape, or bound schema rejected it      |
| `WriteConflict`          | 409  | Lost a write race; re-read, then retry           |
| `AlreadyExists`          | 409  | `insert` `_id` taken, or `restore` target exists |
| `AmbiguousCommit`        | 409  | Commit may be durable; outcome unresolved        |
| `CapacityExceeded`       | 409  | Too much work for one request on this host       |
| `MaintenancePending`     | 503  | Maintenance behind; wait `retryAfter` seconds    |
| `CursorExpired`          | 410  | `/v1/since` cursor dead; restart with `cursor=`  |
| `Unauthorized`           | 401  | Verifier returned no identity                    |
| `NotFound`               | 404  | Row by id not found                              |
| `PayloadTooLarge`        | 413  | Body > 1 MiB cap                                 |
| `UnsupportedMediaType`   | 415  | Write body not sent as `application/json`        |
| `UnsatisfiablePredicate` | 400  | Predicate contradicts itself (empty `in`, …)     |

Only `NetworkError`, `WriteConflict` and `MaintenancePending` are `retriable`. Recovery: [RECIPES.md](RECIPES.md#ambiguouscommit-recovery).

### Mapping errors to HTTP yourself

`baerlyWorker`, `baerlyNode`, and `createRouter` (from `@gusto/baerly-storage/http`) already translate `BaerlyError` → HTTP status + wire envelope per the table above. For an **embed-by-hand** router (your own Hono / Express / Fastify app calling `Db` directly), use `mapError` from the same subpath; it returns the envelope and status (set `Retry-After` from `envelope.error.retryAfter` yourself):

```ts
import { mapError } from "@gusto/baerly-storage/http";

app.post("/notes", async (c) => {
  try {
    const { _id } = await db.collection("notes").insert(await c.req.json());
    return c.json({ _id }, 201);
  } catch (err) {
    const { status, envelope } = mapError(err);
    return c.json(envelope, status);
  }
});
```

`mapError` accepts any thrown value. Caller-facing codes (`SchemaError`, `NotFound`, `PayloadTooLarge`, `CapacityExceeded`, `AlreadyExists`, predicate `InvalidConfig`) keep their message. Diagnostics (`Internal`, `NetworkError`, `InvalidResponse`, storage `AccessDenied` / `InvalidConfig`, `WriteConflict`) keep code/status/`retriable` with a generic wire message; the full error goes to observability. Other throws become `500 Internal`, message redacted. The status/envelope shape is locked.

To serve the whole `/v1/*` API from your own server behind your own auth, gate and mount path, see RECIPES.md, "Recipe — authoring a gated adapter".

## `defineConfig({ app, tenant, target, collections })`

Scaffold-aware: lives at `@gusto/baerly-storage/config`. Holds both deploy metadata (`app`, `tenant`, `target`, `domain`, `cloudflareAccess`, `requiredSecrets`, `observability`) AND the runtime schema map.

```ts
import { defineConfig } from "@gusto/baerly-storage/config";
import { z } from "zod";

const TicketSchema = z.object({
  _id: z.string(), // required — see callout below
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
      schema: TicketSchema, // StandardSchema v1
    },
  },
});
```

Schemas: any [StandardSchema v1](https://standardschema.dev) validator (Zod 3.24+, Valibot 0.36+, ArkType 2.0+). Validation runs on the post-image: `update` and `replace` see the full doc, not just the patch. Failures → `BaerlyError{code:"SchemaError", issues:[…]}`, mapped to HTTP 400. Validation is write-path only — reads, export, and replay never re-validate, so a schema change never retroactively rejects existing rows.

**Author `_id` as required, not `.optional()`.** The validator runs on the post-image — by the time it fires, the server has already filled in a UUIDv7 `_id` for inserts that omit it, so every row the validator sees has `_id` present. Declaring `_id: z.string()` (required) matches that runtime invariant. `Collection<T>.insert` still accepts a doc without `_id` (the public signature is `insert(doc: Partial<T> & DocumentData & { _id?: string })`), so authoring `_id` as required does not break the "omit and let the server mint it" path. Rows from reads carry `_id: string` either way; the win is on the named type: `RowOf<typeof config, "tickets">` then has `_id: string` (required), so route handlers and response schemas don't need a parallel "\_id-required" row type.

An insert that omits `_id` gets a minted UUIDv7 (sorts by mint time); there is no exported id generator. In-process `insert` mints in the kernel. `createBaerlyClient` mints in the SDK and sends `mintedId`, so its resends replay. A raw-HTTP `POST` without `doc._id` is minted by the server; resending it adds a second row. To reference a new row's id, write the parent first and use the returned `_id`; design cross-collection writes parent-first with cleanup.

Do not declare `indexes`: they are validated at `Db.create` but never speed up or change a read, which folds the whole snapshot and log, and change no storage call a write makes.

## `createBaerlyClient` (browser / Node HTTP client)

_When NOT to use: server-side in the same process as `Db` — call `Db`/`Collection` directly; the client is for out-of-process / browser callers._

```ts
import type config from "./baerly.config"; // type-only — server adapter stays out of the SPA bundle
const client = createBaerlyClient<typeof config>({
  baseUrl: "", // same-origin
  headers: { Authorization: "Bearer …" }, // wrap `fetch` for per-call refresh
  fetch: customFetcher, // optional Fetcher middleware
});

await client.collection("tickets").where({ status: "open" }).all();
```

`ClientCollection<T>` mirrors `Collection<T>` but every terminal accepts a trailing `TerminalOptions`:

```ts
interface TerminalOptions {
  signal?: AbortSignal; // cancels this specific request
}

await client.collection("tickets").all({ signal: ac.signal });
```

That extra options bag is the **only** API difference between `Collection<T>` and `ClientCollection<T>`. Same modifiers, same terminals, same predicates.

`onWarning(w)` gets server warnings on successful writes; see RECIPES.md, `CapacityExceeded`.

To log, trace or refresh auth on every request, wrap `fetch`; the client already retries (RECIPES.md, "Recipe — wrapping the client `fetch`").

## Long-poll: `/v1/since`

`GET /v1/since?collection=…&cursor=…` is the long-poll endpoint that streams mutations without WebSockets. The server holds the request open for ~25 s; if new log entries land in that window it flushes them immediately, otherwise it returns an empty batch.

```ts
// Wire shape (returned raw — not wrapped in HttpOkEnvelope):
interface SinceResponse {
  readonly events: ReadonlyArray<LogEntry>;
  readonly next_cursor: string;
}

interface LogEntry {
  readonly lsn: string; // opaque cursor; lex-asc, monotonic
  readonly commit_ts: string; // ISO-8601 ms
  readonly op: "I" | "U" | "D";
  readonly collection: string;
  readonly doc_id: string; // I/U/D only
  readonly after?: DocumentData; // I/U — post-image (Debezium's `after`)
  readonly session: string;
  readonly seq: number;
  // `before` / `key_old` / `origin` are optional; see `LogEntry` JSDoc.
}
```

**Cursor priming.** First call: pass `cursor=` (empty string). The server's fast path returns immediately _iff_ the log already has entries for this collection — you get `events: [...]` and an opaque `next_cursor`. **If the collection is empty, the first call blocks for the full long-poll budget (~25 s) before returning `events: []` and a new `next_cursor`.** Either prime by inserting one row first if you need an immediate response, or budget your client / test for the full timeout. Every later call passes the returned cursor back, even after an empty batch — treat it as an opaque string. An empty batch can still carry a new `next_cursor` (a position after changes already folded into the snapshot, or one that has learned the collection's generation), so always keep the returned cursor; `events` is empty when the budget elapsed with no new writes. A cursor survives log folds; it expires only when the client falls behind what the log retains.

**Test-mode tuning.** Vitest's default per-test timeout is 5 s; the long-poll's 25 s budget will dominate that. Shrink it on the worker factory under a test-only env switch:

```ts
export default baerlyWorker((env) => ({
  config,
  // Production: omit both (inherit 25 s / 1 s defaults).
  // Test: wire from miniflare bindings.
  sinceTimeoutMs: env.SINCE_TIMEOUT_MS,
  sincePollIntervalMs: env.SINCE_POLL_INTERVAL_MS,
}));
```

In `vitest.config.mts`'s miniflare bindings, set them as numbers (`SINCE_TIMEOUT_MS: 2000`, `SINCE_POLL_INTERVAL_MS: 50`) so the factory sees `number | undefined` without runtime coercion. Don't shrink `sinceTimeoutMs` in production code paths — it multiplies the R2 class-A op count per idle long-poll connection.

React apps use `@gusto/baerly-storage/client/react` (see next section) instead of poking `/v1/since` by hand; hand-rolled subscribers in other frameworks `fetch` it directly. The wire shape above is the public contract; there is no cursor-tailing helper.

**Handle `410 CursorExpired` or your loop will spin.** The cursor never works again: back off, re-read, then restart with `cursor=` (empty). Causes: RECIPES.md, `CursorExpired`.

## React: `createBaerlyReact`

`@gusto/baerly-storage/client/react` exports one factory, `createBaerlyReact<typeof config>()`. Call it once and export the result; it returns `{ BaerlyProvider, useQuery, useMutation, useBaerlyClient }` all bound to your config, so a `useQuery` / `useMutation` callback's `c.collection("notes")` infers the real row type — **no `as Promise<Note[]>` cast**. (React context can't carry a generic to the hooks; binding once at the factory is what threads it.) The provider owns a shared `/v1/since` long-poll per `(client, collection)`; idle cycles cost zero list reads, and any non-empty batch invalidates every `useQuery` whose chain touches the firing collection.

```ts
// src/web/client.ts — wire the client + bound hooks once.
import { createBaerlyClient } from "@gusto/baerly-storage/client";
import { createBaerlyReact } from "@gusto/baerly-storage/client/react";
import config from "../../baerly.config.ts";

export const client = createBaerlyClient({ baseUrl: "", config });
export const { BaerlyProvider, useQuery, useMutation } = createBaerlyReact<typeof config>();
```

```tsx
// Components import the bound hooks from your module, not the package.
import { BaerlyProvider, client, useMutation, useQuery } from "./client.ts";

// 1. Wrap your app once.
<BaerlyProvider client={client}>
  <App />
</BaerlyProvider>;

// 2. useQuery(cb, deps, options?) — inferred rows, live by default.
const result = useQuery((c) => c.collection("notes").all(), []);
// result has status, data/error, and a stable refetch().

// 3. live:false reads on mount, deps changes, and refetch—no /v1/since.
const report = useQuery((c) => c.collection("notes").all(), [reportDate], { live: false });

// 4. useQuery.skip — short-circuit to status: "skipped", no
//    subscription. Use for conditional or dependent reads.
const filtered = useQuery(
  (c) => (filter === "all" ? useQuery.skip : c.collection("notes").where({ status: filter }).all()),
  [filter],
);

// 5. useMutation() — returns [mutate, { isPending, error }].
//    Run any client call inside mutate; subscribed useQuery reads
//    re-run automatically once the long-poll sees the write.
const [mutate, { isPending, error }] = useMutation();
await mutate((c) => c.collection("notes").insert({ body }));
```

> No type parameter (`createBaerlyReact()`) gives an unbound surface — collection names widen to `string`, rows to `DocumentData` with a string `_id` — matching the in-process `Db.collection` fallback. There are no loose hooks to import directly: an unbound hook can't see the config, so binding at the factory is the only path.

## HTTP wire format

The JS SDK is the canonical path. Reach for `curl` only when debugging. Mutation bodies are wrapped and need `Content-Type: application/json` (else `415 UnsupportedMediaType`):

| Route                          | Body              | Response         |
| ------------------------------ | ----------------- | ---------------- |
| `POST   /v1/c/:collection`     | `{"doc":{...}}`   | `201 {_id}`      |
| `PATCH  /v1/c/:collection/:id` | `{"patch":{...}}` | `200 {modified}` |
| `PUT    /v1/c/:collection/:id` | `{"doc":{...}}`   | `200 {modified}` |
| `DELETE /v1/c/:collection/:id` | —                 | `204`            |

Reads (`GET /v1/c/:collection[/:id]`, `GET /v1/count?collection=…`, `GET /v1/since?collection=…&cursor=…`) take no body and return `{ data, _meta }` or a route-specific envelope. A flat `POST` body (no `doc` wrapper) returns `400 SchemaError "Request body must be { doc: object }"` — wording is locked by `assertJsonBodyField` in the kernel. `POST` accepts `"mintedId"` (UUIDv7 = `doc._id`): resends replay a matching live row, else `AlreadyExists`. Deletion permits reinsertion; each auto-ID `insert(doc)` mints anew. See RECIPES.md.

### Liveness probe (`GET /v1/healthz`)

`baerlyWorker` and `baerlyNode` both mount an anonymous `GET /v1/healthz` → `200 {"ok":true}`. It is checked **before** the verifier and observability, so it never 401s and never floods your logs — wire your platform's liveness/readiness probe straight to it. If your probe path is fixed to something else (a k8s readiness path, say), put a custom route in front of the kernel (see "Recipe — custom routes in front of `baerlyNode`" below).

### Machine contract (`GET /v1/spec`)

`baerlyWorker` and `baerlyNode` both mount an anonymous `GET /v1/spec` → the machine-readable contract IR (error codes + HTTP status, predicate operators, method/route tables) — the same data shipped as `dist/baerly.spec.json`. It runs the verifier tolerantly: an unauthenticated probe gets the static contract (no 401), and a request that the verifier accepts additionally gets a `collections` array of declared collection + index names.

### Read modifiers (query params)

`GET /v1/c/:collection` accepts three JSON-encoded query params; all are optional and compose:

| Param | Encodes | Wire example |
| --- | --- | --- |
| `?where=` | `PredicateWire` (see "Wire format" above) | `?where=%7B%22clauses%22%3A%5B%5D%7D` |
| `?order=` | `{ [field]: "asc" \| "desc" }` | `?order=%7B%22sent_at%22%3A%22desc%22%7D` |
| `?limit=` | bare integer (no JSON wrapper) | `?limit=50` |

`?order=` and `?where=` are JSON, **not** Rails-style `field:asc` — the kernel `JSON.parse`s them and returns `400 SchemaError` on a flat string. Always `encodeURIComponent(JSON.stringify(spec))`. The JS SDK (`createBaerlyClient`) and the React hooks build these for you; reach for raw URLs only when scripting or when porting another framework's client.

## Adapter factories

_On Cloudflare Workers use `r2BindingStorage(env.BUCKET)` (the R2 binding), NOT the S3-credentials factory — credential-based factories assume `fetch` + Node TLS, not the Workers runtime._

```ts
// Cloudflare Worker entry
import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";
export default baerlyWorker((env) => ({
  verifier: cloudflareAccess({ teamDomain, audienceTag }),
  // scheduled?: (controller, env, ctx) => …    // opt-in cron handler
}));

// Node listener entry (any host that runs `node server.js`).
// resolveStorageFromEnv() is the safe default selector: R2_ACCOUNT_ID → R2,
// BUCKET → S3, else local-fs (dev only). It REFUSES to start in a detected
// deployment with no bucket — never a silent in-memory/local-fs fallback,
// which is how hand-rolled selectors ship data loss to production.
// (assertStorageReachable(storage) adds an opt-in boot-time CAS probe.)
import { baerlyNode, resolveStorageFromEnv } from "@gusto/baerly-storage/node";
const { storage, label } = resolveStorageFromEnv();
baerlyNode({ storage, webRoot: "dist/client" }).listen(PORT); // webRoot optional

// Or select the store yourself (custom endpoint, MinIO, GCS, …):
import { s3Storage } from "@gusto/baerly-storage/node";
baerlyNode({
  storage: s3Storage({ bucket: "…", credentials: { … } }),
  verifier: bearerJwt({ jwks, issuer, audience }),
  webRoot: "dist/client",                         // optional SPA static-serve
}).listen(PORT);
```

**Single-tenant CF Access.** Vanilla CF Access JWTs carry `sub`/`email` but no `tenant` claim. Pin the tenant from env instead of a claim: `cloudflareAccess({ teamDomain, audienceTag, tenantPrefix: "main" })`. Same option is available on `bearerJwt`.

**Local dev (`wrangler dev`, no Vite).** Declare `auth: "none"` in `baerly.config.ts` for the dev posture — the adapter synthesizes a verifier that pins every request to `config.tenant` without consulting the `Authorization` header. Swap to `auth: "shared-secret"` (or pass a custom `Verifier` on the factory) when you're ready to gate by wire credentials. Production CF Worker recipes layer CF Access in front of the Worker route; the verifier reads the resulting JWT:

**`auth` is enforced only by `baerlyWorker` / `baerlyNode`** (the dev Vite plugin and `baerly doctor` also read it). They resolve the verifier (from `auth`, or the `verifier:` override) and run it before building the per-request `Db` and router. `createRouter` has no auth seam: it serves every request it receives as its `Db`'s tenant. If you call `Db` or `createRouter` yourself (server-internal jobs, your own router), `auth` is inert and your code must authenticate and pick the tenant; set `auth: "none"` to satisfy the required field.

```ts
// baerly.config.ts
import { defineConfig } from "@gusto/baerly-storage/config";
export default defineConfig({
  app: "tickets",
  tenant: "main",
  target: "cloudflare",
  auth: "none", // dev only — production swaps to "shared-secret" or a custom Verifier
  collections: {/* … */},
});

// src/server/index.ts
import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";
import config from "../../baerly.config.ts";
export default baerlyWorker(() => ({ config }));
```

`s3Storage` / `r2Storage` / `minioStorage` / `gcsStorage` from `@gusto/baerly-storage/node` are re-exports of one factory family — same shape (bucket + credentials), all hide their request signer (SigV4 for S3/R2/MinIO, GOOG4-HMAC for GCS) and XML parsing behind the package boundary. `credentials` takes static keys or an async provider (EKS, expiring, AWS SDK): RECIPES.md, "Recipe — storage credentials on Node".

### Verifier presets

`@gusto/baerly-storage/auth` ships three `Verifier` functions you can pass to `baerlyWorker({ verifier })` or `baerlyNode({ verifier })`. Each returns `VerifierResult | null` (null = 401 unauth; thrown `BaerlyError` = 500 operator fault — the dispatcher splits the codes deliberately so on-call paging targets operator faults only).

| Preset | Identity source | Tenant derivation |
| --- | --- | --- |
| `sharedSecret` | `Authorization: Bearer <secret>` with constant-time compare | `tenantPrefix:` option (single-tenant only) |
| `bearerJwt` | JWT over JWKS, `iss` + `aud` + required `exp` + `alg` allowlist | Configurable `tenantClaim` (default `"tenant"`) or fixed `tenantPrefix:` override |
| `cloudflareAccess` | `Cf-Access-Jwt-Assertion` header (thin shim over `bearerJwt`) | Same as `bearerJwt` |

```ts
import { sharedSecret, bearerJwt, cloudflareAccess } from "@gusto/baerly-storage/auth";
```

**`tenantPrefix:` (on `bearerJwt` and `cloudflareAccess`).** Pins every verified request to a fixed tenant, bypassing claim lookup. Use this in single-tenant deployments where the IdP doesn't ship a tenant claim — the default `tenantClaim: "tenant"` would 401 every request because vanilla CF Access JWTs carry only `sub`/`email`. Signature, audience, and expiry checks are still enforced; only tenant derivation is replaced.

**`tenantClaim:`** picks the tenant a request reads and writes, so name a claim only an IdP admin can set. A claim the user can edit (profile metadata, a self-service attribute) lets them pick their own tenant.

**Why a function and not a class?** The source repo's `docs/guide/auth.md` records the properties the shape upholds and the rejected alternatives (class hierarchy, middleware chain, closed enum, kernel-side composition).

## Observability

`baerlyWorker` and `baerlyNode` emit **one canonical log line per HTTP request** on stdout (default level `info`). Background work (compactor / GC / `runScheduledMaintenance`) emits a separate `unit_of_work: "maintenance"` line per tick. The Cloudflare adapter is JSON-only (Workers have no TTY); the Node adapter auto-selects a human-readable single-line shape when `process.stdout.isTTY === true`. Sinks plug in via `observability.sink` on the factory options.

```json
{
  "timestamp": "2026-05-12T17:42:11.823Z",
  "level": "info",
  "category": "baerly.http",
  "request_id": "0193b0a1-ff7a-7c44-b9d5-c3e91d8f3a01",
  "method": "POST",
  "path": "/v1/c/tickets",
  "status": 200,
  "duration_ms": 14.207,
  "outcome": "committed",
  "db.storage.class_a_ops_total": 3,
  "db.storage.class_b_ops_total": 1,
  "db.write.class_a_ops_per_logical_write_sum": 3
}
```

### Field reference

| Field | Meaning |
| --- | --- |
| `request_id` | Correlation key. Set from `X-Request-Id` when it is at most 128 characters of `[A-Za-z0-9_.:/+=@-]`, else minted fresh. |
| `method` / `path` / `status` | HTTP request line + response code. |
| `duration_ms` | `performance.now()` delta, monotonic wall-clock. |
| `outcome` | `"read"`/`"committed"` (<400), `"conflict"` (409), `"refused"` (capacity), `"error"`. |
| `db.storage.class_a_ops_total` | PUT + DELETE + LIST count. S3-pricing Class A — cost-dominant. |
| `db.storage.class_b_ops_total` | GET count. S3-pricing Class B. |
| `db.storage.<op>.calls_total` | Per-op breakdown for `get` / `put` / `delete` / `list`. |
| `db.storage.<op>.duration_ms_sum` / `_count` | Per-call duration histogram. |
| `db.write.class_a_ops_per_logical_write_*` | Writer's per-`commit()` Class-A-op count. |
| `db.r2.put.412_total` / `429_total` | CAS conflicts (412) and storage rate-limit hits (429). |
| `db.read.<unit>_total` | `decoded_entries` (snapshot rows + log entries), `live_documents`, `returned_rows`. |
| `error.code` / `error.message` / `error.stack` | Failure-path only. `error.code` is `BaerlyErrorCode`. |

Class-A / Class-B totals are the load-bearing fields — the cost model puts a per-request ceiling on Class-A ops and the canonical line is how you verify a deployed service stays under it.

### Log levels

| Level   | What lands                                                      |
| ------- | --------------------------------------------------------------- |
| `error` | `status >= 500` or an exception was thrown.                     |
| `warn`  | Adds 4xx canonical lines and explicit `warn` records.           |
| `info`  | Default. Adds 2xx canonical lines and lifecycle events.         |
| `debug` | Adds per-storage-op events. **High volume**; off in production. |

Set `LOG_LEVEL` env var or the typed `observability.level` factory option. Sink wiring (Workers Analytics Engine, OTel, Datadog) lives in the source repo's `docs/guide/observability.md`.

## Recipe — server-stamped trusted fields

Use this shape when a column must come from the verified identity rather than the client request body (`sender_sub` on chat messages, `owner_id` on user-owned rows, `created_by` on audit logs). The HTTP routes `baerlyWorker` mounts under `/v1/c/:collection` accept the doc verbatim from the request body — they don't read the verifier identity into the row. Stamp it yourself in a custom route, then block direct client writes to the same collection so a malicious client can't supply the field by hand.

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

The client reads via the normal `GET /v1/c/messages` route and tails via `GET /v1/since?collection=messages&cursor=…` — both still served by `inner`. Only writes go through `/api/messages`. Reads stay uncapped and tenant-wide — scope and clamp them in your route too (see RECIPES.md).

**Known limitations of this recipe.** The custom-route `Db.create` runs outside `baerlyWorker`'s request handling: its writes don't land in the canonical-line storage counters, run write-tick maintenance before the response instead of in `ctx.waitUntil`, and aren't budgeted against the subrequest limit (RECIPES.md, gated adapter). Worker reads always reach storage, so they see these writes. If you also need PATCH/PUT/DELETE on the same collection, repeat steps (1) and (2) for each verb.

## Recipe — custom routes in front of `baerlyNode`

`baerlyNode(...).listen(port)` is the shortcut for the common case: no custom routes, the kernel owns the whole port. It binds every interface; `.listen(port, { hostname: "127.0.0.1" })` binds loopback only. To put your own route in front of the kernel (a fixed-path health probe, a trusted-stamp write route à la the recipe above), grab the web-standard `fetch` handler off the handle instead of calling `.listen()`, and serve it yourself. `serve()` comes from the same `@hono/node-server` package `.listen()` uses internally — you're just taking ownership of the dispatch:

```ts
// src/server/index.ts
import { serve } from "@hono/node-server";
import { baerlyNode, s3Storage } from "@gusto/baerly-storage/node";
import config from "../../baerly.config.ts";

const inner = baerlyNode({
  config,
  storage: s3Storage(/* … */),
  webRoot: "dist/client", // still serves the SPA + /v1/* as usual
});

serve({
  port: Number(process.env["PORT"] ?? 8080),
  fetch: (req) =>
    new URL(req.url).pathname === "/health-check" ? Response.json({ ok: true }) : inner.fetch(req),
});
```

The handle's `fetch` is the documented embedding seam (it's also what the Vite dev middleware and tests consume) — there's no separate `createApp` to reach for. If you don't need a _custom_ probe path, skip all of this and point your platform at the built-in `GET /v1/healthz` (see above).

> **Monorepo note.** `@hono/node-server` (and its `hono` peer) ship as dependencies of the Node adapter, so the `serve` import resolves out of the box in a scaffolded app. In a monorepo that prunes unused peers (e.g. `yarn workspaces focus` in CI), add `@hono/node-server` to the app's own `dependencies` so the import survives the prune.

## Anti-patterns

A few that compile but are wrong (full list, keyed by the exact error string you see: `cat node_modules/@gusto/baerly-storage/dist/RECIPES.md`):

- Don't widen branded types (`UUID`, `ContentVersionId`) with `as string`.
- Don't put `SHARED_SECRET` in the SPA bundle — it's server-to-server only.

## Where to look next

- **A call you expected doesn't type-check?** The public surface is additive-only locked, but the rare breaking change carries an old→new migration in `dist/CHANGELOG.md` (`cat dist/CHANGELOG.md`). The `.d.ts` types are canonical; the changelog is the recovery path.
- Per-symbol JSDoc: read the `.d.ts` chunks in this directory (`db-*.d.ts`, `index-*.d.ts`, `client-*.d.ts`, …) — the bundler splits them; `cat dist/*.d.ts` gives the union.
- Theoretical foundations + cost model: the repository's `docs/` tree (`docs/about/`, `docs/spec/`).
- Common mistakes & recipes: `cat node_modules/@gusto/baerly-storage/dist/RECIPES.md`; deeper guides in the repo's `docs/guide/`.
