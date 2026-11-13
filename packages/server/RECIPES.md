# baerly-storage — common mistakes & recipes

> Companion to `dist/API.md`. API.md is the surface; this file is the
> "why did my call fail" lookup, keyed by the exact error string you
> see. If a fix here disagrees with the `.d.ts` types, the types win.

## Common mistakes (keyed by the error you see)

### `Request body must be { doc: object }` (HTTP 400, `code="SchemaError"`)

**Cause:** POSTed a flat document body to `/v1/c/<collection>`.
**Fix:** Wrap it: `{ "doc": { ...yourFields } }`. The insert verb reads
`body.doc`, not the body itself. Same pattern for PATCH (`patch:`) and
PUT (`doc:`).
The wire `resolution` says: `Send a JSON body shaped { "doc": { ... } } for POST/PUT, or { "patch": { ... } } for PATCH.`

### `BaerlyError code="SchemaError"` on insert/update/replace

**Cause:** the document failed schema validation, OR the body is not
valid JSON / contains an array where `DocumentValue` is required, OR a
`null` field value (use `.optional()`; `null` in an *update patch* is the
RFC 7386 deletion sentinel, not a storable value).
**Fix:** read `error.issues` (each `{ path, message }`) for the offending
field path. Declare `_id: z.string()` (required) in your schema — the
validator runs on the post-image, so optional `_id` is wrong.

### `BaerlyError code="WriteConflict"` (HTTP 409)

**Cause:** another write won a race this call needed to win, and the losing
commit did not land. `retriable` is `true`. A bulk `.where(...).update()` /
`.delete()` may have applied earlier rows; re-issuing the call is safe.
**Fix:** re-read, re-apply, and retry with bounded backoff. The in-process
writer makes one commit attempt and does not retry it (storage adapters retry
individual requests); a remote client that sees `retriable: true` should apply
its own bounded backoff.

### `BaerlyError code="AlreadyExists"` (HTTP 409)

**Cause:** a caller-supplied `_id` on `insert` is held by a live row (or
`baerly admin restore` targeted an existing collection without `--force`).
The first insert of an `_id` wins: of concurrent inserts of one `_id`,
at most one commits and the others throw `AlreadyExists`, committing nothing
(an identical `mintedId` resend replays instead; see the next section).
`retriable` is `false`: never retry.
**Fix:** choose a different `_id`, omit `_id` so baerly-storage can mint one,
or change the stored row with `update` / `replace`. After a same-`_id` retry
following `AmbiguousCommit`, the stored row may be your first attempt: re-read
it instead (see below).

### `BaerlyError code="CapacityExceeded"` (HTTP 409)

**Cause:** the collection has reached the fold ceiling of the host serving the
request (`E` rows or `C` snapshot bytes for its maintenance profile), so the
write was refused and not committed. `retriable` is `false`. The refusal is
recomputed on every request; nothing is stored. A batch
`.where(...).update()` / `.delete()` is checked before its first row commits,
and again at a row's commit if a concurrent write landed since; refused
part-way, it keeps the rows it already committed.
**Fix:** depends on the message.

- **Growth refused** (an insert, or an update that makes a row larger): deletes
  and same-size or shrinking updates still commit. Delete or shrink rows; once
  write-tick maintenance folds them, growth is accepted again.
- **Every write refused** ("no fold can make progress here"): the stored
  snapshot is already past this host's ceiling, typically after a larger host
  folded it, a pending insert cannot fold onto an `E`-row snapshot, or a
  pending fold pass would rebuild past the byte ceiling. The
  collection has outgrown this host: export it with `baerly admin dump`, or
  have the operator move it to a larger host. Reads keep working either way.

### `BaerlyError code="MaintenancePending"` (HTTP 503, `Retry-After`)

**Cause:** the write would grow the collection past its host's fold ceiling until pending changes fold, and folding them makes room (typically after the collection moved from a host with a larger ceiling, with deletes still pending). The write ran one bounded fold and was refused without committing (a batch refused part-way keeps the rows it already committed). `retriable` is `true`. The refusal is recomputed on every request; nothing is stored.
**Fix:** wait `err.retryAfter` seconds (the `Retry-After` header over HTTP), then repeat the call. Reads keep working. `createBaerlyClient` already does this on every verb: it resends the identical request (an auto-ID insert keeps its minted `_id`) up to 3 attempts in total, waiting each hint of at most 10 s, so the error reaches your code only once those run out. The React subscription poll waits at least `retryAfter` before re-polling. Resending is safe because the refusal committed nothing and each HTTP write is one row. In-process, a multi-row `update` refused part-way keeps the rows before it; re-running it is safe, since a merge patch re-applied to a row it already changed leaves that row as it is.

### `_id must be in Unicode Normalization Form C` (HTTP 400, `code="InvalidConfig"`)

**Cause:** `insert`, `replace`, or `update` got an `_id` that is not NFC,
such as `"cafe\u0301"` (NFD) instead of `"caf\u00e9"`. R2 stores
canonically-equivalent keys as one object, so two such ids would share an
index marker.
**Fix:** pass `id.normalize("NFC")`. A row an earlier release stored under
a non-NFC `_id` still reads and deletes; to keep it writable, insert a copy
under a fresh NFC id that is not canonically equivalent to the original
(for example, omit `_id` for a UUID), then delete the original. On R2,
copying to the normalized original id before deleting it would remove the
copy's index markers.

### Resending an auto-ID insert over HTTP (`mintedId`)

**Cause:** an HTTP client minted the insert's `_id` and resent the insert after
losing the first response. Without a signal the resend is a caller-supplied
duplicate and gets `409 AlreadyExists`, though the row is the client's own.
**Fix:** send the minted id in both places,
`{ "doc": { "_id": m, ... }, "mintedId": m }`. A resend that finds a live row
for `m` holding the same document (key order ignored) returns the original
`201 { "_id": m }` and commits nothing; a different current body gets
`409 AlreadyExists`. Deletion permits reinsertion; updating back to the
original body permits replay. Calling `insert(doc)` again is a new operation
and mints a new auto-ID, rather than retransmitting the constructed request.
`mintedId` must be a canonical UUIDv7 equal to `doc._id`, else
`400 SchemaError`, so a human-chosen id like `"migration-x"` cannot opt in.
Leave `mintedId` out whenever you chose the `_id`: an insert without it keeps
strict `AlreadyExists` on any live row, even an identical one, which is what
makes `insert({ _id: "migration-x", done: true })` a run-once guard with a
single winner. A server that predates the field reads only `doc` and answers
the resend `409`, never with a second row. In-process `Collection.insert` takes
no such flag. A minted replay is an equality oracle: anyone who can insert into
the collection learns whether the row stored under an `_id` equals the body
they sent (`201`) or not (`409`).

### AmbiguousCommit recovery

`AmbiguousCommit` (HTTP 409) means a committing create may be durable, but its
outcome could not be resolved. It is not retriable by default. `err._id` names
the affected row, including the id an auto-ID insert minted. Re-read that row
and compare it with the intended state. A matching row can help reconcile the
outcome; absence does not prove failure, because a send may still complete or
a later write may have superseded it.

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

Retrying is an explicit at-least-once choice and may repeat logical work: a
same-`_id` insert retry targets one row and commits only while no live row
holds that `_id`, but a retried `update` or `replace` can still overwrite a
concurrent change to it. For bulk mutations, rows before the ambiguous row are already
applied and `err._id` names the ambiguous one, but no partial-progress count is
returned; inspect the affected rows before deciding whether to resume.

### `db.collection(name).insertOne(...)` / `.find(...)` is not a function

**Cause:** Mongo muscle memory. No such method.
**Fix:** `db.collection(name).insert(row)` and
`.where({ field: value }).all()` / `.where(q => q.gte("count", 1)).all()`.

### `.useIndex(...)` / `.hint(...)` is not a function

**Cause:** SQL/ORM muscle memory. No such method.
**Fix:** use `.where(...)` directly. Reads always fold the authoritative
snapshot and log; index declarations control marker maintenance, not
query routing.

### `BaerlyError code="InvalidConfig"` — `baerly: no auth configured`

**Full message:** `baerly: no auth configured. Set \`auth\` in baerly.config.ts ("none", "shared-secret") or pass \`verifier\` on the adapter factory.`

**Cause:** the adapter resolved no `Verifier`.
**Fix:** set `auth` in `baerly.config.ts` (`"none"` or `"shared-secret"`)
or pass `verifier:` on the adapter factory.

### `BaerlyError code="InvalidConfig"` — `SHARED_SECRET env is empty/unset`

**Full message:** `baerly: auth="shared-secret" but SHARED_SECRET env is empty/unset. Cloudflare: \`wrangler secret put SHARED_SECRET\`, or add to .dev.vars for local dev. Node: set in process env.`

**Cause:** `auth: "shared-secret"` was set but the `SHARED_SECRET`
environment variable is missing or empty at startup.
**Fix:** set the `SHARED_SECRET` env (`wrangler secret put SHARED_SECRET`
on Cloudflare, `.dev.vars` for local dev, process env on Node).

### `BaerlyError code="InvalidConfig"` — `Refusing to start: no durable storage configured` / `Refusing to use in-memory storage`

**Cause:** a deployed process (`NODE_ENV=production` or a known PaaS marker)
reached storage selection with no real bucket configured — or constructed
`MemoryStorage` there. In-memory "succeeds" into RAM and vanishes on every
restart; local-fs is single-process with no cross-process CAS. Both are
refused in a deployment so the failure is loud at boot, not silent data loss
in production.
**Fix:** don't hand-roll storage selection — call `resolveStorageFromEnv()`
from `@gusto/baerly-storage/node` (`R2_ACCOUNT_ID` → R2, `BUCKET` → S3, else
local-fs in dev) and configure a bucket: `BUCKET` + `AWS_ACCESS_KEY_ID` +
`AWS_SECRET_ACCESS_KEY` (add `R2_ACCOUNT_ID` for R2). To catch an
unreachable or CAS-broken bucket at boot rather than on the first write,
`await assertStorageReachable(storage)`. Intentionally ephemeral (a throwaway
demo)? Opt in explicitly: `new MemoryStorage({ ephemeral: true })` or
`BAERLY_ALLOW_EPHEMERAL_STORAGE=true`.

### `BaerlyError code="UseQueryAwaitedRecorder"`

**Cause:** awaited a terminal (`.get`/`.first`/`.all`/`.count`) inside a
`useQuery` callback. The recorder is synchronous; awaiting it yields a
sentinel and the next property access throws.
**Fix:** don't `await` in `useQuery` — for compound reads use
`Promise.all` (parallel) or compose two `useQuery` calls with
`useQuery.skip` (dependent). For writes use `useMutation()`.

### `BaerlyError code="UnexpectedWriteInQuery"`

**Cause:** called a write verb (`insert`/`update`/`replace`/`delete`)
inside a `useQuery` callback.
**Fix:** reads go in `useQuery`, writes go in `useMutation()`.

## Anti-patterns (compile-clean but wrong)

- Don't reach into `node_modules/@gusto/baerly-storage/dist/` at runtime —
  consume the published exports.
- Don't widen branded types (`UUID`, `ContentVersionId`) with `as string`.
- Don't put `SHARED_SECRET` in the SPA bundle — it is server-to-server
  only.
- Don't mutate `VerifierResult.tenantPrefix` between the verifier and
  `Db.create` — the dispatcher pins the tenant from the verifier's return.
- `z.string().nullable()` in a schema — `DocumentValue` excludes `null`.
- Raw SQL / `WHERE` clauses / hand-built query AST — the only query
  surface is the `.where(...)` method chain.
- `.all()` on a hot path — page or cursor-iterate; `.all()` is for
  bounded result sets.
- Relying on baerly to cap or scope a read. `GET /v1/c/:collection` (and
  `.all()`) returns the **whole collection** — there is no default row
  cap, and auth pins a tenant, not a row owner. Scope non-owner reads in
  your own route: inject a `where owner_id = <verified id>` predicate
  (ideally index-backed) and clamp `limit = min(requested ?? MAX, MAX)`.
  Rejecting `?limit` backfires — it forces the uncapped path. See
  `docs/guide/auth.md` § Authorization Boundary.

## Where to look next

- Public API surface: `dist/API.md` (`cat node_modules/@gusto/baerly-storage/dist/API.md`).
- Per-symbol types: the `dist/*.d.ts` chunks.
- A remembered call no longer type-checks: `dist/CHANGELOG.md`.
