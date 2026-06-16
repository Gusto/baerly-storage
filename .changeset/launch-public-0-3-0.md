---
"@gusto/baerly-storage": minor
---

First public release. `baerly-storage` is a vendorless document database that
runs over any S3-compatible bucket — the data lives in your bucket and there is
no runtime to operate. Commit is one conditional log append (`If-None-Match`)
per collection, so each collection is linearizable; compaction and GC run
in-band on writes (reads never tick); no operator cron or sidecar. First-class
on Cloudflare Workers (R2) and self-hosted Node (S3), with day-one templates for
both.

Versions `0.1.x`–`0.2.0` were internal/experimental builds. They remain
published, but this is the first release intended for outside use. **Still
pre-1.0:** the on-disk format and public API may change between minor versions
until 1.0 — pin your version.

**New here? You're done — everything above is what you get.** The rest is for
the few of you who ran an internal `0.1`–`0.2` build and need to know what
changed since `0.2.0`. Reach out and I'll help you migrate.

**Migrating from an internal build**

- **Cheaper commits, and a breaking on-disk format (schema v3).** A write now
  costs 2 Class-A PUTs instead of 3 — appending the numbered `log/<seq>` entry
  _is_ the commit, so there is no separate `current.json` write. `current.json`
  becomes compactor-owned compaction state (`next_seq` → `tail_hint`,
  `+mean_entry_bytes`, `−tail_bytes`), and readers discover the true tail by
  forward-probe. **Buckets written under schema v2 are rejected with no
  migration path** — re-create the bucket (or `admin dump` on a v2 build →
  `admin restore` on this one). See ADR-008.
- **`Db.transaction` removed — the document is the atomic unit.** Single-document
  writes are each atomic; there is no batch. Replace
  `db.transaction(name, tx => { tx.update(a); tx.update(b) })` with individual
  `db.collection(name).update(...)` calls. The both-or-neither guarantee is
  gone; model a single document as your consistency boundary. Re-adding
  transactions later is additive (ADR-002).
- **Tighter key-segment validation.** One shared rule validates every
  caller-controlled segment (`_id`, `collection`, `app`, `tenant`), rejecting
  empty / `/` / `.` / `..` / control chars / reserved leading `_` / over-length
  as `InvalidConfig`. The per-segment byte cap drops 1024 → 256 (an existing
  `_id` of 257–1024 bytes can no longer be read-modified), and over-long
  assembled keys now fail early as `InvalidConfig` instead of an opaque provider
  `KeyTooLong`. HTTP (`/v1/since`) and the `baerly admin` CLI route through the
  same rule.

**Fixed**

- **The change feed no longer dies after 1024 writes to a collection.** The
  `/v1/since` cursor's sequence segment was 10-bit (`0..1023`); the 1025th write
  produced an invalid cursor the server then rejected with a `400`, permanently
  killing the feed. It is now 53-bit from a single source of truth.
- **Concurrent create-if-absent has exactly one winner.** `LocalFsStorage` now
  uses an atomic `link(2)` exclusive create (was a TOCTOU read-then-write that
  could admit two winners and split-brain the commit path), and
  `baerly doctor --bucket` gains an `ifNoneMatch-concurrent` linearizability
  check. The property is asserted for every shipped adapter by the conformance
  suite.
- **Adapter error contract + CVE floor.** Terminal socket failures from
  `S3HttpStorage` now surface as `BaerlyError{code:"NetworkError"}` instead of
  raw `fetch` throws; the `fast-xml-parser` floor is raised past the disclosed
  entity/numeric-reference advisories (bundle byte-neutral); and
  schema-mismatch errors now name the required version and prescribe recovery.
- **GC stays bounded under backlog and concurrency.** The live-content-hash
  scan now walks the log in bounded chunks (was an unbounded `Promise.all` that
  could exceed Cloudflare's subrequest cap on a backlogged tail), and
  `gc/pending.json` is merged under CAS with bounded retry so a concurrent GC
  pass can no longer silently lose candidate marks.
- **Scaffolded Node + Docker apps boot.** The `--with=docker --target=node`
  template now copies `baerly.config.ts` into the runtime image (the server
  entrypoint imports it), so the container no longer crashes on an
  unresolved-import error at startup.
