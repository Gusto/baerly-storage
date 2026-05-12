# Log entry shape

Every successful manifest write emits one JSON `LogEntry` per
mutated ref under `<manifest-prefix>/log/<lsn>.json`. This page is
the contract behind that emission: the field set, the field
semantics, what we borrowed from Postgres logical replication,
what we deliberately did not, and the stability rules for
future change.

**This shape is fixed at merge.** Consumers ack on `lsn`; the JSON
keys are public. Renaming, removing, or repurposing a field is a
major-version migration. New optional fields can be added at any
time.

The canonical TypeScript definition lives in
[`packages/protocol/src/log.ts`](../packages/protocol/src/log.ts).
Every emitted entry conforms to that interface.

## Why we emit it

`baerly export --target=postgres` (Phase 9) walks these entries in
causal order and replays them as Postgres `INSERT` / `UPDATE` /
`DELETE` statements. A future `/cdc/v1/stream?since=<lsn>` SSE
endpoint (Phase 6 / 7) translates each entry into a Debezium-style
envelope on the wire. Both consumers ack against `lsn`; both rely
on the field set being stable.

## The shape

```ts
export interface LogEntry {
  lsn: string;                          // <base32-time>_<session>_<seq>
  commit_ts: string;                    // ISO-8601 ms
  op: "I" | "U" | "D" | "T" | "M";
  collection: string;
  doc_id?: string;                      // I/U/D
  schema_version: number;
  new?: JSONArraylessObject;            // I/U
  patch?: JSONArraylessObject;          // I/U; equals `new` today
  old?: JSONArraylessObject;            // when replica_identity = FULL
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

| Field            | I | U | D | T | M | Notes |
|------------------|---|---|---|---|---|-------|
| `lsn`            | ✓ | ✓ | ✓ | ✓ | ✓ | Always present. |
| `commit_ts`      | ✓ | ✓ | ✓ | ✓ | ✓ | ISO-8601 ms. |
| `op`             | ✓ | ✓ | ✓ | ✓ | ✓ | One ASCII char. |
| `collection`     | ✓ | ✓ | ✓ | ✓ | ✓ | First segment of `ref.key`, fallback `ref.bucket`. |
| `doc_id`         | ✓ | ✓ | ✓ |   |   | Equals `ref.key`. |
| `schema_version` | ✓ | ✓ | ✓ | ✓ | ✓ | Always `0` until Phase 4. |
| `new`            | ✓ | ✓ |   |   |   | Post-image. |
| `patch`          | ✓ | ✓ |   |   |   | RFC 7386 patch; equals `new` today. |
| `old`            |   | ✓ | ✓ |   |   | Iff `replica_identity === "FULL"`. |
| `key_old`        |   | ✓ | ✓ |   |   | When `replica_identity !== "PATCH_ONLY"`. |
| `origin`         | ? | ? | ? | ? | ? | Optional ORIGIN analogue. |
| `session`        | ✓ | ✓ | ✓ | ✓ | ✓ | Embedded in `lsn`; surfaced for dedupe. |
| `seq`            | ✓ | ✓ | ✓ | ✓ | ✓ | Embedded in `lsn`; surfaced for ordering. |

`T` (TRUNCATE) and `M` (MESSAGE) are shape-only today — the emitter
produces only `I` / `U` / `D`. The shape is reserved for forward
compatibility.

## Storage layout

Every emitted entry lands at:

```
<bucket>/<manifest-prefix>/log/<lsn>.json
```

Per-LSN entries (rather than a batched object per manifest) keep
each entry independently fetchable and let Phase 5 compaction
rewrite or sweep them without touching the manifest log itself.
The cost is one extra PUT per mutated ref; the benefit is "GET
log/<lsn>.json" works for SSE long-poll on a single cursor.

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

Within a single `ServerWriter.commitBatch` over N inputs, N lsns
are minted — one per `LogEntry`. The single-mutation
`ServerWriter.commit` is the N=1 case.

## What we borrowed from `pgoutput`

Postgres's logical-replication output plugin (`pgoutput`) is the
shape Debezium and Postgres-native consumers already understand —
it is the de-facto CDC lingua franca, and it is the shape
`baerly export --target=postgres` mechanically translates into.
The full wire-protocol survey (`BEGIN` / `RELATION` / `INSERT` /
`UPDATE` / `DELETE` / `TRUNCATE` / `COMMIT` framing, LSN
semantics, `REPLICA IDENTITY`, slot acknowledgement) and the
case-by-case decisions for what Baerly takes and what it omits
are at
[`.claude/research/techniques/postgres-logical-replication.md`](../.claude/research/techniques/postgres-logical-replication.md).
We borrowed:

- **`I` / `U` / `D` / `T` / `M`** — the message tags. Map to
  Debezium's `op:c/u/d/t/m` envelope.
- **`new` (post-image) and `old` (pre-image, gated)** — the same
  before/after concept Debezium emits.
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
  `{ patch, new }`; no `old`, no `key_old`. Bandwidth-cheap. SQL
  consumers rebuilding before-images need to maintain a shadow
  table.
- **`FULL`.** `U` additionally carries `old` and `key_old`. ~2× log
  size on update-heavy collections; buys 1:1 logical replication
  and "previous value" answerable from the log alone.

The setting is plumbed in **Phase 4** (table API). Until that
ticket lands, every collection is `PATCH_ONLY`. The
`ReplicaIdentity` type and `old` / `key_old` fields exist now so
the shape is future-compatible.

## Consumer envelope sketch

A future `/cdc/v1/stream` SSE endpoint translates `LogEntry` into
a Debezium-style envelope. **This is informational; the endpoint
is not in this ticket.**

```json
{
  "op": "u",
  "ts_ms": 1747008123456,
  "source": {
    "system": "baerly",
    "bucket": "<bucket>",
    "manifest": "<manifest-key>",
    "collection": "users",
    "schema_version": 3,
    "lsn": "0123456789abc_a1b_02"
  },
  "before": { "id": "u_42", "email": "old@x" },
  "after":  { "id": "u_42", "email": "new@x", "name": "Alice" },
  "patch":  { "email": "new@x" }
}
```

Mapping at the SSE adapter:

- `I` → `op:c`, `before: null`, `after: new`, `patch: new`.
- `U` → `op:u`, `before: old || null`, `after: new`, `patch: patch`.
- `D` → `op:d`, `before: old || key_old`, `after: null`.
- `T` → `op:t`, no `before` / `after`.
- `M` → `op:m`, payload in `after`.

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
- **`op` discriminant values are reserved.** Adding a new `op`
  letter is a major change because consumers branch on it. New
  values must come with an envelope mapping (see above).

See also:

- The cursor format invariant (`<base32-time>_<session>_<seq>`)
  lives in [`docs/sync-protocol.md`](sync-protocol.md)
  ("Subtleties of the manifest key").
- The merge-patch math (RFC 7386, the `merge` / `fold` / `diff`
  triple) is in
  [`docs/json-merge-patch.md`](json-merge-patch.md).
