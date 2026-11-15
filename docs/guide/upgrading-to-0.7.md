---
title: Upgrading to 0.7.0
audience: integrator
summary: Old-to-new migration for 0.7.0, organized by what an app author and an operator must do.
last-reviewed: 2026-11-15
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
  unchanged. Deploy 0.7.0 over the same bucket, then follow sections 1 to 7.
- **0.1.0:** refused in place (`current.json` schema 1). Dump with the
  0.1.0 `baerly`, restore into an empty target with 0.7.0 (section 5).
  Versions between 0.1.0 and 0.6.0 are not covered here; run
  `baerly admin fsck` first and dump/restore if it reports a format error.

Every writer to a collection must run 0.7.0 before you rely on the new
write guarantees (first-wins inserts, update semantics): an older writer
does not check the new conditions.

0.7.0 also stops writing index markers (section 6). A 0.6.0 node that
reads a bucket 0.7.0 wrote, in a mixed fleet during a rolling deploy or
after a rollback, misses the rows 0.7.0 wrote from indexed queries until
0.6.0's `baerly admin rebuild-index` runs for each index. Finish the
rollout before relying on indexed reads, and follow section 6 if you roll
back.

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
`cause`, `issues`, `status`, `resolution`, `_id`, `retryAfter`. The `retriable` argument is
gone. Untyped JavaScript gets no error for an old positional call; fix it
by hand.

New codes and what to do:

| Code | HTTP | Retriable | App remedy |
| --- | --- | --- | --- |
| `WriteConflict` | 409 | yes | Re-read, retry with bounded backoff. |
| `AlreadyExists` | 409 | no | Duplicate `_id`. Re-read or use `update`/`replace`. |
| `AmbiguousCommit` | 409 | no | Fate unknown. Re-read the row named by `err._id`; absence does not prove failure. Retry an insert with the same `_id`. |
| `CapacityExceeded` | 409 | no | Not retriable unchanged. A single write commits nothing when refused. A multi-row `where(...).update()` / `.delete()` refused part-way (including by a request's storage budget) keeps the rows it already committed: re-read, then retry on a fresh request or narrow the query. Delete or shrink rows to make room; reads and deletes keep working. Host-side remedies are in section 4. |
| `MaintenancePending` | 503 + `Retry-After` | yes | Nothing committed. Wait `err.retryAfter` seconds, repeat. |
| `InvalidConfig` | 400 | no | The input is outside the write domain (sections 2 and 3). |
| `CursorExpired` | 410 | no | A `/v1/since` cursor can no longer resume. Re-read, then restart with `cursor: ""` (section 3). |

```ts
import { BaerlyError } from "@gusto/baerly-storage";

// MaintenancePending: wait err.retryAfter seconds and repeat. Every other
// code is thrown to the caller.
for (let attempt = 0; ; attempt++) {
  try {
    await tickets.insert(doc);
    break;
  } catch (err) {
    if (err instanceof BaerlyError && err.code === "MaintenancePending" && attempt < 2) {
      await new Promise((r) => setTimeout(r, (err.retryAfter ?? 1) * 1000));
      continue;
    }
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
`Infinity`, `undefined` array elements, functions, symbols, bigints, cycles,
and any nested object that is not a plain object
or array (`Date`, `Map`, `Set`, typed arrays, class instances, anything with
a `toJSON`). The message names the path; `err.resolution` says how to
convert. `insert` and `replace` also reject `undefined` object members;
`update` treats those members as absent. The client checks before sending.
`null` and `-0` are fine.

```ts
// before: stored { due: "1970-01-01T00:00:00.000Z", score: null, tags: {} }
await tasks.insert({ due: new Date(0), score: NaN, tags: new Map() });
// after
await tasks.insert({ due: new Date(0).toISOString(), score: null, tags: {} });
```

**A document is at most 1 MiB.** `insert`, `replace` and `update` (by id
or by predicate) refuse a resulting row that would encode to more than
1,048,576 bytes of JSON, `_id` included, with `InvalidConfig` (400).
`update` checks each merged row, not the patch. A multi-row update checks
all selected rows before writing, so an over-cap row found then commits
none. Concurrent writes can require a later row to be merged and checked
again after earlier rows committed; if that check fails, those earlier
commits remain. Re-read before retrying. A row an earlier release stored
over the cap stays readable and deletable, and an update that shrinks it
under the cap commits. `PayloadTooLarge` (413) still means the request
body itself was too large.

```ts
// before: one row that keeps growing (now refused once it passes 1 MiB)
await db.collection("threads").update(threadId, { messages: [...messages, next] });
// after: one row per item, keyed back to its parent
await db.collection("messages").insert({ threadId, ...next });
```

**Reads fold authoritative state.** Every read and every mutation target
is selected from the full snapshot plus the committed log. Declared
`indexes` do not make a read cheaper (section 6), so every query costs the
same snapshot and log load whether or not it matches anything.

- Row order among ties is not stable between releases. Add an explicit
  `order(...)` before a `limit` whenever the choice of rows matters.

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
- `GET /v1/since` answers a cursor that can no longer resume (its changes
  are no longer retained, or `baerly admin restore --force` truncated the
  generation it came from) with `CursorExpired` (410). 0.6.0 answered
  `SchemaError` (400), which still means a malformed cursor. Re-read your
  rows, then restart with `cursor: ""`; the changes in between are not
  replayed. The React subscription poll does this itself and now parks on
  a `SchemaError` until `refetch()`.

```ts
// before: a hand-rolled /v1/since consumer
if (res.status === 400 && body.error.code === "SchemaError" && cursor !== "") cursor = "";
// after
if (res.status === 410 && body.error.code === "CursorExpired") cursor = ""; // re-read your rows first
```

- `createBaerlyClient({ onWarning })` is new and optional: it receives
  `{ code: "CapacityWarning", message, method, path }` for each response
  carrying `Baerly-Capacity-Warning`, so an HTTP client learns a collection
  is near its host's capacity before writes fail with `CapacityExceeded`.
  A cross-origin browser app also needs its CORS layer to list that header
  in `Access-Control-Expose-Headers`.

## 4. Operators and hosts

Host settings live here, not in app code.

**Growth refusal.** A write that would take a collection past its host's
fold ceiling (`E` rows or `C` snapshot bytes for the maintenance profile)
fails with `CapacityExceeded`; deletes and shrinking updates still commit.
Near the ceiling, writes drive maintenance themselves and may answer
`MaintenancePending`. The decision is recomputed per request, so refusals
clear without operator action. A collection already past its host's ceiling
(folded on a larger host, now served by a smaller one) refuses every write:
serve it with `BAERLY_MAINTENANCE_PROFILE=cf-paid` on Workers Paid, or from
the Node adapter, or export it with `baerly admin dump`. `baerly admin restore` bypasses the
check.

**Maintenance env validation.** Invalid values fail loudly instead of
silently falling back. Node answers `InvalidConfig`; Cloudflare surfaces a
Worker exception. Health, spec and dev routes stay up, and the error clears
once the value is fixed, with no restart. No value is trimmed.

| Before | Now |
| --- | --- |
| `BAERLY_MAINTENANCE_DISABLE=yes` / `no` | `true` / `false` (or `1` / `0`, or unset) |
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES=0`, negative, `8mb`, `1e6`, `0x400`, `" 1024 "` | unset, or a plain positive decimal byte count (`8388608`) |
| `BAERLY_MAINTENANCE_PROFILE=CF-PAID` / `cf_paid` / `paid` | `cf-paid` exactly |
| `BAERLY_MAINTENANCE_PROFILE=free` (meant as the default) | unset, or `cf-free` |

**Scheduled maintenance.** Optional, as before: every write already runs
bounded maintenance in band. `@gusto/baerly-storage/maintenance` now
exports one function, addressed by collection and sized by `tier` (the
`BAERLY_MAINTENANCE_PROFILE` vocabulary: `"cf-free"`, `"cf-paid"`, or the
unbounded default `"node"`). `compact`, `runGc`, their option and result
types, `MaintenanceArgs`, `MaintenanceProfile`, `MAINTENANCE_PROFILE_*`,
`CLOUDFLARE_FREE_TIER` / `CLOUDFLARE_PAID_TIER` and (from `/cloudflare`)
`resolveCfMaintenanceProfile` are gone.

```ts
// before
import { runScheduledMaintenance } from "@gusto/baerly-storage/maintenance";
const res = await runScheduledMaintenance({
  storage,
  currentJsonKey: "app/helpdesk/tenant/acme/manifests/tickets/current.json",
});
console.log(res.compact.entriesFolded, res.gc.swept);
// after
import { runScheduledMaintenance } from "@gusto/baerly-storage/maintenance";
const target = { storage, app: "helpdesk", tenant: "acme", collection: "tickets" };
const res = await runScheduledMaintenance(target); // Node: one unbounded pass
console.log(res.folded, res.gcDeleted);

// before (Cloudflare, R2 binding)
await runScheduledMaintenance({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER); // or CLOUDFLARE_PAID_TIER
// after
await runScheduledMaintenance(target, { tier: "cf-free" }); // or "cf-paid"

// before (Workers Free, S3 over HTTP)
if (Math.floor(controller.scheduledTime / 60_000) % 2 === 0) {
  await compact({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER.compact);
} else {
  await runGc({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER.gc);
}
// after
const even = Math.floor(controller.scheduledTime / 60_000) % 2 === 0;
await runScheduledMaintenance(target, { tier: "cf-free", phase: even ? "compact" : "gc" });

// before
const profile = resolveCfMaintenanceProfile((k) => env[k]);
// after
const tier = env.BAERLY_MAINTENANCE_PROFILE === "cf-paid" ? "cf-paid" : "cf-free";
```

- The result is `{ folded, deferred?: { reason }, gcDeleted, pending }`.
  `deferred.reason` is `"contention"` (a concurrent write or pass won) or
  `"budget"` (the pass saved its progress locating the tail; the next pass
  continues). It replaces `CompactResult.skippedReason`, including
  `"probe-budget-checkpointed"`.
- `minEntriesToCompact` is no longer an option. Node and `"cf-paid"` passes
  fold any pending write (0.6.0's bare call skipped tails under 100, and
  `CLOUDFLARE_PAID_TIER` under 50), so a hot Paid cron rewrites the snapshot
  more often. Under `"cf-free"` a pass folds one 20-entry slice only when at
  least 20 entries are pending.
- Workers Free with the R2 binding fits one whole pass per invocation; the
  even/odd-minute alternation is needed only for storage over `fetch`.
  Run one collection per Cloudflare invocation. Invalid names and unknown
  `tier` / `phase` values throw `InvalidConfig` before any storage call.

**Host tiers.** Per-host ceilings, the pending-tail limits on Workers Free
with S3 over HTTP, and which host is a guaranteed tier changed. Read the
current figures in [scale-ceilings.md](../spec/scale-ceilings.md#host-support-tiers)
rather than any you noted from 0.6.0.

**Fold-ceiling signals.** A collection past the fold ceiling now logs a
`fold_deferred` warning (category `["baerly", "maintenance"]`) on its first
deferral and then at most once per 1,000 writes. `db.compaction.deferred_total`
gains a `gate` label, and `db.compaction.deferred_bytes_total` /
`db.compaction.deferred_rows_total` are new. A scheduled pass below its
fold floor with a live tail counts `db.compaction.below_min_total`.
`baerly inspect` reports `fold_gate` per host profile; `inspect --json` is a
storage-format diagnostic, not a stable contract, so do not build automation
on its fields.

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
- GC no longer marks orphan content or stale log objects (0.6.0's
  `RunGcResult.marked.orphan_content` / `stale_log`); it no longer LISTs
  `log/`, and old log objects are retired by sequence window. Count
  deletions with `MaintenanceResult.gcDeleted`.

**Local-fs.** `LocalFsStorage` (and `baerlyDev()`) now stores keys
byte-exact on disk and writes a `.baerly-localfs.json` marker. An existing
data directory is adopted only when every name already reads the same under
the new encoding: lowercase ASCII names, nothing dot-prefixed, and no
collection ever folded (a fold writes `snapshot/L9/`, which now encodes as
`snapshot/%4c9/`, so any directory 0.6.0 compacted is refused). Otherwise
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
baerly admin dump  --bucket=s3://my-bucket --app=app --tenant=t --collection=tickets > tickets.ndjson
```

`usage` scans only the `--tenant` you pass: list every tenant your verifier
can mint and scan each. It reports non-NFC app, tenant and collection names
and canonically-equivalent collection pairs as `names` warnings. `fsck`
reports the same as `names` warnings (exit 4), and also flags names (check
`names`) and snapshot `_id`s (check `ids`) holding an unpaired UTF-16
surrogate, which 0.7.0 refuses as write targets. `fsck` does not decode the
log; `dump` covers every live row and reports non-NFC and ill-formed names,
non-NFC and ill-formed `_id`s, and groups of canonically-equivalent `_id`s
as stderr warnings. Keep the raw dump before any repair. For a structured
report, run `dump --json` separately: it appends a success envelope with a
`legacy` field to stdout, so its output cannot be restored as NDJSON.

**Legacy `_id`s.** Rows under a non-NFC `_id` still read (`get`, `where`,
`delete`), but `update` and `replace` refuse them. To keep one writable:
read it by `_id`, insert a copy under a fresh NFC id that is not canonically
equivalent to the original (omit `_id` for a UUID), then delete the
original. For canonically-equivalent pairs, copy both under fresh ids, then
delete both.

**Legacy names.** The SDK and HTTP reject non-NFC names for reads and
writes; `baerly inspect`, `export`, `admin dump` and `fsck` still read their
data. On R2 a normalized collection name can address legacy objects;
reads and folds that encounter the other collection spelling refuse with
`InvalidConfig`. Stored records do not identify the app or tenant, so a
normalized legacy app or tenant can still read and modify the same data.
Dump and restore under a name that is not canonically equivalent to the
original:

```sh
baerly admin dump    --bucket=$B --app=app --tenant=t --collection=<legacy name> > rows.ndjson
baerly admin restore --bucket=$B --app=app --tenant=t --collection=café-v2 < rows.ndjson
```

Point the app at `café-v2`. A non-NFC app or tenant migrates the same way,
one collection at a time. A name with no stored data only needs
`.normalize("NFC")` in code.

**Dump and restore (0.1.0, local-fs, or any rewrite).** Follow
[backups.md](backups.md): pause writers, drain maintenance, restore into a
separate target, run `fsck`, compare reads against the source, then cut
over. `baerly admin restore` now:

- refuses a line whose `_id` repeats an earlier line, is outside the key
  rules, or is not NFC, with `InvalidConfig` (exit 1) naming the line number
  and the escaped `_id`;
- refuses values outside plain JSON (for example `1e999`);
- refuses a line whose row encodes to more than 1 MiB, naming the line
  number. Split such a row in the NDJSON (section 2) before restoring; in
  place, an oversized row stays readable and deletable;
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

**In place from 0.6.0.** No format change. After deploying, run
`baerly admin fsck` per collection. Existing `index/` objects are inert
(section 6).

## 6. Index markers

0.7.0 stops maintaining index markers. Reads already fold the snapshot and
log for every query, so markers were pure write cost.

- A collection's `indexes` declaration is still accepted and validated at
  `Db.create`, but it changes no storage call and no read result. Declaring
  an index does not make a query faster; omit them in new code. Writes on a
  collection that declares indexes cost the same as writes on one that does
  not.
- Removed: `rebuildIndex` (from `@gusto/baerly-storage/maintenance`),
  `allIndexKeysFor`, `baerly admin rebuild-index`, and
  `baerly admin fsck --indexes` / `--fix`. `fsck` without those flags is
  unchanged.
- Legacy `index/` objects written by earlier releases are inert: nothing
  reads, writes or lists them. They cost only storage. To reclaim it, delete
  by prefix, per collection, once no 0.6.0 node reads the bucket:
  `app/<app>/tenant/<tenant>/manifests/<collection>/index/` (under your
  bucket key prefix, if any). No cleanup is required for correctness.
- Mixed fleet or rollback: a 0.6.0 node reading a bucket 0.7.0 wrote misses
  0.7.0-written rows on indexed queries until 0.6.0's
  `baerly admin rebuild-index` runs for each index. That rebuild aborts on
  a value 0.6.0 refused in an indexed field (an array, or a value too long
  for a marker key), so stop writers first and follow the rollback steps in
  [backups.md](backups.md#legacy-index-markers). Do not delete the
  `index/` prefix while a rollback is still possible.
- Rebuild a composite index (`on: ["status", "owner"]`) with `--config`:
  0.6.0's `--on` takes one field, so `--on=status,owner` names a single
  field called `status,owner` and rebuilds the wrong markers.

```sh
# 0.6.0 binary, once per kept index
baerly admin rebuild-index --bucket=$B --app=app --tenant=t --collection=tickets --index=by_status --on=status
baerly admin rebuild-index --bucket=$B --app=app --tenant=t --collection=tickets --index=by_status_owner --config=./baerly.config.mjs
```

## 7. Removed and renamed exports

The published barrels no longer carry kernel internals; none was in
`API.md`. Use the collection API (`db.collection(name)`) and `/v1/since`
for reads, and `runScheduledMaintenance` (section 4) for maintenance.

- `@gusto/baerly-storage` no longer exports `SnapshotBody`,
  `encodeSnapshotBody`, `snapshotKey`, `loadSnapshotAsMap`, `walkLogRange`,
  `probeTailFrom`, `resolveVerifier`, `collectionsToMaps` or
  `validateOrThrow`. `SchemaIssue` and `SchemaValidator` stay.
- `Db` loses its `@internal` read seams `collectionReadContext`,
  `getCurrentJson`, `getLogEntry`, `probeLogTail` and `probeLogChunk`, so
  `CurrentJson` and `TailProbeChunk` leave the public types.
- `@gusto/baerly-storage/maintenance` exports only `runScheduledMaintenance`,
  `MaintenanceTarget`, `MaintenanceOptions` and `MaintenanceResult`. Also
  gone from it: `runBoundedMaintenance`, `dispatchWriteTick`,
  `MaintenanceDispatch`, `parseMaintenanceEnv`, the fold-ceiling helpers,
  `InternalMaintenanceOptions` and `rebuildIndex`. `baerlyWorker` /
  `baerlyNode` wire the in-band write tick; it needs no import.
- `@gusto/baerly-storage/observability` no longer exports
  `logMaintenanceWarning`, `flushUnauthorizedAndRespond` or `ReadEnvelope`,
  and `ObservabilityContext` / `ObservabilityContextInit` drop their
  `maintenance` and `readEnvelope` fields. Work inside a context you create
  runs write-tick maintenance inline at the default caps.
- `ensureTable` (from `@gusto/baerly-storage/dev`) takes the collection
  under `collection`, not `table`, with no alias: `table` is a type error
  and, at runtime, `InvalidConfig`. Projects that only use the `baerlyDev`
  Vite plugin need no change.

```ts
// before
import { loadSnapshotAsMap, walkLogRange } from "@gusto/baerly-storage";
await ensureTable(storage, { app: "helpdesk", tenant: "demo", table: "tickets" });
// after
const rows = await db.collection("tickets").all();
await ensureTable(storage, { app: "helpdesk", tenant: "demo", collection: "tickets" });
```

## Dependency bumps

Bundled dependencies updated with no public API change: hono 4.13.2,
`@hono/node-server` 2.1.1, jose 6.2.9, `@rgrove/parse-xml` 4.2.3,
`@logtape/logtape` 2.3.1.
