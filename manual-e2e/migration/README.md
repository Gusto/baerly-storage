---
title: Old-binary migration harness
audience: maintainer
summary: "Installs published @gusto/baerly-storage 0.1.0 and 0.6.0 into scratch dirs, seeds a synthetic corpus with each version's own API, and dumps it with that version's own CLI. Input for the 0.7 cross-version proof."
last-reviewed: 2026-11-13
tags: [manual-e2e, migration]
related: ["../README.md"]
---

# Old-binary migration harness

Step 3 of the 0.7 migration proof. It produces buckets and dumps written by genuinely old published binaries, so a later release-candidate comparison does not rely on current code imitating the past.

```sh
pnpm migration:old-binary [--versions 0.1.0,0.6.0] [--out <dir>] [--bucket <uri-template>] [--seed N] [--rows N] [--tail-writes N]
```

Behind a corporate TLS proxy the harness adds `--use-system-ca` to `NODE_OPTIONS` itself. It needs network access to the public npm registry.

## What it does

1. `npm install --ignore-scripts @gusto/baerly-storage@<version>` into `<out>/<version>/`.
2. `seed-corpus.mjs` imports that install by absolute path and, using only that version's public API, writes a seeded synthetic corpus to a `file:///` bucket: an indexed `tickets` collection (`by_status`, composite `by_owner_status`), a plain `notes` collection, updates, deletes, nested values, `null` fields, non-ASCII ids (CJK, astral, fullwidth) and two non-NFC legacy ids (NFD `e` + U+0301, and U+212B), two folds (so one orphan snapshot), one `runGc` pass, then a live tail of `--tail-writes` (default 130) entries after the last fold. It self-checks full scans, point reads and index queries against its own model.
3. `baerly admin dump` from that same install writes `<out>/<version>/dump/<collection>.ndjson`; the harness checks it holds exactly the model's rows.

Outputs per version: `bucket/`, `expected.json` (model rows, index query answers, maintenance results, legacy ids), `dump/`. `<out>/manifest.json` lists them. The default `<out>` is a timestamped temp dir; the harness never deletes anything and refuses a non-empty bucket root.

## Bucket URI parameter

`--bucket` takes a URI template where `{version}` is substituted (default `file://<out>/<version>/bucket`). Seeding currently supports `file:///` only; Minio `s3://` seeding belongs to step 4 and needs a `Storage` factory in `seed-corpus.mjs`.

## Corpus limits observed on the old versions

- 0.6.0 rejects `/` in an `_id`; 0.1.0 accepts it but index-routed reads omit that row. Neither id is in the corpus.
- No id has an NFC/NFD twin: default macOS APFS folds them onto one file in `LocalFsStorage`.
- 0.1.0 writes `current.json` schema 1; 0.6.0 writes schema 3. Both write `content/` side objects and a `gc/` ledger.

## Not implemented here (step 4)

The release-candidate comparison: restore with the RC, re-dump and byte-compare, point/index/scan comparison against `expected.json`, `fsck`, `rebuild-index`, in-place open of the 0.6.0 bucket, and the restore drill.
