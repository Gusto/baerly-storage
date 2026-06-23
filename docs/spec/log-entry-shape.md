---
title: LogEntry wire shape
audience: spec
summary: "Debezium-style JSON CDC envelope (pgoutput message-tag vocabulary) LogEntry; the CDC wire contract (pre-launch: may still narrow)."
last-reviewed: 2026-06-23
tags: [protocol, log, cdc, contract]
related: [sync-protocol.md]
---

# Log entry shape

Every successful document mutation leaves one JSON `LogEntry` under
`<collection-prefix>/log/<seq>.json`. The object key is ordered by
the integer `seq`; the entry also carries an opaque `lsn` string so
CDC clients and future log-replay exporters have a resumable cursor.
This page is the contract behind that emission: the field set, the
field semantics, what we borrowed from Postgres logical replication,
what we deliberately did not, and the stability rules for future
change.

**Pre-launch (today): the shape may still narrow.** No external
consumers exist; we may rename, remove, or repurpose fields to
honestly reflect what the writer emits today. Once the first
production consumer ships, the shape is fixed: consumers ack on
`lsn`, the JSON keys become public, and renaming, removing, or
repurposing a field becomes a major-version migration. New
optional fields can be added at any time, pre- or post-launch.

The canonical TypeScript definition lives in
[`packages/protocol/src/log.ts`](../../packages/protocol/src/log.ts).
Every emitted entry conforms to that interface.

## Why we emit it

The log gives downstream systems one stable thing to replay. They do
not need to understand snapshots, compaction, or index cleanup; they
walk `LogEntry` records in causal order and apply each mutation.

Concretely, today's `baerly export --target=postgres` path folds these
records into a materialised view and emits snapshot `INSERT` rows. A
future log-replay exporter could translate the same records into
Postgres `INSERT` / `UPDATE` / `DELETE` statements, and a future
`/cdc/v1/stream?since=<lsn>` SSE endpoint would translate each entry
into a Debezium-style envelope on the wire. Streaming consumers ack
against `lsn`; all of these paths rely on the field set being stable.

## The shape

```ts
export interface LogEntry {
  lsn: string; // <base32-time>_<session>_<seq>
  commit_ts: string; // ISO-8601 ms
  op: "I" | "U" | "D";
  collection: string;
  doc_id: string; // I/U/D
  after?: DocumentData; // I/U
  before?: DocumentData; // when replica_identity = FULL
  key_old?: { readonly [pk: string]: JSONValue };
  origin?: string;
  session: string;
  seq: number;
}
```

`I`, `U`, and `D` mean insert, update, and delete. The
`replica_identity` setting controls the pre-image fields (`before`
and `key_old`); today every collection runs as `PATCH_ONLY`, described
below. The TypeScript interface is the source of field names and
types; this page is the prose wire contract.

### Field requirement matrix

| Field        | I   | U   | D   | Notes                                                    |
| ------------ | --- | --- | --- | -------------------------------------------------------- |
| `lsn`        | ✓   | ✓   | ✓   | Always present.                                          |
| `commit_ts`  | ✓   | ✓   | ✓   | ISO-8601 ms.                                             |
| `op`         | ✓   | ✓   | ✓   | One ASCII char.                                          |
| `collection` | ✓   | ✓   | ✓   | Collection name bound to this `current.json`.            |
| `doc_id`     | ✓   | ✓   | ✓   | Document primary key (`_id`).                            |
| `after`      | ✓   | ✓   |     | Post-image (Debezium's `after`).                         |
| `before`     |     | ✓   | ✓   | Iff `replica_identity === "FULL"` (Debezium's `before`). |
| `key_old`    |     | ✓   | ✓   | When `replica_identity !== "PATCH_ONLY"`.                |
| `origin`     | ?   | ?   | ?   | Optional ORIGIN analogue.                                |
| `session`    | ✓   | ✓   | ✓   | Embedded in `lsn`; surfaced for dedupe.                  |
| `seq`        | ✓   | ✓   | ✓   | Embedded in `lsn`; surfaced for ordering.                |

## Storage layout

Every emitted entry lands at:

```
<bucket>/<collection-prefix>/log/<seq>.json
```

Each mutated document gets its own numbered object instead of being
packed into a batch: a reader can ask for `log/17.json` directly, and
a writer commits by creating the first empty `log/<seq>.json` object.

More precisely, per-seq entries keep each entry independently
fetchable so readers, compaction, and the
`/v1/since?collection=<name>&cursor=<opaque>` change-feed route can
reconstruct the committed range directly from `current.json`.
`current.json` carries the snapshot pointer, `log_seq_start`, and the
non-authoritative `tail_hint` floor; consumers GET the trusted range
`[log_seq_start, tail_hint)` and then forward-probe to the first
missing entry. The cost is one extra PUT per mutated document; the
benefit is deterministic `GET log/<seq>.json` over that range.
The full read algorithm is in
[`sync-protocol.md`](sync-protocol.md#read-algorithm).

### Content body layout

For `I` / `U` entries, document bodies also land in side objects:

```
<bucket>/<collection-prefix>/content/<hash>.json
```

`LogEntry.after` still carries the full JSON post-image inline. The
side object is the storage copy keyed by content hash, where `<hash>`
is the **first 32 hex chars (128 bits) of `sha256(body)`**, lowercase.
The truncation is intentional: 128 bits is comparable to and stronger
than UUIDv4's 122 random bits, and gives a birthday-bound collision
probability of ~1.5 × 10⁻²¹ at N=10⁹ writes (≈ N² / 2¹²⁹) — far below
any plausible per-bucket write volume. A collision is **not** detected
at runtime: two distinct bodies sharing a truncated hash alias to one
content key, so the side content artifact cannot distinguish them. The
log fold itself still reads `LogEntry.after` inline. The probability
bound is the only guard for the side object. External consumers
reproducing content keys MUST truncate to 32 hex chars; hashing to the
full 64-char SHA-256 will not match the key on the bucket.

A common interoperability mistake is to treat the hash as a digest of
"the JSON value." It is not. It is a digest of the exact bytes the
writer emits.

**`body` is the exact bytes of `encodeJsonBytes(value)` —
`JSON.stringify(value)` UTF-8-encoded, with NO replacer and NO key
sorting** (`packages/protocol/src/bytes.ts`). Property order is
ECMAScript `JSON.stringify` order: array-index-like keys first, then
other string keys in insertion order. This is _not_ the canonical
(ASCII-lex-sorted) encoding that `baerly admin dump` uses for
byte-stable backups — content hashing is deliberately not
canonicalized.

Same body **bytes** ⇒ same content key. The scope of this guarantee is
**single-writer idempotent replay**: a crash-recovery rewrite of the
same in-memory value by the same writer reproduces the same content key
the side object uses (the `ifNoneMatch: "*"` content PUT then no-ops).
It is **NOT** a cross-writer content-dedup guarantee: two writers
serializing a logically-equal document to different `JSON.stringify`
bytes — for example after a read → merge → re-serialize round-trip,
where `merge` spreads `{...target}` and key order is
insertion-dependent for non-index string keys — produce **different**
content keys for the same logical value. Constant lives at
`VERSION_HEX_LENGTH` in `packages/protocol/src/hashing.ts`.

## Cursor format

`lsn` is a resume token, not the storage key. It carries enough
information for `/v1/since` to resume from a cursor, but the committed
object is still found by integer `seq`.

More precisely, `lsn` has shape `<base32-time>_<session>_<seq>`:

- **`<base32-time>`** is `Math.ceil(42/5) = 9` chars,
  base-32-encoded with **descending** ordering — newer epochs sort
  lex-EARLIER. (See `uint2strDesc` in
  [`packages/protocol/src/types.ts`](../../packages/protocol/src/types.ts).)
- **`<session>`** is a 6-char hex prefix of a UUID, freshly minted per
  `Writer.commit` / per `LogEntry` by the stateless `Writer`.
- **`<seq>`** is `countKey(seq)`, a fixed-width opaque base-32
  descending token for the integer log sequence. The integer `seq` is
  the first empty log slot found by the writer's forward-probe from
  `max(log_seq_start, tail_hint)`; it is monotonic per collection and
  stable across process restart. The exact character width is an
  internal encoding detail (`COUNT_BIT_WIDTH` in
  `packages/protocol/src/constants.ts`); consumers must not hard-code
  it.

Two orderings are present; only `seq` orders the committed log. Within
a single collection, `seq` ascends in causal order and is the ordering
authority. The kernel and the
`/v1/since?collection=<name>&cursor=<opaque>` change-feed route
reconstruct `log/<seq>.json` keys directly; they do not list by `lsn`
or sort by the wall-clock prefix. Consumers that already have
`LogEntry` records in hand should order by `seq`.

The descending timestamp encoding is a cursor property for external
LSN-shaped keyspaces, not a kernel correctness dependency.

Every mutation mints exactly one `lsn` — one per `LogEntry`.
`Writer.commit` writes a single document per call.

## Alternatives considered

Three shapes were on the table:

- **Ad-hoc JSON tailored to baerly-storage's internals.** Cheap to
  design, but traps the export tooling inside baerly-storage — anyone
  reading the log learns a baerly-storage-specific schema with no
  analog in the ecosystem.
- **`pgoutput` wire format verbatim.** The Postgres logical-
  replication output plugin is the obvious binary reference, but
  adopting it byte-for-byte would require BEGIN/COMMIT framing,
  LSN byte structure, TYPE messages, streaming-in-progress
  variants, and two-phase commit framing — overkill for a
  document store with no statement-level decoding.
- **Debezium-style JSON envelope using `pgoutput`'s message-tag
  vocabulary.** Keep pgoutput's `I` / `U` / `D` tags as the `op`
  discriminator and adopt Debezium's `before` / `after` field
  names — the JSON-friendly form already widely understood by
  Postgres-CDC consumers. Delivery stays object-store-native:
  one append-only JSON object per integer `seq`, plus an opaque
  `lsn` cursor consumers ack against. This borrows vocabulary from
  pgoutput/Debezium without their wire framing. **Chosen.**

## What we borrowed from `pgoutput`

We borrow vocabulary from Postgres `pgoutput` because Postgres CDC
consumers recognize it and future log-replay export paths can map it
directly. From the Postgres logical-replication wire protocol we
borrowed:

- **`I` / `U` / `D`** — the message tags. Map to
  Debezium's `op:c/u/d` envelope.
- **`after` (post-image) and `before` (pre-image, gated)** — the
  Debezium field names directly. The post-image is required for
  `I` / `U`; the pre-image is gated by `replica_identity = FULL`.
- **`collection` as RELATION analogue** — what Postgres calls a
  table.
- **`replica_identity` per relation** — `PATCH_ONLY` / `FULL`,
  named after Postgres's `REPLICA IDENTITY DEFAULT` / `FULL`.
- **`origin`** — Postgres's ORIGIN identifies the replication
  source so loopback writes can be filtered.

## What we deliberately did NOT borrow

- **`BEGIN` / `COMMIT` framing.** baerly-storage has no multi-document
  transactions; each entry is its own atomic unit. A consumer
  expecting atomic batch-apply on a shared `commit_lsn` would be
  confused.
- **2PC messages (`b` / `P` / `K` / `r`).** No prepared txns in S3.
- **Streaming-in-progress (`S` / `E` / `c` / `A`).** baerly-storage
  entries are already small: one committed post-image or tombstone for
  one document.
- **`TYPE` messages.** JSON is self-describing; no `CREATE TYPE`
  analogue.
- **`REPLICA IDENTITY USING INDEX`.** PK is always `_id`; no
  multi-column unique alternative.
- **TOAST `'u'` (unchanged) elision.** Write-input merge patches
  encode "didn't touch" via key absence, while emitted
  `LogEntry.after` remains a complete post-image — no separate
  sentinel needed.
- **LSN bytes.** Postgres LSNs are 64-bit byte positions and bytes
  matter. baerly-storage's `lsn` is already an opaque string cursor;
  reusing it avoids inventing a parallel cursor.

## `replica_identity`

A per-collection setting that controls how much pre-image data
each `U` / `D` entry carries:

- **`PATCH_ONLY` (default; today's only mode).** `U` carries
  `{ after }`; `D` carries no `before` and no `key_old`.
  Bandwidth-cheap. SQL consumers rebuilding before-images need to
  maintain a shadow table.
- **`FULL`.** `U` carries `after`, `before`, and `key_old`; `D` carries
  `before` and `key_old`. ~2× log size on update-heavy collections;
  buys 1:1 logical replication and "previous value" answerable from
  the log alone.

Per-collection opt-in is not wired yet; every collection is
currently `PATCH_ONLY`. The `ReplicaIdentity` type and `before` /
`key_old` fields exist now so the shape is future-compatible.

## Consumer envelope sketch

A future `/cdc/v1/stream` SSE endpoint translates `LogEntry` into
a Debezium-style envelope.

```json
{
  "op": "u",
  "ts_ms": 1747008123456,
  "source": {
    "system": "baerly",
    "bucket": "<bucket>",
    "current_json_key": "<collection-prefix>/current.json",
    "collection": "users",
    "lsn": "0abcdef12_a1b2c3_0123456789a"
  },
  "before": { "_id": "u_42", "email": "old@x" },
  "after": { "_id": "u_42", "email": "new@x", "name": "Alice" }
}
```

Mapping at the SSE adapter:

- `I` → `op:c`, `before: null`, `after: <LogEntry.after>`.
- `U` → `op:u`, `before: <LogEntry.before> || null`, `after: <LogEntry.after>`.
- `D` → `op:d`, `before: <LogEntry.before> || <LogEntry.key_old>`, `after: null`.

## Failure semantics

`current.json` is not the commit pointer for new writes. A write
commits when `log/<seq>.json` is created with `If-None-Match: "*"`;
there is no separate `current.json` CAS on the commit path. An entry
is committed the moment its create wins (`200`), not when any
`next_seq`-style pointer advances.

A direct bucket consumer reads `current.json` for the snapshot pointer
and the `tail_hint` floor, folds the trusted range
`[log_seq_start, tail_hint)`, then forward-probes
from `max(log_seq_start, tail_hint)` — normally `tail_hint` — and stops
at the first 404 (the true tail). Listing the `log/` prefix is still
not a commit-discovery protocol.

On the kernel read/fold path, if a consumer GETs an in-range
`log/<seq>.json` inside the trusted `[log_seq_start, tail_hint)` range
and receives 404, that is a protocol invariant violation; the kernel
surfaces it as an error rather than silently skipping the entry. The
`/v1/since` consumer route is narrower: when serving a cursor boundary,
it tolerates a missing in-range entry by skipping it, since the GC
sweeper may have already deleted a log object that has been folded
into the snapshot.

## Stability

- **After the first production consumer, the keys above never change.**
  Renaming a field, repurposing a value, or removing a field is a
  major-version migration.
- **New optional fields can be added at any time.** The `LogEntry`
  type is `interface` (open under structural typing). Consumers
  must ignore unknown keys.
- **`op` is a closed union; widening it is a major-version
  migration.** Today's emitter produces only `I` / `U` / `D`.
  `LogEntry.op` is typed as that closed set so consumers can switch
  exhaustively. New `op` values come with an envelope mapping and a
  wire-version bump together; never silently.
- **`after` is always a complete post-image.** No TOAST-elision,
  no "unchanged-field" markers, no per-field absence-vs-null
  ambiguity. For SQL export targets, a projected table column absent
  from `after` is emitted as SQL `NULL`; JSON document consumers still
  see ordinary JSON absence. Consumers writing tabular sinks never need
  to compare against pre-images to determine which columns to write. If
  partial-merge writes ever return, they would ship as a future op
  letter or behind a wire-version bump — never by reinterpreting
  `after`.

See also:

- The cursor format invariant (`<base32-time>_<session>_<seq>`)
  lives in [`sync-protocol.md`](sync-protocol.md)
  ("LSNs, wall clocks, and downstream consumers").
- The merge-patch math (RFC 7386, the `merge` / `fold` / `diff`
  triple) is in
  [`json-merge-patch.md`](json-merge-patch.md).
