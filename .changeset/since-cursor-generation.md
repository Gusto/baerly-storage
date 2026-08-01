---
"@gusto/baerly-storage": patch
---

Give `/v1/since` cursors a generation discriminator, so a
`baerly admin restore --force` truncation can no longer silently gap a
long-poll stream.

A cursor's seq identifies a `log/<seq>` slot, and slots are reused.
`restore --force` reseeds `log_seq_start` to one past the highest
_surviving_ log object, which lands below the old floor whenever a
budget-bounded GC sweep has cleared the lex-first part of the old range
(the deliberate floor exemption). A pre-restore cursor then cleared the
`cursorSeq < log_seq_start` re-bootstrap check, resumed into the new
generation, and skipped every restored row beneath it — with no error.
Gapped, not broken, which a sync client cannot detect for itself.

`current.json` now carries an opaque `generation` nonce, and the cursor
handed to a client is `<generation>.<lsn>` once that nonce exists. A
collection with no generation keeps handing out a bare LSN, so the
wire-shape change is confined to collections that carry one. A
resume whose generation no longer matches is rejected with
`BaerlyError{code:"SchemaError"}` (HTTP 400). The nonce is re-minted by
the writers that _replace_ a collection (both `restore` seeds, writer
auto-provision, `ensureTable`) and carried through by the writers that
_advance_ one (the compactor's fold CAS, `claimWriter`, every
`casUpdateCurrentJson` mutator).

`generation` is an optional field on `schema_version: 3` — no schema
bump, so existing buckets keep working untouched. A manifest predating
the field and a cursor predating the composite shape both decode to a
sentinel, so a collection that was never truncated keeps resuming
normally through one uniform comparison, with no fail-open branch.

The React client now acts on the rejection instead of hot-looping on it.
`/v1/since`'s `SchemaError` marks a permanently dead cursor, but the
subscription poll loop caught every error alike and retried the same
cursor at 1 req/s forever — so the pre-existing folded-cursor rejection
left a frozen table and a background spin. It now drops the cursor and
re-bootstraps, which also repairs that older case.

Cursors are opaque on the wire and always were; no client action is
required. Custom `/v1/since` consumers should treat a `400 SchemaError`
as "back off, then restart with an empty cursor" rather than retrying.
Backing off first matters: if a server ever hands back a cursor it then
refuses — a mixed-version fleet mid-rolling-deploy is the reachable
case — re-bootstrapping without a delay turns that into a hot loop.
