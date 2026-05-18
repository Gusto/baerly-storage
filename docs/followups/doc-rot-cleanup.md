# Doc-rot cleanup (pre-1.0)

Branch-scoped follow-up: a coherent "fix everything that lies"
sweep. All findings were verified against the codebase at
`main@2b94047` (2026-05-18). Each section is independently
executable; an agent can pick any one off and land it standalone.

**Project framing.** DX / LLM-legibility is the top priority
([thesis.md](../about/thesis.md#what-prototype-tier-storage-needs)
criterion 4). Doc rot is the most direct form of DX damage:
it teaches the next reader — human or agent — wrong things.

---

## 1. `llms.txt` describes the wrong architecture — **HIGH**

**Where:** `llms.txt:3-6` (repo root).

**Current text:**

```
Vendorless, causally consistent multiplayer document database
that runs entirely client-side over any S3-compatible storage
(S3, R2, Backblaze, Minio). No server. The client polls a
time-ordered manifest log to sync state across writers.
```

**Reality:** `Db` is server-side (`packages/server/src/db.ts`,
constructed inside an adapter listener). Clients hit HTTP via
`@baerly/client` (`packages/client/src/client.ts:22-49` —
`baseUrl` is required). There is no client-side polling of the
manifest log; the browser is a typed HTTP client.

**Why this matters.** `llms.txt` is what every Claude / Cursor /
Codex session loads first. Producing confidently broken code
from the *first* doc an agent reads burns the entire DX premise.

**Recommended action.**

- Rewrite `llms.txt` to describe the actual architecture:
  *server-side `Db` behind a Verifier (`@baerly/server`); typed
  HTTP clients (`@baerly/client`); two day-1 targets (Cloudflare
  Worker, self-hosted Node).*
- Replace the "polls a manifest log" sentence with the change-
  feed via `/v1/since?cursor=<lsn>` long-poll.
- Better: replace the doc-pointer block with a minimal zero-shot
  snippet mirroring what `create-baerly` actually scaffolds.

**Effort:** S (~30 min).

---

## 2. Stale `Syncer` class references in JSDoc — **HIGH**

**Where:** Nine sites describe constants/helpers in terms of a
`Syncer` class that no longer exists.

| Site | Reference |
|---|---|
| `packages/protocol/src/constants.ts:5` | `Syncer.isValid` |
| `packages/protocol/src/constants.ts:26` | `Syncer.getLatest` |
| `packages/protocol/src/constants.ts:50` | `Syncer.session_id` |
| `packages/protocol/src/constants.ts:94` | `Syncer.updateContent` |
| `packages/protocol/src/constants.ts:231` | `Syncer.classifyMissingContent` |
| `packages/protocol/src/log.ts:27` | `Syncer.generate_manifest_key()` |
| `packages/protocol/src/log.ts:144` | `Syncer.generate_manifest_key()` |
| `packages/server/src/server-writer.ts:27` | `Syncer.updateContent` |
| `packages/server/src/http/since.ts:46` | `Syncer.generate_manifest_key()` |

`grep -rn "class Syncer\|Syncer = " packages/` returns nothing.
The largest doc-rot vector in the kernel — and every reference
appears in IDE hover for a load-bearing protocol constant.

**Related orphan:** `MANIFEST_LIST_LOOKAHEAD_MILLIS` at
`packages/protocol/src/constants.ts:28` is exported but has zero
consumers. The JSDoc explaining it cites `Syncer.classifyMissingContent`
— a dead concept guarding a dead constant.

**Recommended action.**

- Rewrite each JSDoc block in terms of the actual call site
  (`ServerWriter`, `walkLogRange`, `runScheduledMaintenance`,
  `longPollSince`).
- Delete `MANIFEST_LIST_LOOKAHEAD_MILLIS` (the constant *and* the
  JSDoc).
- Audit each surrounding constant: if its rationale is gone, it
  goes too.

**Effort:** M (~half a day — each constant's "why" needs a
re-read against the actual invariant before rewriting).

---

## 3. `Table.where` JSDoc lies about supported operators — **HIGH**

**Where:** `packages/protocol/src/db.ts:18-21`.

**Current text:**

```
Day-one operator policy: equality + dotted-path only — no
`$or` / `$gt` / `$in` / `$regex`.
```

**Reality:** `packages/protocol/src/query/predicate.ts:55-62`
exports:

```ts
export type PredicateOp<V extends JSONArrayless> = {
  readonly $eq?: V;
  readonly $gt?: V;
  readonly $gte?: V;
  readonly $lt?: V;
  readonly $lte?: V;
  readonly $in?: readonly V[];
};
```

The validator (`validateOpNode` at `predicate.ts:172`,
`validateRangeBound` at `:269`) and the evaluator (`matchesOp`
at `:557`, `compareGT`/`compareLT` at `:574-577`) handle all six.

**Why this matters.** An LLM reading the public `.d.ts` learns
that range/membership ops are unsupported and refuses to emit
them. Day-1 zero-shot legibility (thesis criterion 4) silently
breaks.

**Recommended action.**

- Rewrite the JSDoc to enumerate the actual supported operators.
- Add `@example` blocks for `{ count: { $gte: 1 } }` and
  `{ status: { $in: ["open", "pending"] } }`.
- Mirror the same JSDoc on `Table.where` in
  `packages/protocol/src/db.ts` and any re-exporting site.

**Effort:** XS (~15 min).

---

## 4. Internal-planning leaks in JSDoc — **MEDIUM**

**Where:** 52 JSDoc references to internal planning tickets /
phase numbers / `.claude/research/...` paths across `packages/`.

`grep -rn "ticket [0-9]\|Phase [0-9]\|\.claude/research" packages/`
returns 45 ticket/phase mentions + 7 `.claude/research` paths.
Worst offenders:

- `packages/server/src/query.ts:31-32` — `@see ../../../.claude/research/planning/tickets/09-…`
- `packages/server/src/maintenance.ts:15` — same shape
- `packages/server/src/gc.ts:41` — same shape
- `packages/server/src/compactor.ts:35` — same shape
- `packages/server/src/http/since.ts:34` — same shape
- `packages/server/src/config.ts:3` — phase reference
- `packages/server/src/table.ts:11-12` — ticket reference
- `packages/server/src/db.ts:482-486` — ticket reference
- `packages/server/src/server-writer.ts:33-34` — ticket reference

**Why this matters.** Users see these in IDE hover for the
public API. `.claude/research/planning/tickets/09-…` looks
authoritative; it's actually a closed planning doc that ships
with the kernel.

**Recommended action.**

- `grep -rln "ticket [0-9]\|Phase [0-9]\|\.claude/research" packages/`
  for the file list.
- Replace each `@see` with a pointer to a public-facing doc
  (`docs/spec/...`, `docs/adr/...`) or delete the line.
- Add an oxlint rule (or `pnpm verify` grep guard) to keep them
  out post-cleanup.

**Effort:** S (~1h).

---

## 5. Wrangler `compatibility_date` is 9–12 months stale — **LOW**

**Where:** Five files pin a stale Cloudflare compatibility date.

| File | Date | Stale by |
|---|---|---|
| `examples/minimal-cloudflare/wrangler.jsonc:8` | `2025-06-01` | ~11 months |
| `examples/helpdesk-cloudflare/wrangler.jsonc:8` | `2025-06-01` | ~11 months |
| `manual-e2e/cloudflare/wrangler.toml:7` | `2025-06-01` | ~11 months |
| `packages/cli/src/deploy/cloudflare.test.ts:18` | `2025-06-01` | ~11 months |
| `packages/cli/src/doctor/cloudflare.test.ts:12` | `2025-06-01` | ~11 months |
| `vitest.config.ts:214` (miniflare for `cloudflare-pool`) | `2025-01-01` | ~16 months |

Today is 2026-05-18.

**Recommended action.**

- Bump all six to a recent date (e.g. `2026-05-01`).
- Run `pnpm test:adapter-cloudflare` to confirm no flag-set
  regressions.
- Consider a lefthook check or a comment in the templates
  pointing maintainers to re-bump before each release.

**Effort:** XS (~10 min).

---

## 6. Phantom filenames in template READMEs — **LOW**

**Where:**

- `examples/minimal-cloudflare/README.md:143` — "The emitted
  `worker.ts` uses `sharedSecret()` for parity…" The actual entry
  is `src/server/index.ts`; no `worker.ts` exists.
- `examples/minimal-node-railway/README.md:135` — "The emitted
  `server.ts` chooses `bearerJwt()`…" Likewise — actual file is
  `src/server/index.ts` (line 142 of the same README already
  refers to it correctly).

**Recommended action.** Search-and-replace in both READMEs:
`worker.ts` → `src/server/index.ts`, `server.ts` →
`src/server/index.ts`. Also scan the other two scaffoldable
templates for similar drift.

**Effort:** XS (~10 min).

---

## 7. `examples/README.md` Run-it block is stale — **LOW**

**Where:** `examples/README.md:50` (minimal-node-railway block)
and `examples/README.md:71` (minimal-node-docker block).

Both show:

```
BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
SHARED_SECRET=... pnpm dev
```

But each template's own `package.json` declares
`"dev": "baerly dev"`, which uses `LocalFsStorage` and needs
no credentials. Each template's own README documents this
correctly. The catalog README never caught up.

**Recommended action.**

- Update both blocks to `pnpm dev` (no env-var preamble).
- Add a follow-up line clarifying that env vars are for
  `pnpm start` / prod deploy, not local dev.

**Effort:** XS (~5 min).

---

## 8. Backblaze listed as supported, no factory exists — **LOW**

**Where:** `README.md:12` claims "Tested with S3, Backblaze, R2
and self-hosted Minio." No Backblaze factory exists in
`packages/adapter-node/src/storage-factories.ts` — only
`s3Storage`, `r2Storage`, `minioStorage`, `gcsStorage`.

**Recommended action.** Two options:

- Drop the Backblaze claim from the README. Backblaze B2 is
  S3-compatible, so users *can* point `s3Storage` at it, but we
  don't ship a tested factory.
- Or add a `b2Storage` factory + a conformance run if Backblaze
  is genuinely a day-1 target (probably not — defer until a user
  asks).

GCS factory exists but isn't named in the README — fix that
asymmetry while you're in there.

**Effort:** XS (~5 min) for the README fix.

---

## 9. `examples/helpdesk/apps/` is dead post-flatten — **LOW**

**Where:** `examples/helpdesk/apps/server/` and
`examples/helpdesk/apps/web/` contain only `node_modules`. The
flatten landed (`project_scaffold_flatten_shipped.md` in memory,
tip `538742e`); the `apps/` layout is vestigial.

**Recommended action.**

- `rm -rf examples/helpdesk/apps/`.
- Coordinate with the *separate* `examples/helpdesk/.gitignore`
  follow-up (H6 in `next-batch.md`) so `apps/` doesn't get
  recreated by stray dev runs.

**Effort:** XS (~2 min, plus the verification that no script
still references the path).

---

## Status

All nine items verified against the codebase on 2026-05-18.
Ready for execution; each section stands alone.
