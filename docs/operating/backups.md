---
title: Backups via baerly copy
audience: operator
summary: Cost-aware bucket-to-bucket point-in-time copy procedure with retention example.
last-reviewed: 2026-05-12
tags: [operations, backups, copy]
related: ["../cost-model.md"]
---

# Backups (`baerly copy`)

`baerly copy` takes a point-in-time copy of a Baerly collection
bucket-to-bucket. It bypasses write-path compaction — emitting one
L9 snapshot directly at the target — so cost is on the order of
"snapshot + live tail", not "rows".

This `copy` shape mirrors Turbopuffer's `copy_from_namespace` 75%
write discount — the same physical insight: the source already paid
for the fold.

## Daily cron with 7-day retention

`crontab` line:

```
0 3 * * *  env BAERLY_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com \
                BAERLY_S3_ACCESS_KEY_ID=AKIA... \
                BAERLY_S3_SECRET_ACCESS_KEY=... \
            /opt/baerly/bin/backup.sh tickets acme \
            >> /var/log/baerly-backup.log 2>&1
```

Wrapper `/opt/baerly/bin/backup.sh` (`chmod +x`):

```sh
#!/usr/bin/env bash
set -euo pipefail
APP="$1"; TENANT="$2"
DATE="$(date -u +%Y-%m-%d)"
RETAIN_DAYS=7
CURRENT_JSON_KEY="app/${APP}/tenant/${TENANT}/manifests/${APP}/current.json"

ETAG="$(aws s3api head-object --bucket baerly-prod --key "$CURRENT_JSON_KEY" \
        --query ETag --output text | tr -d '"')"
[ -z "$ETAG" ] && { echo "no source ETag" >&2; exit 2; }

baerly copy \
  --from=s3://baerly-prod \
  --from-snapshot="${CURRENT_JSON_KEY}@${ETAG}" \
  --to="s3://baerly-backups/${DATE}"

CUTOFF="$(date -u -d "${RETAIN_DAYS} days ago" +%Y-%m-%d)"
aws s3 ls s3://baerly-backups/ | awk '{print $2}' | tr -d '/' | \
  while read -r d; do
    [ -n "$d" ] && [ "$d" \< "$CUTOFF" ] && \
      aws s3 rm --recursive "s3://baerly-backups/$d/"
  done
```

Exit-code contract: `baerly copy` exits non-zero on every failure.
`set -e` fails the cron run loudly; cron's default mail behaviour
routes stderr to the operator. Pass `--json` to switch output to
structured envelopes (`{result:...}` on stdout for success,
`{error:{code,message,command}}` on stderr for failure) — useful
when the wrapper script consumes `baerly`'s output programmatically
or when an agent drives the copy.

## Storage cost

A backup's footprint is ~1× the source's snapshot plus the live
tail at cursor time. Under
`NODE_PROFILE.compactor.minEntriesToCompact = 100` the live tail is
bounded at ~100 entries; the snapshot dominates.

## Restoring

Run `baerly copy --from=<backup-uri> --from-snapshot=<backup-cursor>
--to=<recovery-uri>`. The backup bucket's `current.json` carries
the cursor; read its key + ETag via `aws s3api head-object`.
