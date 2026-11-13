---
title: Upgrading to 0.7.0
audience: integrator
summary: Old-to-new migration for 0.7.0, organized by what an app author and an operator must do.
last-reviewed: 2026-11-13
tags: [upgrade, migration, breaking-changes]
related: ["backups.md", "operations.md", "../about/workload-fit.md", "../contributing/conventions/versioning.md"]
---

# Upgrading to 0.7.0

0.7.0 is one breaking release: pre-1.0, so a `minor` bump. Every breaking
changeset also carries its own old-to-new block in
`node_modules/@gusto/baerly-storage/dist/CHANGELOG.md`; this page groups
them by what you must do. The `.d.ts` types win over this page.

Pick your starting version:

- **0.6.0:** in-place. The bucket format (`current.json` schema 3) is
  unchanged. Deploy 0.7.0 over the same bucket, then follow sections 1 to 6.
- **0.1.0:** refused in place (`current.json` schema 1). Dump with the
  0.1.0 `baerly`, restore into an empty target with 0.7.0 (section 5).
  Versions between 0.1.0 and 0.6.0 are not covered here; run
  `baerly admin fsck` first and dump/restore if it reports a format error.

Every writer to a collection must run 0.7.0 before you rely on the new
write guarantees (first-wins inserts, update semantics): an older writer
does not check the new conditions.

## 1. App code: errors

`BaerlyErrorCode` changed. `Conflict` is gone; `retriable` is a function of
the code only (`NetworkError`, `WriteConflict`, `MaintenancePending`).

```ts
// before
if (err.code === "Conflict" && err.retriable) {/* CAS race */}
if (err.code === "Conflict" && !err.retriable) {/* duplicate _id */}
new BaerlyError("NetworkError", "PUT failed", cause, issues);
// after
if (err.code === "WriteConflict") {/* retry with backoff */}
if (err.code === "AlreadyExists") {/* never retry; see section 2 */}
new BaerlyError("NetworkError", "PUT failed", { cause, issues });
```

`new BaerlyError(code, message, options?)` and `errorEnvelope(code, message,
options?)` (from `@gusto/baerly-storage/http`) take one options object:
`cause`, `issues`, `status`, `resolution`, `_id`. The `retriable` argument is
gone. Untyped JavaScript gets no error for an old positional call; fix it
by hand.

New codes and what to do:

| Code | HTTP | Retriable | App remedy |
| --- | --- | --- | --- |
| `WriteConflict` | 409 | yes | Re-read, retry with bounded backoff. |
| `AlreadyExists` | 409 | no | Duplicate `_id`. Re-read or use `update`/`replace`. |
| `AmbiguousCommit` | 409 | no | Fate unknown. Re-read the row named by `err._id`; absence does not prove failure. Retry an insert with the same `_id`. |
| `CapacityExceeded` | 409 | no | Nothing committed. Delete or shrink rows, or move the collection to a larger host. Reads and deletes keep working. |
| `MaintenancePending` | 503 + `Retry-After` | yes | Nothing committed. Wait `err.retryAfter` seconds, repeat. |
| `InvalidConfig` | 400 | no | The input is outside the write domain (sections 2 and 3). |

```ts
try {
  await tickets.insert(doc);
} catch (err) {
  if (!(err instanceof BaerlyError)) throw err;
  switch (err.code) {
    case "MaintenancePending":
      await sleep((err.retryAfter ?? 1) * 1000); // then repeat
      break;
    case "CapacityExceeded": // not retriable unchanged
    case "AlreadyExists":
    case "AmbiguousCommit":
    default:
      throw err;
  }
}
```

An exhaustive `switch (err.code)` must add the new cases. Alerting that
matched every HTTP `409` as a write conflict should match on `error.code`.
`AmbiguousCommit` also appears where 0.6.0 returned success or a retriable
`NetworkError`: a create whose fate cannot be resolved, or one landing below
the certified-deleted log floor.

The bundled client (`createBaerlyClient`) retries `MaintenancePending` on
every verb, 3 attempts in total, honoring `Retry-After` up to 10 s. A raw
HTTP caller or a `fetch` wrapper must do this itself. The React
subscription poll honors `retryAfter` and stops on a non-retriable error;
`useQuery(..., { live: false })` and `refetch()` are new for one-shot
queries.

## 2. App code: writes

**Ids (caller-supplied or minted).**

- An `_id` must be a string in NFC (`id === id.normalize("NFC")`) that
  follows the key rules: non-empty, no `/`, not `.` or `..`, no control
  character, no leading `_`, at most 256 UTF-8 bytes. Otherwise `insert`,
  `replace`, `POST` and `PUT` throw `InvalidConfig` (400) before writing.
- `insert({ _id: 42 })` (any present non-string `_id`, including `null`)
  used to be replaced by a generated UUIDv7 silently. It now throws.
  Omit `_id`, `undefined` and `""` still generate one.
- `get(id)` with an id no row can have used to answer "not found". It now
  throws `InvalidConfig`. Point reads do not require NFC, so legacy rows
  stay readable.

```ts
// before
await orders.insert({ _id: 42, total: 10 });        // stored under a UUID
const row = await orders.get(untrustedId);           // undefined if malformed
// after
await orders.insert({ _id: String(42), total: 10 }); // or omit _id
const row = await orders.get(untrustedId).catch((e) => {
  if (e instanceof BaerlyError && e.code === "InvalidConfig") return undefined;
  throw e;
});
```

**First insert wins.** Of concurrent inserts of one `_id`, one commits and
the rest throw `AlreadyExists` (with `err._id`). Code that used a duplicate
insert as an upsert must call `replace(id, doc)` or `update(id, patch)`.

**Replay of client-minted ids (E2).** An insert without `_id` is minted by
the HTTP client (UUIDv7, client clock) and sent with `mintedId`. If a
resend arrives while the live row still equals the same document (key order
ignored), the server answers the original `201 { _id }` instead of
`AlreadyExists`. Edges: a different current body gives `AlreadyExists`;
deleting the row permits re-insertion; updating back to the original body
permits replay again. A caller-chosen `_id` never replays, so it still works
as a run-once guard. Calling `insert(doc)` again is a new operation with a
new id. Raw HTTP callers may send `mintedId` (a canonical UUIDv7 equal to
`doc._id`; anything else is `400 SchemaError`); a server without this
feature ignores it and answers `409`, never a duplicate row. The client
resends a minted insert up to 3 times total after a thrown `fetch` or an
envelope-less 5xx, 408 or 429; other verbs are sent once for those failures.

**Update and delete follow READ COMMITTED.** The patch applies to the row's
newest committed version, so concurrent writes to different fields both
survive.

```ts
// before: could resurrect a concurrently deleted row
await tickets.update(id, { status: "closed" });
// after: { modified: 0 } (HTTP 404 NotFound) when the row is gone
const { modified } = await tickets.update(id, { status: "closed" });
// replace() on a concurrently deleted row now throws NotFound
// delete(): of two racing deletes, one returns { deleted: 1 }, one { deleted: 0 }
```

`where(p).update()` and `.delete()` re-evaluate `p` on the newest version
and skip rows that no longer match.

**Patches cannot change `_id`.** A patch whose `_id` is present and differs
from the row's throws `InvalidConfig`. To rename, insert under the new id
and delete the old one. A row an older bug left with a corrupt stored `_id`
makes `update`/`delete` throw `InvalidResponse` (502); `replace(id, doc)`
repairs it.

**Values must be plain JSON.** (Input validation.) `insert`, `replace` and
`update` throw `InvalidConfig` before any storage call for `NaN`,
`Infinity`, `undefined` object members or array elements, functions,
symbols, bigints, cycles, and any nested object that is not a plain object
or array (`Date`, `Map`, `Set`, typed arrays, class instances, anything with
a `toJSON`). The message names the path; `err.resolution` says how to
convert. The client checks before sending. `null` and `-0` are fine.

```ts
// before: stored { due: "1970-01-01T00:00:00.000Z", score: null, tags: {} }
await tasks.insert({ due: new Date(0), score: NaN, tags: new Map() });
// after
await tasks.insert({ due: new Date(0).toISOString(), score: null, tags: {} });
```

**Reads now fold authoritative state.** Reads and mutation targets are
selected from the full snapshot plus the committed log; they no longer LIST
index markers, so a missing marker cannot hide a live row.

- Row order among ties is not stable between releases. Add an explicit
  `order(...)` before a `limit` whenever the choice of rows matters.
- An indexed query that matches nothing now has to prove absence, which
  loads the snapshot and log: an empty result costs about a full scan.
  Budget for it on hot "does it exist" lookups; prefer `get(id)`.
- A filtered (`predicate`) index is skipped, and the query full-scans, when
  the query does not imply the index's filter.

**Collection, app and tenant names must be NFC** (section 5 has the legacy
recipe). `Db.create` (including `config.collections` keys), `db.collection`,
`ensureTable`, every HTTP route and the writing CLI verbs throw
`InvalidConfig` for a non-NFC name. Names are never normalized for you.

```ts
// before
const db = Db.create({ storage, app, tenant: claims.org });
// after (only for a tenant with no stored non-NFC data)
const db = Db.create({ storage, app, tenant: claims.org.normalize("NFC") });
```

## 3. App code: client and HTTP

- `createBaerlyClient` retries: `GET` up to 3 attempts; `MaintenancePending`
  on every verb up to 3; minted inserts after transport failures. All share
  one 3-attempt budget per request.
- A Cloudflare Worker now answers a throw around the router (for example a
  Cache API failure) with the JSON error envelope and mapped status, not
  workerd's error page.
- A `Verifier` that throws now yields its mapped status instead of an
  unhandled rejection.
- Canonical log lines report capacity refusals as `outcome: "refused"` (warn
  level). Alerts keyed on `outcome: "conflict"` or `"error"` for those
  writes shift to `"refused"`. `Baerly-Capacity-Warning` and the
  `capacity_warning` log field are additive early signals.
- Request budgets (Cloudflare): a call past the request's storage budget is
  refused with `CapacityExceeded` before it is sent; a read that cannot fit
  is refused whole, never truncated. `GET /v1/since` ends a long-poll early
  instead of failing (about 22 s on Free + S3).

## 4. Operators and hosts

Host settings live here, not in app code.

**Growth refusal.** A write that would take a collection past its host's
fold ceiling (`E` rows or `C` snapshot bytes for the maintenance profile)
fails with `CapacityExceeded`; deletes and shrinking updates still commit.
Near the ceiling, writes drive maintenance themselves and may answer
`MaintenancePending`. The decision is recomputed per request, so refusals
clear without operator action. A collection already past its host's ceiling
(folded on a larger host, now served by a smaller one) refuses every write:
serve it from a larger `BAERLY_MAINTENANCE_PROFILE` (`cf-paid`, `node`) or
export it with `baerly admin dump`. `baerly admin restore` bypasses the
check.

**Maintenance env validation.** Invalid values fail loudly instead of
silently disabling maintenance. Node answers `InvalidConfig`; Cloudflare
surfaces a Worker exception.

| Before | Now |
| --- | --- |
| `BAERLY_MAINTENANCE_DISABLE=yes` / `no` | `true` / `false` (or `1` / `0`, or unset) |
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=0` or negative | unset, or a positive number |
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=8mb` (non-numeric) | a plain number of bytes (strict rejection is tracked for 0.7.0, see `rel-maintenance-env-strict`) |
| unknown `BAERLY_MAINTENANCE_PROFILE` fell back to `cf-free` | `cf-free` or `cf-paid` (same ticket) |

**Host tiers.** The per-profile ceilings, the fold-at-7-pending rule on
Workers Free with non-R2 storage, and `CLOUDFLARE_FREE_TIER` /
`CLOUDFLARE_PAID_TIER` constants changed. `CLOUDFLARE_FREE_TIER.compact
.minEntriesToCompact` dropped from 50 to 20. Check
[workload-fit.md](../about/workload-fit.md) for the current table.

- **Workers Free + R2 binding:** one `runScheduledMaintenance(args,
  CLOUDFLARE_FREE_TIER)` per invocation now fits; the even/odd-minute
  alternation is no longer needed. `runScheduledMaintenance`'s default
  `minEntriesToCompact` is 1 (was 100).
- **Workers Free + S3 over HTTP (best effort):** keep alternating direct
  `compact()` and `runGc()` calls. Accepted limits on this host: an update
  that changes 9 or more indexed fields is refused with `CapacityExceeded`
  (the commit pre-check needs more of the 45 allowed `fetch` calls than
  remain; 8 commit, 9 refuse at the longest tail); past a pending tail of
  about 9 entries a worst-case update cannot fold in its write tick, so the
  tail does not shorten there; and a scheduled `compact()` whose `tail_hint`
  is about 20 or more entries stale does not fit the 45 calls, so every later
  pass stops at the same point. Use the R2 binding for request headroom.
- **Workers Paid:** `CLOUDFLARE_PAID_TIER` walks at most 1,000 log slots per
  compaction pass. If you switch on `CompactResult.skippedReason`, handle the
  new `"probe-budget-checkpointed"` case.

**Storage retries.** Retry now happens at one layer, 3 attempts per request.
`S3HttpStorage` and `GcsHttpStorage` `retries` defaults to `2` (was `8`); a
value that is not a non-negative integer rejects with `InvalidConfig`;
`backoffMs` replaces both jitter bases. `r2BindingStorage` now retries
transient failures under the same policy. A conditional (`If-Match`) PUT is
never resent.

**Custom `Storage` adapters.** `StorageListEntry.lastModified` is removed
(entries are `key` + `etag`). `get` takes only `{ signal }` and returns
`{ body, etag }`; `put` returns `{ etag, serverDate? }`; `versionId` and
conditional GET are gone. A rejected precondition must throw
`WriteConflict`, never `AlreadyExists`.

```ts
// before
const got = await storage.get(key, { ifNoneMatch: etag, versionId, signal });
const { etag, versionId } = await storage.put(key, body);
// after
const got = await storage.get(key, { signal });
const { etag } = await storage.put(key, body);
```

**Garbage collection and the bucket layout.**

- No `content/<sha>.json` objects are written. Direct bucket readers must
  read `entry.after` from the log entry (see the `stop-writing-content-objects`
  changeset). Legacy content objects are left inert.
- `RunGcResult.marked.orphan_content` and `RunGcResult.marked.stale_log` are
  removed. GC no longer LISTs `log/`; retention is by sequence window.
- `InternalMaintenanceOptions` is no longer exported.
- `Db.getLogEntry` / `probeLogTail` (`@internal`) take `current.json` and
  reject a sequence below the floor.

**Local-fs.** `LocalFsStorage` (and `baerlyDev()`) now stores keys
byte-exact on disk and writes a `.baerly-localfs.json` marker. An existing
data directory is adopted only when every name already reads the same under
the new encoding (lowercase ASCII names, nothing dot-prefixed); otherwise
every operation throws `InvalidConfig` listing the paths. There is no
in-place migration: dump with 0.6.0, restore into a fresh directory with
0.7.0. Keys a case-folding filesystem already merged cannot be recovered.

## 5. Data migration

Do this per tenant, before deploying 0.7.0 for any tenant whose data may be
affected.

**Preflight (read-only).**

```sh
baerly admin usage --target=node --bucket=s3://my-bucket --app=app --tenant=t
baerly admin fsck  --bucket=s3://my-bucket --app=app --tenant=t --collection=tickets
baerly admin dump  --bucket=s3://my-bucket --app=app --tenant=t --collection=tickets --json > tickets.ndjson
```

`usage` scans only the `--tenant` you pass: list every tenant your verifier
can mint and scan each. It reports non-NFC app, tenant and collection names
and canonically-equivalent collection pairs as `names` warnings. `fsck`
reports the same as `names` warnings (exit 4). `dump --json` reports
non-NFC names, non-NFC `_id`s and groups of canonically-equivalent `_id`s in
its `legacy` field (or as stderr warnings). Keep the raw dump before any
repair.

**Legacy `_id`s.** Rows under a non-NFC `_id` still read (`get`, `where`,
`delete`), but `update` and `replace` refuse them. To keep one writable:
read it by `_id`, insert a copy under a fresh NFC id that is not canonically
equivalent to the original (omit `_id` for a UUID), then delete the
original. For canonically-equivalent pairs, copy both under fresh ids, then
delete both. On R2, never copy to the normalized original id: deleting the
original then removes the copy's index markers.

**Legacy names.** A non-NFC name's data is read-only through the SDK and
HTTP; `baerly inspect`, `export`, `admin dump` and `fsck` still read it. On
R2 the normalized spelling addresses the legacy objects, so reads and writes
under it refuse with `InvalidConfig` instead of showing an empty
collection. Dump and restore under a name that is not canonically
equivalent to the original:

```sh
baerly admin dump    --bucket=$B --app=app --tenant=t --collection=<legacy name> > rows.ndjson
baerly admin restore --bucket=$B --app=app --tenant=t --collection=café-v2 < rows.ndjson
```

Point the app at `café-v2`. A non-NFC app or tenant migrates the same way,
one collection at a time. A name with no stored data only needs
`.normalize("NFC")` in code.

**Dump and restore (0.1.0, local-fs, or any rewrite).** Follow
[backups.md](backups.md): pause writers, drain maintenance, restore into a
separate target, run `fsck` and `fsck --indexes --config=<path>`, then
`rebuild-index` per index and cut over. `baerly admin restore` now:

- refuses a line whose `_id` repeats an earlier line, is outside the key
  rules, or is not NFC, with `InvalidConfig` (exit 1) naming the line number
  and the escaped `_id`;
- refuses values outside plain JSON (for example `1e999`);
- reports how many rows were already committed on every failure. Restore
  commits row by row: rows before the failing line stay committed, the
  failing line and later lines do not. Fix the dump, then restore into a
  fresh target or with `--force`. Restore never rewrites an `_id`.

```sh
baerly admin restore --bucket=$B --app=app --tenant=t --collection=tickets --force < fixed-dump.ndjson
```

**0.1.0 specifically.** 0.1.0 accepted `/` in `_id`, but index reads omitted
such a row. 0.7.0 rejects the id on restore. Rewrite those ids in the
NDJSON (to a fresh id without `/`) before restoring, and update any
reference to the old id.

**In place from 0.6.0.** No format change. After deploying, run `fsck` and
`fsck --indexes --config=<path>` per collection; `rebuild-index` per index
if drift is reported. Stale index markers from 0.6.0 are harmless: reads no
longer trust them.

## 6. Index markers

> **TODO (owner decision pending, ticket not yet written):** 0.7.0 stops
> maintaining index markers. This section is a placeholder for what an app
> or operator must do (query behavior, `rebuild-index` / `fsck --indexes`
> role, cost). Do not ship the guide with this section unresolved.

## Dependency bumps

Bundled dependencies updated with no public API change: hono 4.13.2,
`@hono/node-server` 2.1.1, jose 6.2.9, `@rgrove/parse-xml` 4.2.3,
`@logtape/logtape` 2.3.1.
