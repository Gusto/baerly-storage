---
title: LogEntry wire shape
audience: spec
summary: "Debezium-style JSON CDC envelope (pgoutput message-tag vocabulary) LogEntry; the CDC wire contract (pre-launch: may still narrow)."
last-reviewed: 2026-05-28
tags: [protocol, log, cdc, contract]
related: [sync-protocol.md]
---

# Log entry shape

Every successful manifest write emits one JSON `LogEntry` per
mutated ref under `<manifest-prefix>/log/<lsn>.json`. This page is
the contract behind that emission: the field set, the field
semantics, what we borrowed from Postgres logical replication,
what we deliberately did not, and the stability rules for
future change.

**Pre-launch (today): the shape may still narrow.** No external
consumers exist; we may rename, remove, or repurpose fields to
honestly reflect what the writer emits today. Once the first
production consumer ships, the shape is fixed: consumers ack on
`lsn`, the JSON keys become public, and renaming, removing, or
repurposing a field becomes a major-version migration. New
optional fields can be added at any time, pre- or post-launch.

The canonical TypeScript definition lives in
[`packages/protocol/src/log.ts`](../packages/protocol/src/log.ts).
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
  against. Not byte-compatible with pgoutput, not exactly
  Debezium's source-connector envelope either — borrows the field
  vocabulary from both and drops the framing and machinery that
  doesn't apply to an append-only object-store log. **Chosen.**

The export tool is a few hundred lines, not a feature team. CDC
consumers can read the log directly and acknowledge progress on
the opaque `lsn` string carried by each entry.

## The shape

```ts
export interface LogEntry {
  lsn: string;                          // <base32-time>_<session>_<seq>
  commit_ts: string;                    // ISO-8601 ms
  op: "I" | "U" | "D";
  collection: string;
  doc_id?: string;                      // I/U/D
  after?: DocumentData;          // I/U
  before?: DocumentData;         // when replica_identity = FULL
  key_old?: { readonly [pk: string]: JSONValue };
  origin?: string;
  session: string;
  seq: number;
}
```

Field-level prose contract is in the JSDoc on
[`log.ts`](../packages/protocol/src/log.ts) and rendered by IDE
hover.

### Field requirement matrix

| Field            | I | U | D | Notes |
|------------------|---|---|---|-------|
| `lsn`            | ✓ | ✓ | ✓ | Always present. |
| `commit_ts`      | ✓ | ✓ | ✓ | ISO-8601 ms. |
| `op`             | ✓ | ✓ | ✓ | One ASCII char. |
| `collection`     | ✓ | ✓ | ✓ | First segment of `ref.key`, fallback `ref.bucket`. |
| `doc_id`         | ✓ | ✓ | ✓ | Equals `ref.key`. |
| `after`          | ✓ | ✓ |   | Post-image (Debezium's `after`). |
| `before`         |   | ✓ | ✓ | Iff `replica_identity === "FULL"` (Debezium's `before`). |
| `key_old`        |   | ✓ | ✓ | When `replica_identity !== "PATCH_ONLY"`. |
| `origin`         | ? | ? | ? | Optional ORIGIN analogue. |
| `session`        | ✓ | ✓ | ✓ | Embedded in `lsn`; surfaced for dedupe. |
| `seq`            | ✓ | ✓ | ✓ | Embedded in `lsn`; surfaced for ordering. |

## Storage layout

Every emitted entry lands at:

```
<bucket>/<manifest-prefix>/log/<lsn>.json
```

Per-LSN entries (rather than a batched object per manifest) keep
each entry independently fetchable so compaction can rewrite or
sweep them without touching the manifest log itself.
The cost is one extra PUT per mutated ref; the benefit is "GET
log/<lsn>.json" works for SSE long-poll on a single cursor.

### Content body layout

Document bodies land at:

```
<bucket>/<manifest-prefix>/content/<hash>.json
```

where `<hash>` is the **first 32 hex chars (128 bits) of `sha256(body)`**,
lowercase. The truncation is intentional: 128 bits matches the
information content of a v4 UUID and gives a collision probability of
~3 × 10⁻²⁰ at N=10⁹ writes — comfortably below any plausible per-bucket
write volume. External consumers reproducing keys MUST truncate to 32
hex chars; hashing to the full 64-char SHA-256 will not match the key
on the bucket.

**`body` is the exact bytes of `encodeJsonBytes(value)` —
`JSON.stringify(value)` UTF-8-encoded, with NO replacer and NO key
sorting** (`packages/protocol/src/bytes.ts`). Key order is therefore
**insertion-order**, exactly as the writer's in-memory object presents
it. This is *not* the canonical (ASCII-lex-sorted) encoding that
`baerly admin dump` uses for byte-stable backups — content hashing is
deliberately not canonicalized.

Same body **bytes** ⇒ same content key. The scope of this guarantee is
**single-writer idempotent replay**: a crash-recovery rewrite of the
same in-memory value by the same writer reproduces the same content key
the manifest already referenced (the `ifNoneMatch: "*"` content PUT then
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
  [`packages/protocol/src/types.ts`](../packages/protocol/src/types.ts).)
- **`<session>`** is a 6-char hex prefix of a UUID, unique per
  `Syncer` instance.
- **`<seq>`** is a 2-char base-32 descending counter
  (`countKey(this.writes++)`), monotonic per session.

**Lex order is reverse-causal**, inherited from Baerly's manifest
log encoding. Consumers walking the log via `ListObjectsV2 +
StartAfter` get newer entries lex-FIRST and must walk the response
in REVERSE for causal order — the same trick the read path uses
when folding `[log_seq_start, next_seq)` into a live row set
([`packages/server/src/query.ts`](../packages/server/src/query.ts),
the replay loop). Within a single session, `seq` ascends in causal
order; consumers can sort by `seq` to recover ordering without
reaching for list semantics.

Within a single `Writer.commitBatch` over N inputs, N lsns
are minted — one per `LogEntry`. The single-mutation
`Writer.commit` is the N=1 case.

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

- **`BEGIN` / `COMMIT` framing.** Baerly has no cross-collection
  transactions; each entry is its own degenerate txn. A consumer
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

The setting is wired through the collection API. Every collection
defaults to `PATCH_ONLY`. The `ReplicaIdentity` type and `before` /
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
    "manifest": "<manifest-key>",
    "collection": "users",
    "lsn": "0123456789abc_a1b_02"
  },
  "before": { "id": "u_42", "email": "old@x" },
  "after":  { "id": "u_42", "email": "new@x", "name": "Alice" }
}
```

Mapping at the SSE adapter:

- `I` → `op:c`, `before: null`, `after: <LogEntry.after>`.
- `U` → `op:u`, `before: <LogEntry.before> || null`, `after: <LogEntry.after>`.
- `D` → `op:d`, `before: <LogEntry.before> || <LogEntry.key_old>`, `after: null`.

## Failure semantics

Log entries are PUT **before** the CAS-advance of `current.json`
(with `If-None-Match: *` so a colliding `lsn` fails fast). If the
post-CAS `writer_fence.epoch` check bumps, the commit fails with
`BaerlyError{code:"Conflict"}` and the orphan log entries are
swept by GC (`packages/server/src/gc.ts`).

A consumer that's mid-`/cdc/v1/stream` may briefly observe a
manifest entry without a matching log entry. The endpoint should
classify a 404 on `log/<lsn>.json` as in-flight (within the same
grace window as orphan content) and retry once before declaring
the entry truly orphan.

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
  lives in [`docs/sync-protocol.md`](sync-protocol.md)
  ("Subtleties of the manifest key").
- The merge-patch math (RFC 7386, the `merge` / `fold` / `diff`
  triple) is in
  [`docs/json-merge-patch.md`](json-merge-patch.md).
