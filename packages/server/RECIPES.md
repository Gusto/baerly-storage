# baerly-storage — common mistakes & recipes

> Companion to `dist/API.md`. API.md is the surface; this file is the "why did my call fail" lookup, keyed by the exact error string you see. If a fix here disagrees with the `.d.ts` types, the types win.

## Common mistakes (keyed by the error you see)

### `Request body must be { doc: object }` (HTTP 400, `code="SchemaError"`)

**Cause:** POSTed a flat document body to `/v1/c/<collection>`. **Fix:** Wrap it: `{ "doc": { ...yourFields } }`. The insert verb reads `body.doc`, not the body itself. Same pattern for PATCH (`patch:`) and PUT (`doc:`). The wire `resolution` says: `Send a JSON body shaped { "doc": { ... } } for POST/PUT, or { "patch": { ... } } for PATCH.`

### `BaerlyError code="SchemaError"` on insert/update/replace

**Cause:** the document failed schema validation (including a `null` your schema does not allow: `.optional()` rejects `null`), OR the body is not valid JSON / contains an array where `DocumentValue` is required. **Fix:** read `error.issues` (each `{ path, message }`) for the offending field path. Declare `_id: z.string()` (required) in your schema — the validator runs on the post-image, so optional `_id` is wrong.

### `Type 'null' is not assignable to type 'DocumentValue'` (TS2322)

**Cause:** `null` is not part of the typed document contract. `DocumentValue` excludes it, so `insert`, `replace` and `update` reject a `null` value at compile time, even on a collection whose schema uses `.nullable()` (the row type then admits `null`, the write types still do not).

The runtime is more permissive:

- `insert` and `replace` (in-process and over HTTP) store `null` at any depth as written, and reads return it. With a bound schema, the schema decides: `.optional()` rejects `null` with `SchemaError`, `.nullable()` accepts it.
- In an `update` patch, a `null` member deletes that field (RFC 7386). A patch object written under a field that is absent or not an object is stored as written, nulls included.
- A predicate cannot match `null`: `.where({ field: null })` throws `InvalidConfig`, and no other value matches a stored `null`.

**Fix:** model an absent value by omitting the field, with `.optional()` in the schema. To remove a field from a row, `replace` it without that field. Don't cast `null` past the types to store it: typed rows and predicates do not account for stored nulls.

### `Type 'Bookmark' does not satisfy the constraint 'DocumentData'` (TS2344)

**Cause:** a row type you wrote by hand for a collection the bound `config` does not declare is a plain `interface Bookmark { _id: string; url: string }`. It has no index signature, so it fails `T extends DocumentData`. The constraint is deliberate: it keeps a row JSON-compatible.

**Fix:** `extends DocumentData`, then cast the handle at the construction site. On the HTTP client, build an unbound client (no `config`, so collection names widen to `string` and rows are typed `DocumentData & { _id: string }`) and cast to `ClientCollection<T>`; on an unbound `Db` (no `config`; a config-bound `Db` rejects undeclared names at compile time), cast `db.collection(name)` to `Collection<T>`. The cast is for the typed fields: every read already types `_id` as a string, so `row._id` passes to `get` / `update` / `replace` / `delete` with or without it, and `T` need not declare `_id`.

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

For a collection declared in `config`, don't cast: pass `config` and name the row with `RowOf<typeof config, "notes">` (API.md, `DocumentData`).

### `BaerlyError code="WriteConflict"` (HTTP 409)

**Cause:** another write won a race this call needed to win, and the losing commit did not land. `retriable` is `true`. A bulk `.where(...).update()` / `.delete()` may have applied earlier rows; re-issuing the call is safe. **Fix:** re-read, re-apply, and retry with bounded backoff. The in-process writer makes one commit attempt and does not retry it (storage adapters retry individual requests); a remote client that sees `retriable: true` should apply its own bounded backoff.

### `BaerlyError code="AlreadyExists"` (HTTP 409)

**Cause:** a caller-supplied `_id` on `insert` is held by a live row (or `baerly admin restore` targeted an existing collection without `--force`). The first insert of an `_id` wins: of concurrent inserts of one `_id`, at most one commits and the others throw `AlreadyExists`, committing nothing (an identical `mintedId` resend replays instead; see the next section). `retriable` is `false`: never retry. **Fix:** choose a different `_id`, omit `_id` so baerly-storage can mint one, or change the stored row with `update` / `replace`. After a same-`_id` retry following `AmbiguousCommit`, the stored row may be your first attempt: re-read it instead (see below). The same holds for an insert that omitted `_id`: the client resends it under its minted `_id`, so this error can mean your first attempt landed and the row changed since. Re-read it; do not insert again without an `_id`, which mints a second row.

### `BaerlyError code="CapacityExceeded"` (HTTP 409)

**Cause:** the collection has reached the fold ceiling of the host serving the request (`E` rows or `C` snapshot bytes for its maintenance profile), so the write was refused and not committed. `retriable` is `false`. The refusal is recomputed on every request; nothing is stored. A batch `.where(...).update()` / `.delete()` is checked before its first row commits, and again at a row's commit if a concurrent write landed since; refused part-way, it keeps the rows it already committed. **Fix:** depends on the message.

- **Growth refused** (an insert, or an update that makes a row larger): deletes and same-size or shrinking updates still commit. Delete or shrink rows; once write-tick maintenance folds them, growth is accepted again.
- **Every write refused** ("no fold can make progress here"): the stored snapshot is already past this host's ceiling, typically after a larger host folded it, a pending insert cannot fold onto an `E`-row snapshot, or a fold pass's worth of pending changes in a row each leave the snapshot past the byte ceiling. The collection has outgrown this host: export it with `baerly admin dump`, or have the operator move it to a larger host. Reads within the read bounds keep working either way.
- **Request limit** ("does not fit in one request on this host"): the request ran out of storage calls, and the refused write sent nothing. A multi-row `update()` / `delete()` keeps the rows before the refused one; re-run it as a new request (it re-reads and re-matches), or narrow it with `where` / `limit` so each request does less.
- **Read refused** ("this read of collection ... was refused and returned no rows"): the read needs more work than one request does on this host. It returned no rows, never a truncated answer, and wrote nothing. `err.resolution` names the remedy for the bound it hit: narrow the predicate or add a limit, delete or shrink rows, or retry once maintenance has absorbed pending writes.

**Warned before it happens:** a write that leaves the collection at 90% or more of the limit succeeds with a `Baerly-Capacity-Warning` response header. `createBaerlyClient({ onWarning })` hands it to your callback as `{ code: "CapacityWarning", message, method, path }`; delete or shrink rows then, before writes start being refused. The write's result is unchanged and a throwing callback cannot fail it. Cross-origin, your CORS layer must list `Baerly-Capacity-Warning` in `Access-Control-Expose-Headers`.

### `BaerlyError code="MaintenancePending"` (HTTP 503, `Retry-After`)

**Cause:** the write would grow the collection past its host's fold ceiling until pending changes fold, and folding them makes room (typically after the collection moved from a host with a larger ceiling, with deletes still pending). The write ran one bounded fold and was refused without committing (a batch refused part-way keeps the rows it already committed). `retriable` is `true`. The refusal is recomputed on every request; nothing is stored. **Fix:** wait `err.retryAfter` seconds (the `Retry-After` header over HTTP), then repeat the call. Reads keep working. `createBaerlyClient` already does this on every verb: it resends the identical request (an auto-ID insert keeps its minted `_id`) up to 3 attempts in total, waiting each hint of at most 10 s, so the error reaches your code only once those run out. The React subscription poll waits at least `retryAfter` before re-polling. Resending is safe because the refusal committed nothing and each HTTP write is one row. In-process, a multi-row `update` refused part-way keeps the rows before it; re-running it is safe, since a merge patch re-applied to a row it already changed leaves that row as it is.

### `BaerlyError code="CursorExpired"` (HTTP 410)

**Cause:** a `/v1/since` cursor can no longer resume: the changes after it are no longer retained, or `baerly admin restore --force` truncated the generation it was minted in. `retriable` is `false`; the same cursor never succeeds again. A malformed cursor is `SchemaError` (400) instead. **Fix:** re-read the rows you show, then resume with `cursor=` (empty); the changes between the dead cursor and the restart are not replayed. Back off before the restart so a cursor that expires on every lap cannot become a hot loop. The React hooks do this for you.

### `_id must be in Unicode Normalization Form C` (HTTP 400, `code="InvalidConfig"`)

**Cause:** `insert`, `replace`, or `update` got an `_id` that is not NFC, such as `"cafe\u0301"` (NFD) instead of `"caf\u00e9"`. Each `_id` has one spelling, because R2 stores canonically-equivalent keys as one object. **Fix:** pass `id.normalize("NFC")`. A row an earlier release stored under a non-NFC `_id` still reads and deletes; to keep it writable, insert a copy under a fresh NFC id that is not canonically equivalent to the original (for example, omit `_id` for a UUID), then delete the original.

### `app`/`tenant`/`collection must be in Unicode Normalization Form C` (HTTP 400, `code="InvalidConfig"`)

**Cause:** `Db.create`, `db.collection`, or an HTTP route got an app, tenant, or collection name that is not NFC, such as `"cafe\u0301"` (NFD) instead of `"caf\u00e9"`. R2 stores canonically-equivalent keys as one object, so the two spellings would address one key prefix there and two elsewhere. **Fix:** pass `name.normalize("NFC")` for a new name. Data an earlier release stored under a non-NFC name is accessible through `baerly inspect`, `baerly export`, `baerly admin dump`, and `baerly admin fsck`. To keep it writable, dump it and restore it under an NFC name that is not canonically equivalent to the original, then point the app at the new name:

```sh
baerly admin dump --bucket=$B --app=app --tenant=t --collection=$'cafe\u0301' > rows.ndjson
baerly admin restore --bucket=$B --app=app --tenant=t --collection=$'caf\u00e9-v2' < rows.ndjson
```

The normalized original name is not a safe target: on R2 it addresses the legacy objects. Run `baerly admin fsck` first: it flags non-NFC names. `baerly admin dump` also flags non-NFC `_id`s and canonically-equivalent twin `_id`s, which restore refuses or which have only one NFC spelling; give each a fresh NFC `_id` in the NDJSON before restoring.

The alias guard checks stored collection names, not app or tenant identity. Normalized legacy app or tenant aliases can still read and modify the same data on R2; migrate those namespaces to fresh names instead of relying on refusal.

### `collection ... addresses data stored under the canonically-equivalent name ...` (HTTP 400, `code="InvalidConfig"`)

**Cause:** on R2, this NFC collection name addresses objects an earlier release wrote under a non-NFC spelling of the same name. Reads, writes, folds, and exports refuse rather than skip those rows. **Fix:** keep the app on a different NFC name. Dump the data under the stored spelling (`baerly admin dump --collection=<stored name>`) and restore it under an NFC name that is not canonically equivalent to either spelling, as in the entry above.

If the log contains both spellings, stop writes and maintenance and keep a copy of the source bucket. Use `baerly admin dump --recover-legacy-names --collection=<exact stored name>` with the same bucket, app, and tenant flags to recover each spelling separately into different fresh collections. Recovery keeps rows, updates, and deletes separate even when `_id`s overlap. It requires a snapshot naming the selected spelling or no snapshot; an opposite-spelling snapshot is refused. Rows discarded by older compaction cannot be reconstructed, so historical completeness is not guaranteed.

### Resending an auto-ID insert over HTTP (`mintedId`)

**Cause:** an HTTP client minted the insert's `_id` and resent the insert after losing the first response. Without a signal the resend is a caller-supplied duplicate and gets `409 AlreadyExists`, though the row is the client's own. **Fix:** send the minted id in both places, `{ "doc": { "_id": m, ... }, "mintedId": m }`. A resend that finds a live row for `m` holding the same document (key order ignored) returns the original `201 { "_id": m }` and commits nothing; a different current body gets `409 AlreadyExists`. Deletion permits reinsertion; updating back to the original body permits replay. Calling `insert(doc)` again is a new operation and mints a new auto-ID, rather than retransmitting the constructed request. `mintedId` must be a canonical UUIDv7 equal to `doc._id`, else `400 SchemaError`, so a human-chosen id like `"migration-x"` cannot opt in. Leave `mintedId` out whenever you chose the `_id`: an insert without it keeps strict `AlreadyExists` on any live row, even an identical one, which is what makes `insert({ _id: "migration-x", done: true })` a run-once guard with a single winner. A server that predates the field reads only `doc` and answers the resend `409`, never with a second row. In-process `Collection.insert` takes no such flag. A minted replay is an equality oracle: anyone who can insert into the collection learns whether the row stored under an `_id` equals the body they sent (`201`) or not (`409`).

### AmbiguousCommit recovery

`AmbiguousCommit` (HTTP 409) means a committing create may be durable, but its outcome could not be resolved. It is not retriable by default. `err._id` names the affected row, including the id an auto-ID insert minted. Re-read that row and compare it with the intended state. A matching row can help reconcile the outcome; absence does not prove failure, because a send may still complete or a later write may have superseded it.

```ts
const tickets = db.collection("tickets");
try {
  await tickets.insert({ title: "hi" });
} catch (err) {
  if (!(err instanceof BaerlyError) || err.code !== "AmbiguousCommit" || !err._id) {
    throw err;
  }
  if ((await tickets.get(err._id)) === undefined) {
    // The same `_id` targets the same row, never a second document.
    await tickets.insert({ _id: err._id, title: "hi" }).catch((retryErr: unknown) => {
      // `AlreadyExists`: the first attempt landed after the re-read;
      // re-read and compare rather than inserting under a new `_id`.
      if (!(retryErr instanceof BaerlyError) || retryErr.code !== "AlreadyExists") {
        throw retryErr;
      }
    });
  }
}
```

Retrying is an explicit at-least-once choice and may repeat logical work: a same-`_id` insert retry targets one row and commits only while no live row holds that `_id`, but a retried `update` or `replace` can still overwrite a concurrent change to it. For bulk mutations, rows before the ambiguous row are already applied and `err._id` names the ambiguous one, but no partial-progress count is returned; inspect the affected rows before deciding whether to resume.

### `db.collection(name).insertOne(...)` / `.find(...)` is not a function

**Cause:** Mongo muscle memory. No such method. **Fix:** `db.collection(name).insert(row)` and `.where({ field: value }).all()` / `.where(q => q.gte("count", 1)).all()`.

### `.useIndex(...)` / `.hint(...)` is not a function

**Cause:** SQL/ORM muscle memory. No such method. **Fix:** use `.where(...)` directly. Reads always fold the authoritative snapshot and log; declared `indexes` do not change how a read runs.

### `compact` / `runGc` / `CLOUDFLARE_FREE_TIER` is not exported from `/maintenance`

**Cause:** `@gusto/baerly-storage/maintenance` exports one function, `runScheduledMaintenance`, addressed by collection. Its phases, host tiers and `current.json` keys are internal. **Fix:** `runScheduledMaintenance({ storage, app, tenant, collection }, { tier })`, `tier` being the `BAERLY_MAINTENANCE_PROFILE` value (`"cf-free"`, `"cf-paid"`, or the unbounded default `"node"`). A schedule is optional: every write already runs bounded maintenance.

### `BaerlyError code="InvalidConfig"` — `baerly: no auth configured`

**Full message:** `baerly: no auth configured. Set \`auth\` in baerly.config.ts ("none", "shared-secret") or pass \`verifier\` on the adapter factory.`

**Cause:** the adapter resolved no `Verifier`. **Fix:** set `auth` in `baerly.config.ts` (`"none"` or `"shared-secret"`) or pass `verifier:` on the adapter factory.

### `BaerlyError code="InvalidConfig"` — `SHARED_SECRET env is empty/unset`

**Full message:** `baerly: auth="shared-secret" but SHARED_SECRET env is empty/unset. Cloudflare: \`wrangler secret put SHARED_SECRET\`, or add to .dev.vars for local dev. Node: set in process env.`

**Cause:** `auth: "shared-secret"` was set but the `SHARED_SECRET` environment variable is missing or empty at startup. **Fix:** set the `SHARED_SECRET` env (`wrangler secret put SHARED_SECRET` on Cloudflare, `.dev.vars` for local dev, process env on Node).

### `BaerlyError code="InvalidConfig"` — `Refusing to start: no durable storage configured` / `Refusing to use in-memory storage`

**Cause:** a deployed process (`NODE_ENV=production` or a known PaaS marker) reached storage selection with no real bucket configured — or constructed `MemoryStorage` there. In-memory "succeeds" into RAM and vanishes on every restart; local-fs is single-process with no cross-process CAS. Both are refused in a deployment so the failure is loud at boot, not silent data loss in production. **Fix:** don't hand-roll storage selection — call `resolveStorageFromEnv()` from `@gusto/baerly-storage/node` (`R2_ACCOUNT_ID` → R2, `BUCKET` → S3, else local-fs in dev) and configure a bucket: `BUCKET` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (add `R2_ACCOUNT_ID` for R2). To catch an unreachable or CAS-broken bucket at boot rather than on the first write, `await assertStorageReachable(storage)`. Intentionally ephemeral (a throwaway demo)? Opt in explicitly: `new MemoryStorage({ ephemeral: true })` or `BAERLY_ALLOW_EPHEMERAL_STORAGE=true`.

### `BaerlyError code="UseQueryAwaitedRecorder"`

**Cause:** awaited a terminal (`.get`/`.first`/`.all`/`.count`) inside a `useQuery` callback. The recorder is synchronous; awaiting it yields a sentinel and the next property access throws. **Fix:** don't `await` in `useQuery` — for compound reads use `Promise.all` (parallel) or compose two `useQuery` calls with `useQuery.skip` (dependent). For writes use `useMutation()`.

### `BaerlyError code="UnexpectedWriteInQuery"`

**Cause:** called a write verb (`insert`/`update`/`replace`/`delete`) inside a `useQuery` callback. **Fix:** reads go in `useQuery`, writes go in `useMutation()`.

## Anti-patterns (compile-clean but wrong)

- Don't reach into `node_modules/@gusto/baerly-storage/dist/` at runtime — consume the published exports.
- Don't widen branded types (`UUID`, `ContentVersionId`) with `as string`.
- Don't put `SHARED_SECRET` in the SPA bundle — it is server-to-server only.
- Don't mutate `VerifierResult.tenantPrefix` between the verifier and `Db.create` — the dispatcher pins the tenant from the verifier's return.
- `z.string().nullable()` in a schema: the runtime stores the `null`, but the typed write contract excludes it (`DocumentValue` has no `null`). Use `.optional()`; see the TS2322 entry above.
- Raw SQL / `WHERE` clauses / hand-built query AST — the only query surface is the `.where(...)` method chain.
- Paging or cursor-iterating `.all()`: there is no offset, page or cursor API. Bound every read instead: scope it with `.where(...)` and cap it with `.limit(n)` (plus `.order(...)` for a stable top N). Each read still folds the whole collection, so a limit caps the rows returned, not the work done. Under `baerlyWorker`, a read that needs more work than one request allows is refused with `CapacityExceeded` (see above); other hosts do not bound reads.
- Relying on baerly to cap or scope a read. `GET /v1/c/:collection` (and `.all()`) returns the **whole collection** — there is no default row cap, and auth pins a tenant, not a row owner. Scope non-owner reads in your own route: inject a `where owner_id = <verified id>` predicate and clamp `limit = min(requested ?? MAX, MAX)`. Rejecting `?limit` backfires — it forces the uncapped path. See `docs/guide/auth.md` § Authorization Boundary.

## Recipe — authoring a gated adapter

Use this shape to serve the `/v1/*` API from your own server, under your own path, behind your own policy: `createRouter` from `@gusto/baerly-storage/http` does the routing, and your code does everything in front of it. `createRouter` has no auth seam. It serves every request it receives as the tenant of the `Db` you hand it, so the order is fixed:

1. Authenticate first, with a preset `Verifier` from `@gusto/baerly-storage/auth` or your own.
2. Take the tenant from the verified identity (`tenantPrefix`), never from the URL, a header or the body.
3. Apply your own gate (roles, collection allow-lists) before any `Db` work.
4. Build a fresh `Db` per request with `Db.create({ storage, app, tenant, config })`.
5. Strip your mount prefix: the router matches `/v1/...` paths.

```ts
// src/server/db-route.ts — serves /db/v1/* behind a JWT and a role check.
import { BaerlyError, Db } from "@gusto/baerly-storage";
import { bearerJwt } from "@gusto/baerly-storage/auth";
import { createRouter, mapError } from "@gusto/baerly-storage/http";
import { resolveStorageFromEnv } from "@gusto/baerly-storage/node";
import config from "../../baerly.config.ts";

const PREFIX = "/db";
const { storage } = resolveStorageFromEnv();
const verifier = bearerJwt({
  jwks: "https://login.example.com/.well-known/jwks.json",
  issuer: "https://login.example.com/",
  audience: "https://api.example.com/",
});

export async function handleDb(req: Request): Promise<Response> {
  try {
    const verified = await verifier(req); // (1) authenticate first
    if (verified === null) throw new BaerlyError("Unauthorized", "Missing or invalid token");
    const roles = (verified.identity as { roles?: unknown }).roles; // unverified shape
    if (req.method !== "GET" && !(Array.isArray(roles) && roles.includes("editor"))) {
      throw new BaerlyError("AccessDenied", "Writes need the editor role"); // (3) → 403
    }
    const db = Db.create({ storage, app: config.app, tenant: verified.tenantPrefix, config }); // (2, 4)
    const url = new URL(req.url);
    url.pathname = url.pathname.slice(PREFIX.length); // (5) /db/v1/c/notes → /v1/c/notes
    return await createRouter({ db }).fetch(new Request(url, req));
  } catch (err) {
    const { status, envelope } = mapError(err); // verifier and Db.create throws
    return Response.json(envelope, { status });
  }
}
```

Dispatch only `/db/*` requests to `handleDb`. The router maps its own errors to the wire envelope (with `Retry-After` on `MaintenancePending`); the `catch` covers what runs before it. `mapError` sends `AccessDenied` with a generic message. On Workers, build the storage inside `fetch` with `r2BindingStorage(env.BUCKET)` instead of `resolveStorageFromEnv()`. Authentication picks a tenant, not a row owner; scope reads in the gate too (see [Anti-patterns](#anti-patterns-compile-clean-but-wrong), "Relying on baerly to cap or scope a read").

**What the stock adapters add.** `baerlyWorker` and `baerlyNode` do more than run the verifier: they serve `/v1/healthz` and `/v1/spec`, emit the canonical log line, and select the host's maintenance profile. A bare `createRouter` still runs write-tick maintenance on writes, but under the default profile, the smallest one, on every host: its fold ceilings are the Workers Free ones, so a collection refuses growth with `CapacityExceeded` sooner than under `baerlyNode`. It does not read the operator's maintenance settings, and on Workers it folds before the response rather than in `ctx.waitUntil`, and neither budgets storage calls against the invocation's subrequest limit nor bounds reads. When you need that behavior, keep the stock adapter and gate in front of it: pass your policy as its `verifier`, or check the request and strip your prefix before delegating, to `baerlyNode(...).fetch(req)` on Node (see API.md, "Recipe — custom routes in front of `baerlyNode`") or `baerlyWorker(...).fetch(req, env, ctx)` on Workers (see API.md, "Recipe — server-stamped trusted fields").

## Recipe — storage credentials on Node

The Node storage factories (`s3Storage`, `r2Storage`, `minioStorage`, `gcsStorage` from `@gusto/baerly-storage/node`) take one `credentials` field: either a static `Credentials` object or a `CredentialsProvider`, an async function returning one. On Workers, use the R2 binding (`r2BindingStorage(env.BUCKET)`) instead; it needs no credentials.

```ts
type Credentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date; // absent ⇒ static
};
type CredentialsProvider = () => Promise<Credentials>;
```

`gcsStorage` signs GOOG4-HMAC-SHA256 with a GCS HMAC key (Cloud Console → Cloud Storage → Settings → Interoperability): pass the access ID as `accessKeyId` and the secret as `secretAccessKey`. Service-account keys, OAuth and ADC are not supported.

### Static credentials

```ts
import { s3Storage } from "@gusto/baerly-storage/node";

export const storage = s3Storage({
  region: process.env["AWS_REGION"] ?? "us-east-1",
  bucket: process.env["BUCKET"]!,
  credentials: {
    accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
    secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
  },
});
```

`resolveStorageFromEnv()` builds the same thing from `BUCKET` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (plus `R2_ACCOUNT_ID` for R2); use a factory directly when you need a provider below.

### Expiration and refresh

A provider is called on the first signed request. The signer caches what it returns until five minutes before `expiration`, then calls the provider again; concurrent requests share one in-flight call, and a rejected call is retried on the next request. A result without `expiration` is cached for the life of the storage handle, so a provider of rotating credentials must return the credentials' real `expiration` on every result; otherwise storage requests start failing once the first credentials expire.

### EKS: `fromEks()`

```ts
import { fromEks, s3Storage } from "@gusto/baerly-storage/node";

export const storage = s3Storage({
  region: process.env["AWS_REGION"] ?? "us-east-1",
  bucket: process.env["BUCKET"]!,
  credentials: fromEks(),
});
```

`fromEks()` checks the environment on every call: EKS Pod Identity when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set (it also reads the token file named by `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`), else IRSA when `AWS_WEB_IDENTITY_TOKEN_FILE` is set (it also needs `AWS_ROLE_ARN`, exchanges the token with STS `AssumeRoleWithWebIdentity`, and honors `AWS_ROLE_SESSION_NAME` and `AWS_REGION` / `AWS_DEFAULT_REGION`), else it throws `InvalidConfig`. To pin one mechanism, use `fromEksPodIdentity()` or `fromWebIdentity()` from the same subpath. All three return `expiration`, so refresh is automatic.

### Your own provider

```ts
import { type CredentialsProvider, s3Storage } from "@gusto/baerly-storage/node";

// Stand-in for your secrets store; it must report when the credentials expire.
declare function fetchFromVault(): Promise<{
  id: string;
  secret: string;
  token: string;
  expiresAt: string;
}>;

const fromVault: CredentialsProvider = async () => {
  const s = await fetchFromVault();
  return {
    accessKeyId: s.id,
    secretAccessKey: s.secret,
    sessionToken: s.token,
    expiration: new Date(s.expiresAt),
  };
};

export const storage = s3Storage({
  region: "us-east-1",
  bucket: "my-bucket",
  credentials: fromVault,
});
```

### AWS SDK credential providers

The `Credentials` shape matches the AWS SDK's `AwsCredentialIdentity`, so any provider from `@aws-sdk/credential-providers` (ECS task roles, EC2 instance metadata, SSO, `~/.aws/config` profiles, the default Node chain) passes through unchanged, `expiration` included. baerly-storage does not depend on the AWS SDK; add `@aws-sdk/credential-providers` to your app when you need one.

```ts
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { s3Storage } from "@gusto/baerly-storage/node";

export const storage = s3Storage({
  region: process.env["AWS_REGION"] ?? "us-east-1",
  bucket: process.env["BUCKET"]!,
  credentials: fromNodeProviderChain(),
});
```

## Recipe — wrapping the client `fetch`

`createBaerlyClient({ fetch: customFetcher })` is the one composable seam for cross-cutting HTTP concerns: logging, tracing, auth refresh. The `Fetcher` type, exported from `@gusto/baerly-storage/client`, is `(req: Request) => Promise<Response>`.

Wrappers compose as ordinary JavaScript functions: outermost sees the request first and the response last; innermost is closest to the network.

### Hook callbacks (success / error)

```ts
import { createBaerlyClient, type Fetcher } from "@gusto/baerly-storage/client";

const withHooks =
  (
    next: Fetcher,
    onSuccess: (req: Request, res: Response) => void,
    onError: (req: Request, err: unknown) => void,
  ): Fetcher =>
  async (req) => {
    try {
      const res = await next(req);
      onSuccess(req, res);
      return res;
    } catch (err) {
      onError(req, err);
      throw err;
    }
  };

export const client = createBaerlyClient({
  baseUrl: "https://api.example.com",
  fetch: withHooks(
    (req) => globalThis.fetch(req),
    (req, res) => console.info({ url: req.url, status: res.status }),
    (req, err) => console.error({ url: req.url, err }),
  ),
});
```

`onSuccess` fires for **any** HTTP response that completes — 4xx and 5xx included, because those are not thrown exceptions. Branch on `res.ok` if you want "2xx only."

### Retries are built in

Don't add a retry wrapper. The client calls `fetch` once per attempt, so a wrapper that retries multiplies the client's own attempts. The client already makes up to 3 attempts, with jittered backoff or the server's `Retry-After`:

- `GET` requests and auto-ID inserts are resent after a transport failure: a thrown `fetch`, or a 5xx, 408 or 429 response with no error envelope (a proxy or CDN answering for the server). An auto-ID insert keeps its minted `_id`, so a resend replays the first commit instead of adding a row.
- Every verb is resent after `MaintenancePending` (503), waiting its `retryAfter`.
- An enveloped `NetworkError` (502) is not resent: the server's storage adapter already retried it.

Other writes (an insert with your own `_id`, `update`, `replace`, `delete`) are sent once on a transport failure, because the first attempt may have committed. Decide at the call site whether to repeat one; an `AmbiguousCommit` needs a re-read first (see [AmbiguousCommit recovery](#ambiguouscommit-recovery)). Pass `opts.signal` to bound how long a call, retries included, may take.

### Refresh credentials on 401

```ts
import type { Fetcher } from "@gusto/baerly-storage/client";

export const withAuthRefresh =
  (next: Fetcher, refresh: () => Promise<string>): Fetcher =>
  async (req) => {
    const res = await next(req.clone());
    if (res.status !== 401) return res;
    const token = await refresh();
    const retried = new Request(req, {
      headers: new Headers({
        ...Object.fromEntries(req.headers),
        Authorization: `Bearer ${token}`,
      }),
    });
    return next(retried);
  };
```

If the refreshed call also returns 401, the wrapper returns that response unchanged — no second retry, avoiding an infinite refresh loop on a stale/revoked token. Wire sign-out / re-auth-prompt into the caller, not into this wrapper. The `req.clone()` is required because a `Request` body is a one-shot stream.

### Long-poll calls (`GET /v1/since`)

The long-poll path routes through the same `Fetcher`. Logging and auth-refresh wrappers apply uniformly. If a wrapper needs to distinguish long-poll from one-shot reads, inspect `req.url` for `/v1/since`. Most wrappers don't need to.

### Composition order

The outer wrapper sees what the inner one does: `withHooks(withAuthRefresh(fetch, refresh), …)` observes only the final response of a refreshed call, while `withAuthRefresh(withHooks(fetch, …), refresh)` observes both the 401 and the retried call. Pick by what you want to observe.

## Recipe — scheduled maintenance

Maintenance is automatic and write-triggered, with no cron, sidecar, scheduler, timer, lock or app-config knob, identically on every host. Every write runs a bounded GC slice inline plus a go/no-go compaction fold bounded by a fold-size ceiling whose default is safe on every tier. A size-ratio threshold means idle buckets pay nothing. Concurrent folds are safe without coordination: the commit is a compare-and-swap, so a fold that loses to a concurrent write is discarded and its leftover swept by GC. On Cloudflare the fold is deferred past the response via `ctx.waitUntil`; everywhere else it runs inline. **Reads are pure**: they never run maintenance, so the published idle-reader cost bound holds.

A bucket maintains itself as long as it takes writes. A bucket served read-only does not auto-compact and pays a small, bounded replay: fine at small scale, a signal to graduate once a collection is large. The repository's `docs/spec/scale-ceilings.md` owns the per-tier envelope and `docs/about/graduation.md` the `BAERLY_MAINTENANCE_*` operator env vars (you almost never need them).

A schedule is optional. To also run maintenance on one (useful for a collection served mostly read-only), call `runScheduledMaintenance` once per collection. `tier` is the `BAERLY_MAINTENANCE_PROFILE` value: `"cf-free"` or `"cf-paid"` caps the pass to fit one Workers invocation on that plan, and `"node"` (the default) is unbounded. Run one collection per Cloudflare invocation: shard the schedule or persist a collection cursor instead of looping tenants or collections.

```ts
import { runScheduledMaintenance } from "@gusto/baerly-storage/maintenance";

const target = { storage, app, tenant, collection: "notes" };
const res = await runScheduledMaintenance(target); // Node
// res: { folded, deferred?: { reason }, gcDeleted, pending }
await runScheduledMaintenance(target, { tier: "cf-paid" }); // a Workers Paid cron
```

One whole pass fits an invocation on Workers Free with the R2 binding and on Workers Paid. S3 storage on Workers needs Paid with `BAERLY_MAINTENANCE_PROFILE=cf-paid`.

Node and Cloudflare Paid scheduled passes fold any pending write, so repeated passes drain a low-write collection to zero. Cloudflare Free folds only when at least 20 entries are pending, one 20-entry slice per pass; a remaining tail of 1–19 entries stays unfolded until more writes arrive.

## Where to look next

- Public API surface: `dist/API.md` (`cat node_modules/@gusto/baerly-storage/dist/API.md`).
- Per-symbol types: the `dist/*.d.ts` chunks.
- A remembered call no longer type-checks: `dist/CHANGELOG.md`.
