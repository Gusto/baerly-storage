---
title: LogEntry wire shape
audience: spec
summary: "Debezium-style JSON CDC envelope (pgoutput message-tag vocabulary) LogEntry; the CDC wire contract (pre-launch: may still narrow)."
last-reviewed: 2026-06-12
tags: [protocol, log, cdc, contract]
related: [sync-protocol.md]
---

# Log entry shape

Every successful commit emits one JSON `LogEntry` per mutated
document under `<collection-prefix>/log/<seq>.json`. The entry also
carries an opaque `lsn` cursor for CDC/export clients. This page is
the contract behind that emission: the field set, the field
semantics, what we borrowed from Postgres logical replication, what
we deliberately did not, and the stability rules for future change.

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

Future CDC consumers walk these entries in causal order and replay
them mechanically: a `baerly export --target=postgres` path emits
Postgres `INSERT` / `UPDATE` / `DELETE` statements; a
`/cdc/v1/stream?since=<lsn>` SSE endpoint translates each entry into
a Debezium-style envelope on the wire. Both consumers ack against
`lsn`; both rely on the field set being stable.

## Alternatives considered

Three shapes were on the table:

- **Ad-hoc JSON tailored to Baerly's internals.** Cheap to design,
  but traps the export tooling inside Baerly — anyone reading the
  log learns a Baerly-specific schema with no analog in the
  ecosystem.
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
  Postgres-CDC consumers. Append-only delivery via per-LSN JSON
  objects in S3, with an opaque `lsn` cursor consumers ack
  against. On the bucket, the entry is keyed by integer `seq`; the
  `lsn` string is the external cursor. Not byte-compatible with
  pgoutput, not exactly Debezium's source-connector envelope either
  — borrows the field vocabulary from both and drops the framing and
  machinery that doesn't apply to an append-only object-store log.
  **Chosen.**

The export tool is a few hundred lines, not a feature team. CDC
consumers can read the log directly and acknowledge progress on
the opaque `lsn` string carried by each entry.

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

Field-level prose contract is in the JSDoc on
[`log.ts`](../../packages/protocol/src/log.ts) and rendered by IDE
hover.

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

Per-seq entries (rather than one batched object per commit) keep each
entry independently fetchable so readers, compaction, and the
`/v1/since?collection=<name>&cursor=<opaque>` change-feed route can
reconstruct the committed range directly from `current.json`. The cost
is one extra PUT per mutated document; the benefit is deterministic
`GET log/<seq>.json` over the trusted range `[log_seq_start, tail_hint)`
plus a forward-probe to the true tail.

### Content body layout

Document bodies land at:

```
<bucket>/<collection-prefix>/content/<hash>.json
```

where `<hash>` is the **first 32 hex chars (128 bits) of `sha256(body)`**,
lowercase. The truncation is intentional: 128 bits matches the
information content of a v4 UUID and gives a birthday-bound collision
probability of ~1.5 × 10⁻²¹ at N=10⁹ writes (≈ N² / 2¹²⁹) — far below any
plausible per-bucket write volume. A collision is **not** detected at
runtime: two distinct bodies sharing a truncated hash alias to one
content key, so a reader folding the log would observe the wrong body for
that version. The probability bound is the only guard. External consumers
reproducing keys MUST truncate to 32 hex chars; hashing to the full
64-char SHA-256 will not match the key on the bucket.

**`body` is the exact bytes of `encodeJsonBytes(value)` —
`JSON.stringify(value)` UTF-8-encoded, with NO replacer and NO key
sorting** (`packages/protocol/src/bytes.ts`). Key order is therefore
**insertion-order**, exactly as the writer's in-memory object presents
it. This is _not_ the canonical (ASCII-lex-sorted) encoding that
`baerly admin dump` uses for byte-stable backups — content hashing is
deliberately not canonicalized.

Same body **bytes** ⇒ same content key. The scope of this guarantee is
**single-writer idempotent replay**: a crash-recovery rewrite of the
same in-memory value by the same writer reproduces the same content key
`current.json` already referenced (the `ifNoneMatch: "*"` content PUT then
no-ops). It is **NOT** a cross-writer content-dedup guarantee: two
writers serializing a logically-equal document with different key
insertion order — or a read → merge → re-serialize round-trip, since
`merge` spreads `{...target}` and key order is insertion-dependent —
produce **different** content keys for the same logical value. Storage
dedup across writers is not a claimed property; if it ever becomes one,
the hash input would first need canonicalization. Constant lives at
`VERSION_HEX_LENGTH` in `packages/protocol/src/hashing.ts`.

## Cursor format

`lsn` has shape `<base32-time>_<session>_<seq>`:

- **`<base32-time>`** is `Math.ceil(42/5) = 9` chars,
  base-32-encoded with **descending** ordering — newer epochs sort
  lex-EARLIER. (See `uint2strDesc` in
  [`packages/protocol/src/types.ts`](../../packages/protocol/src/types.ts).)
- **`<session>`** is a 6-char hex prefix of a UUID, freshly minted per
  commit batch by the stateless `Writer`.
- **`<seq>`** is a fixed-width opaque base-32 descending counter
  (`countKey(seq)`), where `seq` is the first empty log slot found by
  the writer's forward-probe from `current.json.tail_hint`
  — monotonic per collection, minted by the committing `log/<seq>`
  create, and stable across process restart (it does **not** reset per
  session). The
  exact character width is an internal encoding detail (`COUNT_BIT_WIDTH`
  in `packages/protocol/src/constants.ts`); treat the seq token as opaque
  and do not hard-code its length in consumers.

Within a single collection, `seq` ascends in causal order and is the
ordering authority. The kernel and the
`/v1/since?collection=<name>&cursor=<opaque>` change-feed route
reconstruct `log/<seq>.json` keys directly; they do not list by `lsn`
or sort by the wall-clock prefix. Consumers that already have
`LogEntry` records in hand should order by `seq`. The descending
timestamp encoding is a cursor property for external LSN-shaped
keyspaces, not a kernel
correctness dependency.

Every mutation mints exactly one `lsn` — one per `LogEntry`.
`Writer.commit` writes a single document per call.

## What we borrowed from `pgoutput`

Postgres's logical-replication output plugin (`pgoutput`) is the
shape Debezium and Postgres-native consumers already understand —
it is the de-facto CDC lingua franca, and it is the shape
`baerly export --target=postgres` mechanically translates into.
From the Postgres logical-replication wire protocol we borrowed:

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

- **`BEGIN` / `COMMIT` framing.** Baerly has no multi-document
  transactions; each entry is its own atomic unit. A consumer
  expecting atomic batch-apply on a shared `commit_lsn` would be
  confused.
- **2PC messages (`b` / `P` / `K` / `r`).** No prepared txns in S3.
- **Streaming-in-progress (`S` / `E` / `c` / `A`).** Baerly entries
  are already small (one patch on one doc).
- **`TYPE` messages.** JSON is self-describing; no `CREATE TYPE`
  analogue.
- **`REPLICA IDENTITY USING INDEX`.** PK is always `_id`; no
  multi-column unique alternative.
- **TOAST `'u'` (unchanged) elision.** Merge patches encode "didn't
  touch" via key absence — no separate sentinel needed.
- **LSN bytes.** Postgres LSNs are 64-bit byte positions and bytes
  matter. Baerly's lsn is a string already lex-monotonic; reusing
  it avoids inventing a parallel cursor.

## `replica_identity`

A per-collection setting that controls how much pre-image data
each `U` / `D` entry carries:

- **`PATCH_ONLY` (default; today's only mode).** `U` carries
  `{ after }`; no `before`, no `key_old`. Bandwidth-cheap. SQL
  consumers rebuilding before-images need to maintain a shadow
  table.
- **`FULL`.** `U` additionally carries `before` and `key_old`. ~2× log
  size on update-heavy collections; buys 1:1 logical replication
  and "previous value" answerable from the log alone.

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
    "lsn": "0123456789abc_a1b_02"
  },
  "before": { "id": "u_42", "email": "old@x" },
  "after": { "id": "u_42", "email": "new@x", "name": "Alice" }
}
```

Mapping at the SSE adapter:

- `I` → `op:c`, `before: null`, `after: <LogEntry.after>`.
- `U` → `op:u`, `before: <LogEntry.before> || null`, `after: <LogEntry.after>`.
- `D` → `op:d`, `before: <LogEntry.before> || <LogEntry.key_old>`, `after: null`.

## Failure semantics

Each log entry is created with `If-None-Match: "*"`, and **the winning
create IS the commit** — there is no separate `current.json` CAS on the
commit path. An entry is committed the moment its create wins (`200`),
not when any `next_seq`-style pointer advances. A direct bucket consumer
reads `current.json` for the snapshot pointer and the `tail_hint` floor,
folds the trusted range `[log_seq_start, tail_hint)`, then forward-probes
`GET log/<tail_hint>, log/<tail_hint+1>, …` and stops at the first 404
(the true tail). Listing the `log/` prefix is still not a commit-discovery
protocol.

On the read/fold path, if a consumer GETs an in-range `log/<seq>.json`
inside the trusted `[log_seq_start, tail_hint)` range and receives 404,
that is a protocol invariant violation; the kernel surfaces it as an
error rather than silently skipping the entry. The `/v1/since` consumer
route is the exception: it tolerates a 404 on an in-range entry by
skipping it, since the GC sweeper may have already deleted a log object
that has been folded into the snapshot.

## Stability

- **The keys above never change.** Renaming a field, repurposing
  a value, or removing a field is a major-version migration.
- **New optional fields can be added at any time.** The `LogEntry`
  type is `interface` (open under structural typing). Consumers
  must ignore unknown keys.
- **`op` is a closed union; widening it is a major-version
  migration.** Today's emitter produces only `I` / `U` / `D`, and
  `LogEntry.op` is typed as that closed set so consumers can
  switch-exhaustively and get a `never`-check failure when they
  miss one. The wire never carries values the type doesn't admit
  — adding `T` (TRUNCATE) or `M` (MESSAGE) back is a major-version
  migration of the LogEntry shape, and the major-version mechanism
  itself (likely a top-level `_v` field on each entry, opt-in by
  consumers) is a separate design decided when widening first
  becomes necessary. The alternative considered was an open string
  union (`"I" | "U" | "D" | (string & {})`) that admits arbitrary
  values silently; we rejected it because the autocomplete benefit
  was outweighed by losing exhaustive checking on the 90%-case
  translator, and because "the wire can carry values its declared
  type forbids" is bad DX for agent consumers reading the `.d.ts`
  zero-shot. New `op` values come with an envelope mapping and a
  wire-version bump together; never silently.
- **`after` is always a complete post-image.** No TOAST-elision,
  no "unchanged-field" markers, no per-field absence-vs-null
  ambiguity. A key absent from `after` is `NULL` at the target;
  consumers never need to compare against pre-images to determine
  which columns to write. Partial-merge writes (`patch` semantics,
  cut in a prior shape-narrowing series) would ship as a future
  op letter or behind a wire-version bump if they ever return —
  never by reinterpreting `after`.

See also:

- The cursor format invariant (`<base32-time>_<session>_<seq>`)
  lives in [`sync-protocol.md`](sync-protocol.md)
  ("LSNs, wall clocks, and downstream consumers").
- The merge-patch math (RFC 7386, the `merge` / `fold` / `diff`
  triple) is in
  [`json-merge-patch.md`](json-merge-patch.md).
