# Followups: cost-model verification minor findings

Smaller items surfaced during the 2026-05-16 empirical verification of
the cost model against the helpdesk example. The headline findings —
the `POST /v1/t/:table` envelope inconsistency and the missing
`baerly admin compact --min-entries` override — got their own tickets
alongside this file. The five items below are docs gaps, naming nits,
and one DX nudge; none rise to the level of a self-contained
implementation ticket.

## 1. 401 body's `message` is uninformative

`packages/server/src/http/router.ts:222` hardcodes the 401 response
body as `{"error":{"code":"Unauthorized","message":"Unauthorized"}}`:

```ts
return jsonError(c, 401, "Unauthorized", "Unauthorized");
```

The `message` just echoes the `code` — no hint about the expected
scheme (`Authorization: Bearer <token>`), the dev token name
(`HELPDESK_SECRET`), or the env var to set. A first-time user hitting
401 has to grep `vite.config.ts` for the `secret:` literal.

Drop-in fix: change the message to `"Bearer token required in
Authorization header"`. Doesn't help an attacker (the `code` already
declares the failure mode) and saves a curious developer the grep.

The verifier itself (`packages/server/src/auth/presets/shared-secret.ts:56`)
returns `null` without an explanation string — the message has to be
minted at the router-level rejection in `router.ts:222`, not in the
verifier preset. Same point applies to `bearerJwt` and
`cloudflareAccess`: a single message change at the router covers all
three presets.

## 2. Content-address filename uses 128-bit sha256 prefix; undocumented

Content files land at
`<manifest>/content/<32-hex-char-name>.json`. The filename is the
first **32 hex chars** (= 128 bits) of `sha256(body)`, not the full
64 hex chars (256 bits). Empirically verified against
`b0461da34cc7f55fdf5e7ab2301d6d7a.json` (matches `sha256(body)[0:32]`,
where the full sha256 prefix continues
`b0461da34cc7f55fdf5e7ab2301d6d7acd2d0727a1f102cdb5781c53ce216503`).

`docs/spec/sync-protocol.md` and `docs/spec/log-entry-shape.md` both
reference `content/<sha256>.json` without specifying that it's a
128-bit truncation. A reader implementing an external content-address
verifier (e.g. a CDC consumer reproducing keys) will hash to 256 bits
by default and get the wrong key.

One-line fix in `docs/spec/log-entry-shape.md`'s "Storage layout"
section: `content/<first-32-hex-chars-of-sha256>.json` and a sentence
noting that 128 bits is the chosen collision space (matches the
content-dedup behavior observed in Probe 8 where a 3-PUT insert
landed only 2 new files because a prior content hash already
existed).

## 3. `current.json::log_seq_start` is absent pre-snapshot

Several docs treat `log_seq_start` as a current.json field:

- `docs/contributing/architecture.md:226`: "Holds `next_seq`,
  `log_seq_start`, and `writer_fence.epoch`."
- `docs/contributing/architecture.md:20`, `:92`, `:99` all reference
  `log_seq_start` as part of the manifest pointer's payload.

Empirically (worktree-verify-helpdesk-cost-model run), `current.json`
on a fresh bucket with 5+ inserts but no snapshot serializes as:

```json
{ "schema_version": 1, "snapshot": null, "next_seq": 6,
  "writer_fence": { "epoch": 0, "owner": "", "claimed_at": "" } }
```

— no `log_seq_start` key. The field is only written by
`packages/server/src/migrate.ts:226` when migrate-then-snapshot runs;
the no-snapshot path implies `log_seq_start = 0` by absence.

Two viable fixes (pre-launch posture allows either):

- **Always serialize `log_seq_start: 0` from the initial-create
  path** (in `packages/server/src/server-writer.ts` or wherever the
  empty `current.json` is minted). Uniform contract; matches the docs.
- **Update the docs** to call out that `log_seq_start` is absent in
  the no-snapshot state and defaults to `0`.

The first is the systematic fix.

## 4. `compaction.write_amplification` is misnamed

`bench/load-harness/cli.ts:115` declares the field in `RunResult`:

```ts
write_amplification: number;
```

…and `cli.ts:378` computes it as:

```ts
write_amplification: compactBytesWritten / Math.max(1, compactBytesRead),
```

That's a **compression ratio** (output / input), not a write
amplification. The verification run observed `0.516` (208 KB written
vs. 403 KB read; 899 objects collapsed into 4). Healthy number,
misleading name.

"Write amplification" in the storage literature means the ratio of
physical writes to logical writes — typically > 1 (writes are
amplified by the storage layer). A value of `0.516` for "write
amplification" reads as "compaction is writing half as much as it
should," which is wrong.

Rename to `compaction.bytes_ratio` (or `compaction.compression_ratio`).
Update `bench/README.md:167` (which lists the field as
`compaction.write_amplification`) and the JSDoc on `RunResult`.

Sweep grep target: `compaction.write_amplification` across `bench/`
and any consumer queries (the DuckDB analysis pattern in
`bench/README.md:88-110` doesn't currently project this field, so the
rename is contained).

## 5. Seed inserts bypass canonical-line emission

Working-as-designed, noted for future verification methodology.

The helpdesk's seed callback runs inside the `baerlyDev()` plugin's
`ready` promise (`packages/dev/src/vite-plugin.ts:48`) and calls
`db.table().insert()` directly via the JS API. The HTTP
router's per-request observability middleware
(`packages/server/src/http/router.ts:115-178`) only fires for
`/v1/*` requests — direct `Db` calls from server-side code have no
HTTP context to wrap, so no canonical line.

The verification plan originally proposed using the 5 seed inserts
as a calibration gate for the "3 Class A ops per logical write"
claim. That doesn't work — the calibration has to come from the
first curl POST against `/v1/t/:table`.

No code change needed unless someone explicitly wants seed activity
visible in the canonical-line stream (probably YAGNI; bucket-side
state and the `"seeded N demo tickets"` stdout line cover the visibility
need).

A note in `docs/contributing/conventions/observability.md` (the path
referenced from CLAUDE.md's "When editing X, read Y" matrix) would
help the next person who reaches for canonical lines as a
verification proxy.
