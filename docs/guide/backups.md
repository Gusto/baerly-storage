---
title: Backups via baerly admin dump
audience: operator
summary: Daily NDJSON dump with retention rotation; restoring from any dump file.
last-reviewed: 2026-05-27
tags: [operations, backups, restore]
related: ["../about/cost-model.md"]
---

# Backups (`dump` + `restore`)

`baerly admin dump` emits canonical NDJSON of a collection's
materialised view to stdout. Pair it with file-system rotation to
get a portable, dated backup. Restore is the inverse: NDJSON in,
fresh collection out via `baerly admin restore`.

## Daily cron with 7-day retention

`crontab` line:

```
0 3 * * *  env BAERLY_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com \
                BAERLY_S3_ACCESS_KEY_ID=AKIA... \
                BAERLY_S3_SECRET_ACCESS_KEY=... \
            /opt/baerly/bin/backup.sh acme t1 tickets \
            >> /var/log/baerly-backup.log 2>&1
```

Wrapper `/opt/baerly/bin/backup.sh` (`chmod +x`):

```sh
#!/usr/bin/env bash
set -euo pipefail
APP="$1"; TENANT="$2"; COLLECTION="$3"
DATE="$(date -u +%Y-%m-%d)"
RETAIN_DAYS=7
OUT_DIR=/var/backups/baerly
mkdir -p "$OUT_DIR"

baerly admin dump \
  --bucket=s3://baerly-prod \
  --app="$APP" \
  --tenant="$TENANT" \
  --collection="$COLLECTION" \
  > "${OUT_DIR}/${APP}-${TENANT}-${COLLECTION}-${DATE}.ndjson"

find "$OUT_DIR" -name "${APP}-${TENANT}-${COLLECTION}-*.ndjson" \
    -type f -mtime +"${RETAIN_DAYS}" -delete
```

Exit-code contract: `baerly admin dump` exits non-zero on every
failure (1 = bad args / `InvalidConfig`, 2 = storage / network,
3 = protocol invariant). `set -e` fails the cron run loudly;
cron's default mail behaviour routes stderr to the operator. Pass
`--json` to switch the success / error envelope to structured
JSON on stdout / stderr — useful when the wrapper consumes
`baerly`'s output programmatically or when an agent drives the
backup.

Off-host: replace the local `OUT_DIR` redirect with a pipe to
`aws s3 cp - s3://baerly-backups/${APP}-${TENANT}/${DATE}.ndjson`
and let S3 lifecycle handle retention instead of `find -mtime`.

## Storage cost

A dump's footprint is roughly 1× the materialised view, encoded as
canonical NDJSON (one row per line, ASCII-lex key order, no
whitespace). The dump is byte-stable, so two semantically-equal
collections produce byte-equal output — handy for diffing dated
backups.

## Restoring

Restore an empty bucket from any dump file:

```sh
baerly admin restore \
  --bucket=s3://baerly-recovery \
  --app=acme \
  --tenant=t1 \
  --collection=tickets \
  < /var/backups/baerly/acme-t1-tickets-2026-05-20.ndjson
```

If the target already has rows, pass `--force` to truncate first
(bumps the writer fence and reseeds `current.json`). Per-row cost
is 3 Class A ops per restored row + 1 PUT to seed `current.json`,
so plan for `3N + 1` ops where N is the row count.
