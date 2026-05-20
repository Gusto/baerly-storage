# Followups: pre-launch tightening

**Branch: `cleanup-tightening`.** Goal: kill genuine duplication
without adding kernel deps.

User asked about zod adoption. Verified outcome: zod is already
plugged in for users via the StandardSchemaV1 adapter at
`packages/server/src/schema.ts:39-51`. The kernel is intentionally
schema-library-agnostic; bundling zod kernel-side would push past
the thesis's "~100 KB gzipped" positioning claim.

Originally scoped four extractions. T1 (CLI `errorToExitCode`
helper) dropped after main churned 26 commits during this branch —
the consolidation already shipped via `defineBaerlySubcommand`
(`packages/cli/src/subcommand.ts:115-124`). T2-T4 still apply
cleanly on the new main.

---

## Tickets

### Ticket 2 — JSON byte helpers in `@baerly/protocol`

**Verified by grep on new main:** 12 sites of
`new TextEncoder().encode(JSON.stringify(...))` and 9 sites of
`JSON.parse(new TextDecoder().decode(...))` in production code.
`packages/protocol/src/coordination/gc-pending.ts` already has a
local `encodeJson` helper — we generalize.

**Change:** Two exports on `@baerly/protocol`'s barrel:
- `encodeJsonBytes(value: unknown): Uint8Array`
- `decodeJsonBytes<T = unknown>(bytes: Uint8Array): T`

**Not** re-exported from the kernel barrel — these are internal-shape
helpers.

### Ticket 3 — Router shape + `?where=` helpers

**File:** `packages/server/src/http/router.ts`

- L162, L181, L202 — three near-identical body-shape checks (POST
  `doc` / PATCH `patch` / PUT `doc`).
- L135, L258 — two near-identical `?where=` JSON parse blocks.

**Change:** `assertJsonBodyField(body, field)` + `parseWhereParam(c)`.

### Ticket 4 — `db.ts` name-segment guard

**File:** `packages/server/src/db.ts`

- L313 (Db.create, empty-check for app + tenant)
- L319 (Db.create, `/`-check for app + tenant)
- L387 (tableReadContext, name)
- L456 (transaction, table)

**Change:** Private `assertKeySegment(value, role, verb)` helper.
4 sites, per-field error messages (DX win — names which field
failed instead of concatenating both).

---

## Dropped — already shipped via different mechanism

### Ticket 1 — CLI `errorToExitCode` extraction

Main now has `defineBaerlySubcommand`
(`packages/cli/src/subcommand.ts:115-124`) centralizing the
exact same `{InvalidConfig→1, Conflict|Internal|InvalidResponse→3,
else→2}` mapping. The 12 verbs that previously held local defs
now route through the framework wrapper instead. Five files still
have local defs (admin/copy, deploy, dev, init, subcommand itself),
but those are heterogeneous: deploy/dev/init don't fit the standard
verb shape; admin/copy hasn't migrated yet; subcommand is the
framework. Extracting them into one helper would land back at
roughly the current state. Drop.

---

## Explicitly deferred / rejected (under pre-launch lens)

- **Bundling zod (or valibot/arktype) in the kernel.** Already
  supported for users via StandardSchemaV1. Bundling kernel-side
  would push past the "~100 KB gzipped" thesis claim. Users
  already have it.
- **Refactoring `packages/protocol/src/query/validate.ts`.** Per-
  node error messages are worded for caller mental models —
  collapsing them into a generic helper hurts DX more than it
  helps SLOC.
- **Collapsing the three `validateOrThrow` calls in `query.ts`.**
  Each sits next to verb-local invariants (collision check,
  cardinality, tx buffering) that don't generalize. Net wash.
- **Swapping the index-key base-32 encoder for a 3p lib.** No 3p
  lib does lex-order-preserving mixed-type encoding.
- **Replacing JSON merge-patch (`packages/protocol/src/json.ts`)
  with `json-merge-patch`.** Local impl has a load-bearing
  `FORBIDDEN_MERGE_KEYS` guard.

Note: `jose` for JWT verification was rejected in the original
plan ("bundle hit larger than the LoC win") but shipped on main
during this branch's runway (`917dcbd` 2026-05-20) — bearer-jwt
went from 444 → ~80 LoC. auth.js bundle grew 34 → 53 KiB raw.
Net SLOC win was deemed worth the budget bump.

---

## Status

- [x] Ticket 1 — DROPPED (shipped via defineBaerlySubcommand)
- [x] Ticket 2 — JSON byte helpers
- [ ] Ticket 3 — Router helpers
- [ ] Ticket 4 — db.ts name-segment guard
- [ ] Stage-2 review + merge
