---
title: Cheat sheet
audience: integrator
summary: One-screen quick reference — verbs, modifiers, errors, and the HTTP wire. The thing to show someone in 30 seconds.
last-reviewed: 2026-06-13
tags: [quickref, integrator]
related: ["add-to-existing-cf-worker.md", "auth.md"]
---

# Cheat sheet

The fastest tour of the public surface. For the full reference (recipes,
adapter factories, observability fields) read
[`packages/server/API.md`](../../packages/server/API.md), published as
`node_modules/@gusto/baerly-storage/dist/API.md`.

## Define the backend

```ts
// baerly.config.ts
import { defineConfig } from "@gusto/baerly-storage/config";

export default defineConfig({
  app: "tickets",
  tenant: "main", // required: default tenant pin
  auth: "none", // required: "none" | "shared-secret" (custom verifiers go on the adapter factory's `verifier:`)
  collections: { tickets: {} }, // add a `schema:` to type + validate rows
  target: "cloudflare", // or "node"
});
```

## Verbs

`db.collection(name)` carries the common-case verbs directly.
`.where(...)` / `.order(...)` / `.limit(...)` return a `Query<T>` for
bulk-by-predicate work. Terminals fire I/O on the spot.

| Verb                 | On                 | Returns                                         |
| -------------------- | ------------------ | ----------------------------------------------- |
| `.first()`           | Collection / Query | `T \| undefined`                                |
| `.all()`             | Collection / Query | `T[]`                                           |
| `.count()`           | Collection / Query | `number`                                        |
| `.get(id)`           | Collection         | `T \| undefined`                                |
| `.insert(doc)`       | Collection         | `{ _id }` — UUIDv7; caller may supply `_id`     |
| `.update(id, patch)` | Collection         | `{ modified }` — JSON-merge-patch (RFC 7386)    |
| `.replace(id, doc)`  | Collection         | `void` — whole-doc overwrite; throws `NotFound` |
| `.delete(id)`        | Collection         | `{ deleted }`                                   |
| `.update(patch)`     | Query (bulk)       | `{ modified: N }`                               |
| `.delete()`          | Query (bulk)       | `{ deleted: N }`                                |

```ts
await db.collection("tickets").insert({ status: "open", title: "ship it" });
await db.collection("tickets").update("01HQ…", { status: "closed" });
await db.collection("tickets").where({ status: "open" }).all();
await db.collection("tickets").where({ status: "closed" }).delete(); // bulk
```

By-`_id` work goes through `.get/.update/.replace/.delete(id)`, **not**
`.where({ _id })` — `_id` is excluded from the predicate path and won't
typecheck.

## Modifiers (`.where(...)`)

Two shapes, both legal; chained `.where(...).where(...)` AND-merges.

```ts
.where({ status: "open" })                         // equality (implicit AND)
.where({ "assignee.team": "platform" })            // dotted path
.where(q => q.gte("count", 1).lt("count", 10))     // callback DSL
.where(q => q.in("status", ["open", "pending"]))
```

The `PredicateBuilder` vocabulary is exactly: `eq` `gt` `gte` `lt` `lte`
`in`. Anything else (`or`, `not`, `ne`, `regex`, `exists`) does not exist
and won't typecheck. Pair with `.order({ field: "asc" | "desc" })` and
`.limit(n)`.

## Errors

One class, `BaerlyError`. Discriminate by `.code` (survives realm
boundaries), never `instanceof` chains.

| `code`                   | HTTP | When                                                    |
| ------------------------ | ---- | ------------------------------------------------------- |
| `InvalidConfig`          | 400  | Bad config/input (bucket, malformed predicate)          |
| `SchemaError`            | 400  | JSON shape invalid or bound schema rejected the doc     |
| `Conflict`               | 409  | `insert` `_id` collision (duplicate `_id`)              |
| `Unauthorized`           | 401  | Verifier returned no identity                           |
| `AccessDenied`           | 403  | S3 403 or bucket policy denied                          |
| `NotFound`               | 404  | Row by id not found                                     |
| `PayloadTooLarge`        | 413  | Body > 1 MiB                                            |
| `UnsatisfiablePredicate` | 400  | Well-formed predicate that contradicts itself           |
| `NetworkError`           | 502  | Transport (S3 5xx, retries exhausted)                   |
| `InvalidResponse`        | 502  | Server returned unparseable body                        |
| `Internal`               | 500  | Invariant violation — file a bug                        |

## HTTP wire (reach for `curl` only when debugging)

| Route                                                | Body            | Response                                |
| ---------------------------------------------------- | --------------- | --------------------------------------- |
| `POST   /v1/c/:collection`                           | `{"doc":{…}}`   | `201 {_id}`                             |
| `PATCH  /v1/c/:collection/:id`                       | `{"patch":{…}}` | `200 {modified}`                        |
| `PUT    /v1/c/:collection/:id`                       | `{"doc":{…}}`   | `200 {modified}`                        |
| `DELETE /v1/c/:collection/:id`                       | —               | `204`                                   |
| `GET    /v1/c/:collection`                           | —               | `{ data, _meta }`                       |
| `GET    /v1/count?collection=<name>&where=<json>`    | —               | `{ data: { count }, _meta }`            |
| `GET    /v1/since?collection=<name>&cursor=<opaque>` | —               | `{ events, next_cursor }`               |
| `GET    /v1/healthz`                                 | —               | `200 {"ok":true}` (anonymous, pre-auth) |

Read modifiers are JSON-encoded query params on `GET /v1/c/:collection`,
all optional and composable — always
`encodeURIComponent(JSON.stringify(spec))`:

| Param     | Encodes                                                 |
| --------- | ------------------------------------------------------- |
| `?where=` | `PredicateWire` — `{ clauses: [{ op, field, value }] }` |
| `?order=` | `{ [field]: "asc" \| "desc" }`                          |
| `?limit=` | bare integer (no JSON wrapper)                          |

The JS SDK (`createBaerlyClient`) and the React hooks build these for
you; reach for raw URLs only when scripting.

## Where to look next

- Full API reference —
  [`packages/server/API.md`](../../packages/server/API.md), published
  as `node_modules/@gusto/baerly-storage/dist/API.md`
- [`add-to-existing-cf-worker.md`](add-to-existing-cf-worker.md) — bolt baerly-storage onto an existing Worker
- [`auth.md`](auth.md) — `config.auth` postures
- [`../../examples/`](../../examples) — runnable scaffolds
