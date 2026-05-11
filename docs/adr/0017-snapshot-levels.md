# 0017 — Chunked level-based snapshot layout

## Status

Accepted.

## Context

Compaction has to bound idle-poll cost
([ADR-0015](./0015-cost-ceiling.md): `< 1 Class A op / writer / hour`)
and keep the manifest log from growing unboundedly. The layout
choice for snapshot files determines both whether the bound holds
and whether partial writes are recoverable.

Three options were considered:

- **Single monolithic snapshot.** Every compaction rewrites one
  well-known key, every writer competes on it, and a partial write
  leaves readers stranded.
- **Litestream-style multi-level rolling snapshots.** A small fixed
  number of levels (`L0`, `L1`, …, `L9`), chunked files keyed by
  sequence range, compaction merging lower levels upward. Random
  GETs are cheap on S3-compatible storage; LIST is what to avoid.
- **WAL checkpointing in the rqlite / Raft tradition.** Requires a
  consensus layer Baerly explicitly does not have.

The dominant failure mode is partial writes: S3 has no atomic multi-
object write, so a snapshot file must be *unpickable* if its body
doesn't match the name. A content-addressed key gives that for free
— the filename carries the hash, the reader recomputes it, a
mismatch is a definitive skip.

## Decision

Snapshots use a content-hashed, zero-padded, level-prefixed key:

```
<tablePrefix>/snapshot/L<level>/<min>-<max>-<sha256>.json
```

`min` and `max` are zero-padded to 12 digits so lex-order matches
numeric order; `sha256` is 64 hex characters of the canonical body
hash. The key format and the constants `SNAPSHOT_LEVEL = 9` and
`SEQ_DIGITS = 12` live inline at
[`packages/server/src/compactor.ts:40-111`](../../packages/server/src/compactor.ts):
`snapshotKey()` refuses malformed inputs, `SnapshotBody` carries
`schema_version`, `min_seq`, `max_seq`, `collection`, and `docs`
sorted by `_id` for deterministic byte output, and
`encodeSnapshotBody()` is the single canonical serializer. The
`snapshot` pointer and `log_seq_start` cursor on `CurrentJson` at
[`packages/protocol/src/coordination/current-json.ts:65-95`](../../packages/protocol/src/coordination/current-json.ts)
tell the reader where to start the log walk: consume the snapshot,
then read `[log_seq_start, next_seq)`.

## Consequences

- Multiple snapshot files per collection — bounded but more than
  one. Idle-poll cost stays low because the reader walks
  `current.json` and follows the pointer; no LIST is required.
- Partial writes are self-defeating: a crash mid-snapshot leaves a
  name/body mismatch and readers skip it. Re-running the compactor
  produces a byte-identical body and therefore the same filename, so
  retry is idempotent.
- Today's compactor writes single-level snapshots at `L9`: one
  snapshot replaces the prior, no multi-level merge yet. The key
  format is forward-compatible with future rolling merges across
  `L0` / `L1` / … / `L9` without a wire change.
- The 12-digit `SEQ_DIGITS` cap supports roughly one trillion
  entries per collection before key overflow; crossing that ceiling
  is a future-Phase concern.
- GC removes log entries below `log_seq_start` after a read-repair
  grace period; orphan-snapshot cleanup falls out of the same
  mark-and-sweep pass.
- Snapshot bodies carry their own forward-only `schema_version: 1`
  ([ADR-0016](./0016-schema-migration.md)) independent of the
  per-entry stamp on `LogEntry`. Snapshots key off the same
  `(tenant, collection)` prefix that backs the CAS scope
  ([ADR-0011](./0011-cas-scope.md)); the export tool
  ([ADR-0013](./0013-export-contract.md)) reads the snapshot plus
  the live-tail log replay, not the log alone.
