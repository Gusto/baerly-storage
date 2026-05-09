# 0005 — Client-only architecture (no server)

## Status

Superseded by [ADR-0006: Server component](0006-server-component.md).

## Context

The natural design for a "multiplayer document database" is a
client-server one: clients connect to a sync server, the server
arbitrates writes, and the persistence layer (S3 or otherwise) is an
implementation detail.

That's not what MPS3 is. MPS3 is a clientside-only library: clients
connect *directly* to S3-compatible storage and use the storage itself
as the coordination substrate.

## Decision

The manifest log stored in S3 *is* the protocol. Clients write
manifest entries with shapes `<base32-time>_<session>_<seq>`; readers
poll the log, respect lexicographic order, and resolve causal
consistency from the timestamps + session IDs alone. There is no
sync server.

Rationale and theory live in
[`docs/sync_protocol.md`](../sync_protocol.md) and
[`docs/causal_consistency_checking.md`](../causal_consistency_checking.md).

## Consequences

- **Vendorless.** Anyone with S3-compatible storage (own bucket,
  Backblaze, R2, Minio, etc.) can run MPS3 — no separate service to
  operate. This is the thesis.
- **Operational footprint = the bucket.** No control plane, no
  scheduler, no health checks. Outages are S3 outages.
- **Polling, not push.** No server means no fan-out push channel.
  Subscribers poll the manifest log, paying read cost in proportion to
  poll frequency. The cost/latency trade-off is captured in
  `LAG_WINDOW_MILLIS` and the polling cadence in
  [`src/manifest.ts`](../../src/manifest.ts).
- **Causal consistency is enforced by clients.** Each client implements
  the full validation logic (timestamp window, manifest-key parsing,
  conflict resolution). A misbehaving client can write garbage
  manifests; well-behaved clients ignore them via `Syncer.isValid`.
- **No auth layer of our own.** Auth is whatever the bucket provides
  (signed URLs, IAM, anonymous public-read for demos).
- The randomized property tests in
  [`tests/integration/randomized.test.ts`](../../tests/integration/randomized.test.ts)
  and the consistency checker in
  [`tests/unit/consistency.test.ts`](../../tests/unit/consistency.test.ts)
  exist precisely because the protocol can't be enforced server-side.

If we ever need server-side enforcement (e.g. for write authorization
at fine grain), it's a new architecture, not an extension. Open a new
ADR.
