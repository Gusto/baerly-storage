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

### `BaerlyError code="Conflict"` (HTTP 409)

**Cause:** the write conflicted with existing state. CAS conflicts are
retryable (`retriable: true`); duplicate caller-supplied `_id` inserts are
terminal (`retriable: false`).
**Fix:** follow the wire `resolution`. For retryable CAS conflicts, re-read,
re-apply, and retry with bounded backoff. For duplicate `_id` conflicts,
choose a different `_id`, or omit `_id` so baerly-storage can mint one.
The in-process writer already retries a bounded number of CAS attempts; a
remote client that sees `retriable: true` should apply its own bounded backoff.

### `db.collection(name).insertOne(...)` / `.find(...)` is not a function

**Cause:** Mongo muscle memory. No such method.
**Fix:** `db.collection(name).insert(row)` and
`.where({ field: value }).all()` / `.where(q => q.gte("count", 1)).all()`.

### `.useIndex(...)` / `.hint(...)` is not a function

**Cause:** SQL/ORM muscle memory. No such method.
**Fix:** the planner picks the index automatically from the
`IndexDefinition`s registered in `baerly.config.ts`.

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
