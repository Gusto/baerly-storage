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
old numbered log files, imports rows at new sequence numbers, and leaves
old objects for maintenance/GC. The `writer_fence` field is only bumped
to keep metadata monotone; it does not perform truncation or protect
against live writers.

Restore is row-committing, not file-atomic: malformed NDJSON or a
mid-stream storage failure leaves prior rows committed. Re-run with
`--force` into the scratch target, or choose a fresh recovery prefix.

On R2's Class A billing meter, a non-empty restore costs `2N + 2`
write-class operations for N rows: one initial `current.json`
seed/reseed write, one final metadata/tail write, and one content PUT
plus one committing `log/<seq>` create per restored row. An empty
restore performs only the initial `current.json` seed/reseed write.

For production recovery, treat restore as a cutover to a proven copy,
not as an overwrite of the live prefix. Do not restore over the live
prefix while writers are still active. The safe cutover shape is:

1. Pause writers or put the app in read-only mode.
2. Restore into a separate recovery bucket or tenant prefix.
3. Run `baerly admin fsck` on the recovered collection.
4. For indexed collections, run `baerly admin fsck --indexes
   --config=<compiled baerly config>` on the recovered collection. Plain
   restore imports rows; it does not rebuild secondary index markers. If
   the index check reports drift, run it with `--fix` or run
   `baerly admin rebuild-index` for each index before cutover.
5. Point the app at the recovered bucket/prefix. Prefer this to
   copying. If you must copy the recovery prefix into place, do it
   inside the maintenance window and copy `current.json` **last** —
   after the recovered collection's snapshot, log, content, and any
   rebuilt index objects exist at the destination. If `current.json`
   lands before snapshot/log/content, readers can reference missing
   objects; if index markers are missing, index-routed reads can miss
   rows.
6. Resume writers only after a successful authenticated read against
   the recovered route.

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
