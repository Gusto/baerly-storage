---
title: Backups via baerly admin dump
audience: operator
summary: Safe NDJSON backup, retention, restore, and restore-drill defaults.
last-reviewed: 2026-06-13
tags: [operations, backups, restore]
related: ["../about/cost-model.md", "operations.md"]
---

# Backups (`dump` + `restore`)

`baerly admin dump` writes canonical NDJSON for one collection to
stdout. Text mode is intentionally silent on success except for that
NDJSON body, so shell redirection is safe. `baerly admin restore`
reads the same format from stdin into a fresh collection.

The safe default is:

- keep a checked-in inventory of production `(app, tenant,
collection)` triples to back up;
- use least-privilege storage credentials that can read the production
  prefix and write the backup destination, not broad account-admin
  credentials;
- credentials live in a root-readable env file, not crontab;
- dumps are written to a temp file, then atomically moved into place;
- files are mode `0600`;
- each dump gets a SHA-256 sidecar;
- retention is handled off-host when possible;
- restore is drilled into a separate bucket/prefix.

## Daily Backup Script

Create one cron entry per production collection, or wrap this script
with your own inventory loop. Do not rely on "all collections" being
discoverable from one app directory unless you have verified that
inventory separately.

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

# cron runs with cwd=$HOME (or /); cd into the app dir so `baerly`
# picks up the project's baerly.config.ts (paths are cwd-relative).
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
backup bucket after the `mv`, then let that bucket's lifecycle policy
expire old dumps. Prefer that to keeping the only backup on the same
disk as the app.

`set -euo pipefail` makes the wrapper abort on any non-zero exit, so a
failed dump never gets atomically moved into place. `admin dump` exits
`0` on success, `1` on `InvalidConfig` (bad bucket URI, missing args, or
collection not found), `2` on storage / network failure, and `3` on a
protocol invariant — the
distinct codes let a wrapper branch on the failure class. Do **not** use
`--json` when redirecting `admin dump` stdout to an `.ndjson` file: the
dump body is the data stream, and JSON-mode envelopes can contaminate
the backup. Use text mode for backup files. Use `--json` only for
commands whose stdout is not the dump stream, or call the programmatic
dump helper with separate data and status streams.

## Restore

First probe the recovery bucket. This writes and deletes a throwaway
sentinel and proves the target honors the CAS contract:

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

If the target already exists, restore refuses with `Conflict`. Passing
`--force` truncates by reseeding `current.json` above the old tail (the
writer fence is dormant metadata hygiene, not the truncation mechanism),
then imports rows at fresh sequence numbers. Use `--force` for
rehearsals against a scratch prefix, not as a casual production habit.

Partial restore semantics are deliberate: if stdin contains malformed
NDJSON or storage fails mid-stream, rows committed before the failure
remain committed. Re-run with `--force` into the same target, or choose
a fresh recovery prefix.

Cost is `2N + 2` Class A ops for N rows: one truncate/reseed write,
one metadata/tail write, and one content PUT plus one committing
`log/<seq>` create per restored row.

For production recovery, do not restore over the live prefix while
writers are still active. The safe cutover shape is:

1. Pause writers or put the app in read-only mode.
2. Restore into a separate recovery bucket or tenant prefix.
3. Run `baerly admin fsck` on the recovered collection.
4. Point the app at the recovered bucket/prefix. Prefer this to
   copying. If you must copy the recovery prefix into place, do it
   inside the maintenance window and copy `current.json` **last** —
   after the snapshot, log, content, _and_ index objects it references
   exist at the destination. A `current.json` that lands before its
   referenced objects is a broken head: a reader following it errors on
   the missing snapshot/log, and a missing index marker silently drops
   rows from an index-routed read.
5. Resume writers only after a successful authenticated read against
   the recovered route.

## Restore Drill

At least once per retention window:

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
