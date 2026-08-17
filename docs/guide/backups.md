---
title: Backups via baerly admin dump
audience: operator
summary: Safe NDJSON backup, retention, restore, and restore-drill defaults.
last-reviewed: 2026-06-23
tags: [operations, backups, restore]
related: ["../about/cost-model.md", "operations.md"]
---

# Backups (`dump` + `restore`)

`baerly admin dump` is the backup stream: it writes canonical NDJSON
for one collection to stdout. NDJSON means one JSON object per line; the
dump sorts rows and object keys so repeated dumps can compare
byte-for-byte. Text mode is intentionally silent on success except for
that NDJSON body, so shell redirection is safe. `baerly admin restore`
is the matching import path: it reads the same format from stdin into a
fresh collection.

Backups are scoped to one `(app, tenant, collection)` stream. In bucket
terms, that collection lives under
`app/<app>/tenant/<tenant>/manifests/<collection>/`; if the bucket URI
contains a path prefix, this path sits under that prefix. Verify
recovery in a separate bucket or prefix before production cutover.

The safe default is:

- keep a checked-in inventory of production `(app, tenant,
collection)` triples to back up;
- use least-privilege storage credentials that can read the production
  prefix and write the backup destination, not broad account-admin
  credentials;
- credentials live in a `0600` env file owned by the job user, not crontab;
- dumps are written to a temp file, then atomically moved into place;
- files are mode `0600`;
- each dump gets a SHA-256 sidecar;
- retention is handled off-host when possible;
- restore is drilled into a separate bucket/prefix before it is needed.

## Daily Backup Script

Create one cron entry per production collection, or have an inventory
loop call the wrapper with explicit `(app, tenant, collection)`
arguments. Do not rely on "all collections" being discoverable from one
app directory unless you have verified that inventory separately.

Environment file, owned by the user running the job and mode `0600`:

```sh
# /etc/baerly/backup.env
export BAERLY_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
export BAERLY_S3_ACCESS_KEY_ID=AKIA...
export BAERLY_S3_SECRET_ACCESS_KEY=...
export BAERLY_S3_REGION=us-east-1
export BAERLY_BUCKET=s3://baerly-prod
```

Wrapper `/opt/baerly/bin/backup.sh`:

```sh
#!/usr/bin/env bash
set -euo pipefail
umask 077

# cron runs with cwd=$HOME (or /); use an explicit cwd so
# cwd-relative config and tooling resolve predictably.
cd /opt/baerly/app

APP="$1"
TENANT="$2"
COLLECTION="$3"
DATE="$(date -u +%Y-%m-%dT%H%M%SZ)"
RETAIN_DAYS="${RETAIN_DAYS:-30}"
OUT_DIR="${OUT_DIR:-/var/backups/baerly}"

. /etc/baerly/backup.env

install -m 0700 -d "$OUT_DIR"
FINAL="${OUT_DIR}/${APP}-${TENANT}-${COLLECTION}-${DATE}.ndjson"
TMP="$(mktemp "${FINAL}.tmp.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

baerly admin dump \
  --bucket="$BAERLY_BUCKET" \
  --app="$APP" \
  --tenant="$TENANT" \
  --collection="$COLLECTION" \
  > "$TMP"

mv "$TMP" "$FINAL"
trap - EXIT
# Checksum after the rename so the sidecar records the final basename,
# not the mktemp path. The restore drill verifies with a matching `cd`.
( cd "$(dirname "$FINAL")" && shasum -a 256 "$(basename "$FINAL")" > "$(basename "$FINAL").sha256" )

find "$OUT_DIR" -name "${APP}-${TENANT}-${COLLECTION}-*.ndjson" \
  -type f -mtime +"${RETAIN_DAYS}" -delete
find "$OUT_DIR" -name "${APP}-${TENANT}-${COLLECTION}-*.ndjson.sha256" \
  -type f -mtime +"${RETAIN_DAYS}" -delete
```

Cron should call the wrapper, not inline credentials:

```cron
0 3 * * * /opt/baerly/bin/backup.sh acme t1 tickets >> /var/log/baerly-backup.log 2>&1
```

For off-host retention, copy `"$FINAL"` and `"$FINAL.sha256"` to a
backup bucket after the checksum step, then let that bucket's lifecycle
policy expire old dumps. Prefer that to keeping the only backup on the
same disk as the app.

The temp-file/rename sequence prevents a failed dump command from
replacing the last good dump. With `set -euo pipefail`, a failed dump
may leave only the temporary file removed by the trap; it never gets
moved into place.

`admin dump` exits `0` on success, `1` on `InvalidConfig` (bad bucket
URI, missing args, or collection not found), `2` on storage / network
failure, and `3` on a protocol invariant. The distinct codes let a
wrapper branch on the failure class.

Keep backup stdout as data only. Do **not** use `--json` when
redirecting `admin dump` stdout to an `.ndjson` file: JSON mode writes a
success envelope to stdout after the dump body, corrupting the backup.
Use text mode for backup files.

## Restore

First probe the recovery bucket. This writes and deletes throwaway
sentinels to verify the S3 conditional-write contract: stale `If-Match`
updates fail, `If-None-Match: "*"` refuses existing keys, and concurrent
create-if-absent writes have one winner.

```sh
baerly doctor --bucket=s3://baerly-recovery
```

Restore into an empty bucket/prefix:

```sh
baerly admin restore \
  --bucket=s3://baerly-recovery \
  --app=acme \
  --tenant=t1 \
  --collection=tickets \
  < /var/backups/baerly/acme-t1-tickets-2026-06-12T030000Z.ndjson
```

If the target collection's `current.json` already exists, restore
refuses with `Conflict`. With `--force`, restore does not delete old
objects first. It moves the collection's starting log position past the
old numbered log files and imports rows at new sequence numbers.
Maintenance can later reclaim the surviving `log/` objects via
computed-range retirement, once the new generation's fold floor advances
past them, and orphan snapshots via GC. Legacy `content/` side objects
remain untouched and require the optional, writers-quiesced disposal
described in [Legacy content cleanup](#legacy-content-cleanup) below.
The `writer_fence` field is only bumped to keep metadata monotone; it does
not perform truncation or protect against live writers.

Before a force restore or any copy-in-place workflow, stop writers, stop
new `runScheduledMaintenance` calls, and wait for every in-flight
compaction and GC pass to finish. Clearing `gc/pending.json` cannot fence
a GC pass that already loaded old candidates; such a pass can otherwise
delete log keys recreated by the restore.

Restore is row-committing, not file-atomic: malformed NDJSON or a
mid-stream storage failure leaves prior rows committed. Re-run with
`--force` into the scratch target, or choose a fresh recovery prefix.

On R2's Class A billing meter, before any in-band maintenance from a
long import, restore's base billable shapes are: fresh non-empty `N + 2`
for N rows (initial `current.json` seed, one committing `log/<seq>`
create per row, final metadata/tail write); force non-empty `N + 2 + P`;
fresh empty `1`; and force empty `1 + P`. `P` is the number of provider
LIST pages consumed by the one `Storage.list()` iterator in
`tailFromListedLogKeys`; one iterator invocation can issue multiple
billable LIST requests. Maintenance adds the same measured profile
overhead as the main cost model.

For production recovery, treat restore as a cutover to a proven copy,
not as an overwrite of the live prefix. Do not restore over the live
prefix while writers are still active.

Long-poll readers no longer need draining. A `--force` reseed re-mints
the collection's `generation` nonce, and every `/v1/since` cursor
carries the generation it was minted under, so a stale pre-restore
cursor is rejected with a `SchemaError` (HTTP 400) telling the client to
re-bootstrap. The React client (`useQuery` subscriptions) acts on that
automatically: it drops the cursor and resumes from the collection's log
floor. A custom `/v1/since` consumer must handle the 400 the same way —
restart with an empty cursor rather than retrying the rejected one.

This closes a real hazard rather than merely documenting it. A `--force`
reseed can lower the live log floor (`log_seq_start`), and the older
protocol detected a dead cursor only by testing its seq against that
floor — so a lowered floor let a stale cursor pass, silently resume into
the new generation, and miss every restored row beneath it. See
invariant 13 in [the sync protocol spec](../spec/sync-protocol.md).

The safe cutover shape is:

1. Pause writers or put the app in read-only mode, stop new
   `runScheduledMaintenance` calls, and wait for in-flight compaction and
   GC passes to finish.
2. Restore into a separate recovery bucket or tenant prefix.
3. Run `baerly admin fsck` on the recovered collection.
4. For indexed collections, run `baerly admin fsck --indexes
   --config=<compiled baerly config>` on the recovered collection. Plain
   restore imports rows; it does not rebuild secondary index markers. If
   the index check reports drift, run it with `--fix` or run
   `baerly admin rebuild-index` for each index before cutover.
5. Point the app at the recovered bucket/prefix. This direct route
   cutover is preferred, and it is the only route that rewrites no keys.
6. If infrastructure requires a raw object copy instead, copy into a
   separate bucket or storage namespace at the **identical
   bucket-relative collection path**. `current.snapshot` and every
   `gc/pending.json` candidate store complete bucket-relative keys, so a
   copy that lands the same objects under a different collection path
   leaves the snapshot pointer aimed at a key that does not exist and
   gives the destination's GC candidates that address the *source*
   prefix. If the destination collection path differs at all, do not
   relocate objects — run `baerly admin restore` directly into that
   final, fresh prefix. When the path does match:
   - Copy into a fresh, empty destination collection prefix only; never
     overlay recovery objects onto a prefix that contains an older
     collection generation. Old higher-numbered `log/` objects are not
     fenced by `current.json`: readers forward-probe past the restored
     `tail_hint` and can replay a consecutive old suffix.
   - Copy only after writers and maintenance have drained, inside the
     maintenance window.
   - Do not copy `gc/pending.json`. Its candidates name source-prefix
     keys under the source generation; the destination bootstraps a
     fresh ledger on its first GC pass.
   - Copy `current.json` **last** — after the snapshot it names (when
     non-null), every live log object, and rebuilt index objects
     required by indexed reads exist at the destination. If
     `current.json` lands first, readers can reference missing objects;
     if required index markers are missing, index-routed reads can miss
     rows.
   - No kernel reader depends on content side objects, and GC does not
     touch them. Copy `content/` only when preserving a legacy or
     mixed-version bucket for legacy writers or tooling. Otherwise skip
     it. See [Legacy content cleanup](#legacy-content-cleanup) to reclaim
     the source bytes safely.
7. Run `baerly admin fsck` (plus `--indexes` for indexed collections)
   against the final destination — the exact route the app will read —
   before enabling reads. Step 3 checked the recovery prefix, not the
   copy.
8. Resume writers only after a successful authenticated read against
   the recovered route.

### Legacy content cleanup

No cleanup of legacy `content/` side objects is required for correctness
or migration. They are inert; delete them only to reclaim storage, after
all legacy writers are quiesced.

Build the deletion target from the exact configured bucket URI, including
its optional key prefix, then append
`app/<app>/tenant/<tenant>/manifests/<collection>/content/`. For example,
`s3://bucket/prod` targets
`s3://bucket/prod/app/acme/tenant/t1/manifests/tickets/content/`; dropping
`prod/` would address a different namespace. Before any recursive delete,
review a provider inventory/listing or dry run and confirm that the full
prefix contains only the intended collection's legacy content objects.

For AWS S3 only:

```sh
# Copy the exact configured URI, including any bucket key prefix.
CONTENT_PREFIX='s3://bucket/prod/app/acme/tenant/t1/manifests/tickets/content/'
aws s3 rm --recursive --dryrun "$CONTENT_PREFIX"
# After reviewing the dry run:
aws s3 rm --recursive "$CONTENT_PREFIX"
```

For R2, MinIO, and native GCS, use the configured endpoint or provider
tooling against the identical full prefix; the AWS command is not portable
to those providers.

## Restore Drill

At least once per retention window, run a restore drill: verify the
checksum, restore the dump, and run `fsck` against the recovered
collection.

```sh
DUMP=/var/backups/baerly/acme-t1-tickets-2026-06-12T030000Z.ndjson
# The sidecar records the dump's basename, so verify from its directory.
( cd "$(dirname "$DUMP")" && shasum -a 256 -c "$(basename "$DUMP").sha256" )

baerly admin restore \
  --bucket=s3://baerly-restore-drill \
  --app=acme \
  --tenant=t1-restore-drill \
  --collection=tickets \
  --force \
  < "$DUMP"

baerly admin fsck \
  --bucket=s3://baerly-restore-drill \
  --app=acme \
  --tenant=t1-restore-drill \
  --collection=tickets
```

For indexed collections, add index reconciliation to the drill before
testing indexed routes:

```sh
baerly admin fsck \
  --bucket=s3://baerly-restore-drill \
  --app=acme \
  --tenant=t1-restore-drill \
  --collection=tickets \
  --indexes \
  --fix \
  --config=./dist/baerly.config.mjs
```

For byte-level confidence, dump the restored collection and compare:

```sh
baerly admin dump \
  --bucket=s3://baerly-restore-drill \
  --app=acme \
  --tenant=t1-restore-drill \
  --collection=tickets \
  > /tmp/tickets-restored.ndjson

cmp "$DUMP" /tmp/tickets-restored.ndjson
```

This comparison proves the materialized rows, not secondary index
markers. Use the indexed `fsck` step above for indexed collections.
